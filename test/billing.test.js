import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PalatialClient } from '../src/client.js';
import { createServer } from '../src/mcp.js';

const secret = 'billing-fixture-api-key';
const basic = { source: 'text', name: 'Credit bin', description: 'Rigid storage bin' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
async function fixture(t, fetchImpl) {
  const dir = await mkdtemp(path.join(tmpdir(), 'palatial-billing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, client: new PalatialClient({ apiKey: secret, fetchImpl, receiptDir: path.join(dir, 'requests') }) };
}

// Catches a client prepayment gate or a create wrapper dropping the API's
// billing warning before the caller can explain an accepted low-balance job.
test('an accepted low-balance create preserves billing and warnings in its receipt', async t => {
  const calls = [];
  const { client } = await fixture(t, async (url, init) => {
    calls.push({ path: url.pathname, method: init.method });
    return json({
      id: 'asset-credit', status: 'SUBMITTED',
      billing: {
        mode: 'postpaid_stage_v1', balance: { tokens: 0.5, planTokens: 0.5, purchasedTokens: 0, debtTokens: 0, ownerType: 'organization', ownerId: 'org-shared' },
        paused: false, pauseReason: null, stages: [{ stageKey: 'geometry', tokenCost: 10, chargedAt: null }],
        warnings: [{ code: 'low_recommended_balance', recommendedTokens: 20, balance: 0.5, message: 'The recommended balance is advisory.' }],
        futureField: { value: 1 }
      }
    }, 201);
  });
  const result = await client.create(basic);
  assert.equal(result.asset_id, 'asset-credit');
  assert.deepEqual(result.billing, {
    mode: 'postpaid_stage_v1', balance: { tokens: 0.5, planTokens: 0.5, purchasedTokens: 0, debtTokens: 0, ownerType: 'organization', ownerId: 'org-shared' },
    paused: false, pauseReason: null, stages: [{ stageKey: 'geometry', tokenCost: 10, chargedAt: null }],
    warnings: [{ code: 'low_recommended_balance', recommendedTokens: 20, balance: 0.5, message: 'The recommended balance is advisory.' }],
    futureField: { value: 1 }
  });
  assert.equal(JSON.parse(await readFile(result.receipt_file, 'utf8')).billing.balance.tokens, 0.5);
  assert.deepEqual(calls, [{ path: '/api/v1/external/assets/create/texttosim', method: 'POST' }]);
});

// Catches an unsanitized billing copy in either output or the durable receipt.
test('billing metadata removes credentials and signed URL secrets without requiring an exact shape', async t => {
  const { client } = await fixture(t, async () => json({
    id: 'asset-safe', billing: { mode: 'postpaid_stage_v1', balance: { tokens: 1 },
      extra: { apiKey: secret, authorization: 'Bearer fixture-private-token', note: `Key ${secret}`, link: 'https://user:pass@example.test/billing?signature=private-signature#private-fragment' } },
    warnings: [{ code: 'low_recommended_balance', message: `Low balance ${secret}`, recommendedTokens: 10 }]
  }, 201));
  const result = await client.create(basic);
  assert.equal(result.billing?.balance.tokens, 1);
  assert.equal(result.billing.extra.link, 'https://example.test/billing');
  assert.equal(result.warnings[0].recommendedTokens, 10);
  for (const output of [JSON.stringify(result), await readFile(result.receipt_file, 'utf8')]) {
    for (const leaked of [secret, 'fixture-private-token', 'private-signature', 'private-fragment', 'user:pass']) assert.ok(!output.includes(leaked));
  }
});

// Catches request(), create(), or MCP catch handlers losing the financial
// rejection, and catches any retry or checkout introduced on that error path.
test('MCP keeps a structured insufficient-token create rejection and actionable guidance', async t => {
  const calls = [];
  const { client: api } = await fixture(t, async (url, init) => {
    calls.push({ path: url.pathname, method: init.method });
    return json({ statusCode: 403, code: 'insufficient_tokens', reason: 'insufficient_credits', billingMode: 'postpaid_stage_v1',
      message: `Do not expose server text: ${secret}`, tokens: { balance: -0.5, apiKey: secret }, path: `?apiKey=${secret}` }, 403);
  });
  const server = createServer({ clientFactory: async () => api });
  const client = new Client({ name: 'billing-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'palatial_create_asset', arguments: basic });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.code, 'insufficient_tokens');
  assert.equal(result.structuredContent.reason, 'insufficient_credits');
  assert.equal(result.structuredContent.http_status, 403);
  assert.equal(result.structuredContent.billingMode, 'postpaid_stage_v1');
  assert.deepEqual(result.structuredContent.tokens, { balance: -0.5 });
  let textDetails;
  assert.doesNotThrow(() => { textDetails = JSON.parse(result.content[0].text); }, 'MCP clients reading only text must also receive the billing code and balance.');
  assert.equal(textDetails.code, 'insufficient_tokens');
  assert.deepEqual(textDetails.tokens, { balance: -0.5 });
  assert.match(result.content[0].text, /top up/i);
  assert.match(result.content[0].text, /net balance.*above zero/i);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes('Do not expose server text'));
  assert.deepEqual(calls, [{ path: '/api/v1/external/assets/create/texttosim', method: 'POST' }]);
});

test('a credit pause keeps the same asset and clears guidance when the server resumes it', async t => {
  const calls = [];
  const { client } = await fixture(t, async (url, init) => {
    calls.push({ path: url.pathname, method: init.method });
    return json(calls.length === 1
      ? { status: 'PROCESSING_PAUSED', billing: { mode: 'postpaid_stage_v1', paused: true, pauseReason: 'insufficient_credits', autoResume: true, balance: { tokens: -1 },
        stages: [{ stageKey: 'shape-generation', tokenCost: 45, chargedAt: '2026-09-24T12:00:00.000Z' }] } }
      : { status: 'PROCESSING_GEOMETRY', billing: { mode: 'postpaid_stage_v1', paused: false, pauseReason: null, balance: { tokens: 2 } } });
  });
  const paused = await client.getAsset('asset-existing');
  assert.equal(paused.status, 'PROCESSING_PAUSED');
  assert.equal(paused.billing?.paused, true);
  assert.deepEqual(paused.billing.stages, [{ stageKey: 'shape-generation', tokenCost: 45, chargedAt: '2026-09-24T12:00:00.000Z' }]);
  assert.equal(paused.billing_guidance.reason, 'insufficient_credits');
  assert.equal(paused.billing_guidance.resume_asset_id, 'asset-existing');
  assert.match(paused.billing_guidance.message, /automatically/i);
  assert.match(paused.billing_guidance.message, /same asset/i);
  const resumed = await client.getAsset('asset-existing');
  assert.equal(resumed.status, 'PROCESSING_GEOMETRY');
  assert.equal(resumed.billing_guidance, undefined);
  assert.deepEqual(calls, [
    { path: '/api/v1/external/assets/asset-existing/status', method: 'GET' },
    { path: '/api/v1/external/assets/asset-existing/status', method: 'GET' }
  ]);
});

test('a nonpositive balance does not turn an in-flight stage into a client-invented pause', async t => {
  const { client } = await fixture(t, async () => json({ status: 'PROCESSING_GEOMETRY', billing: { mode: 'postpaid_stage_v1', paused: false, balance: { tokens: -2 } } }));
  const result = await client.getAsset('asset-running');
  assert.equal(result.status, 'PROCESSING_GEOMETRY');
  assert.equal(result.billing?.balance.tokens, -2);
  assert.equal(result.billing_guidance, undefined);
});

test('a continuation credit conflict keeps the reported code and balance without retrying', async t => {
  let calls = 0;
  const { client } = await fixture(t, async () => {
    calls++;
    return json({ statusCode: 409, code: 'insufficient_credits', reason: 'insufficient_credits', billingMode: 'postpaid_stage_v1', tokens: { balance: 0 } }, 409);
  });
  await assert.rejects(client.reprocess('asset-existing', { from: 'geometry' }), error => {
    assert.equal(error.code, 'insufficient_credits');
    assert.equal(error.http_status, 409);
    assert.deepEqual(error.tokens, { balance: 0 });
    assert.match(error.message, /same asset/i);
    return true;
  });
  assert.equal(calls, 1);
});

test('legacy prepaid credit rejection preserves the full-price shortfall without promising automatic resume', async t => {
  const { client } = await fixture(t, async () => json({ code: 'insufficient_tokens',
    tokens: { balance: 37, required: 37.5, shortfall: 0.5, secret } }, 403));
  await assert.rejects(client.create(basic), error => {
    assert.deepEqual(error.tokens, { balance: 37, required: 37.5, shortfall: 0.5 });
    assert.doesNotMatch(error.message, /resumes automatically|above zero/i);
    assert.match(error.message, /required|requirement/i);
    assert.equal(error.billing_guidance.reason, 'insufficient_tokens');
    assert.ok(!JSON.stringify(error).includes(secret));
    return true;
  });
});

test('an export credit rejection survives cleanup and never claims an export charge', async t => {
  const calls = [];
  const { dir, client } = await fixture(t, async url => {
    calls.push(url.pathname);
    if (url.pathname.endsWith('/status')) return json({ status: 'READY' });
    return json({ code: 'insufficient_tokens', reason: 'insufficient_credits', billingMode: 'postpaid_stage_v1', tokens: { balance: 0 } }, 403);
  });
  await assert.rejects(client.download('asset-export', dir), error => {
    assert.equal(error.code, 'insufficient_tokens');
    assert.deepEqual(error.tokens, { balance: 0 });
    assert.match(error.message, /top up/i);
    assert.doesNotMatch(error.message, /credit.*consumed|charged.*export/i);
    return true;
  });
  await assert.rejects(stat(path.join(dir, 'asset-export-export.zip')), { code: 'ENOENT' });
  assert.deepEqual(calls, ['/api/v1/external/assets/asset-export/status', '/api/v1/external/assets/asset-export/media/export']);
});

test('a previously exported READY asset can download at zero or negative balance', async t => {
  const zip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
  for (const balance of [0, -2]) {
    const calls = [];
    const { dir, client } = await fixture(t, async url => {
      calls.push(url.pathname);
      return url.pathname.endsWith('/status')
        ? json({ status: 'READY', billing: { mode: 'postpaid_stage_v1', balance: { tokens: balance } } })
        : new Response(zip, { headers: { 'Content-Type': 'application/zip' } });
    });
    const result = await client.download('asset-previous-export', dir);
    assert.equal(result.cached, false);
    assert.equal(result.bytes, 22);
    assert.equal(calls.length, 2);
  }
});

test('a paused later run can download its existing export without being regenerated', async t => {
  const calls = [];
  const zip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
  const { dir, client } = await fixture(t, async (url, init) => {
    calls.push({ path: url.pathname, method: init.method });
    return url.pathname.endsWith('/status')
      ? json({ status: 'PROCESSING_PAUSED', export: { status: 'READY', key: 'existing-export.zip' }, billing: { paused: true, pauseReason: 'insufficient_credits', balance: { tokens: -1 } } })
      : new Response(zip, { headers: { 'Content-Type': 'application/zip' } });
  });
  const result = await client.download('asset-previous-export', dir);
  assert.equal(result.source_status, 'PROCESSING_PAUSED');
  assert.deepEqual(calls, [
    { path: '/api/v1/external/assets/asset-previous-export/status', method: 'GET' },
    { path: '/api/v1/external/assets/asset-previous-export/media/export', method: 'GET' }
  ]);
});

test('a paused job without an existing export gives top-up guidance without requesting an export', async t => {
  let calls = 0;
  const { dir, client } = await fixture(t, async () => {
    calls++;
    return json({ status: 'PROCESSING_PAUSED', export: { status: 'NOT_STARTED' }, billing: { paused: true, pauseReason: 'insufficient_credits', balance: { tokens: 0 } } });
  });
  await assert.rejects(client.download('asset-paused', dir), /top up/i);
  assert.equal(calls, 1);
});

test('legacy creates and unknown forbidden responses retain their fallback behavior', async t => {
  const { client } = await fixture(t, async (_url, init) => init.method === 'POST'
    ? json({ id: 'asset-legacy' }, 201)
    : json({ message: `Raw server error ${secret}`, unrelated: { billingMode: 'not-a-contract' } }, 403));
  const result = await client.create(basic);
  assert.equal(result.status, 'SUBMITTED');
  assert.equal(result.billing, undefined);
  await assert.rejects(client.getAsset('asset-legacy'), error => {
    assert.match(error.message, /Access denied or insufficient credits.*403/);
    assert.equal(error.billing, undefined);
    assert.ok(!error.message.includes(secret));
    return true;
  });
});

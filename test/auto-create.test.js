import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { autoCreateSchema } from '../src/auto-create.js';
import { PalatialClient, PalatialApiError } from '../src/client.js';
import { createServer } from '../src/mcp.js';
import { readGuide } from '../src/guide.js';

const requestId = '97aa90d4-8b58-40c3-a0d0-142c30563f39';
const selection = { mode: 'parametric', effort: 'low', settings: { name: 'Storage bin', description: 'A rigid storage bin', mode: 'parametric', effort: 'low', engine: ['isaac_sim'], parameters: { articulation: false, face_budget: 100000 } }, reason: 'The input specifies simple geometry with exact dimensions.' };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
async function directory(t) { const dir = await mkdtemp(path.join(tmpdir(), 'palatial-auto-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function api(fetchImpl, receiptDir) { return new PalatialClient({ apiKey: 'test-key', baseUrl: 'https://dev.example/api/v1/external/', fetchImpl, receiptDir }); }
async function connect(t, apiClient) {
  const server = createServer({ clientFactory: async () => apiClient });
  const client = new Client({ name: 'auto-contract', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('automatic input accepts text, media and goals without mode or settings', () => {
  for (const input of [{ description: 'A cabinet' }, { file_paths: ['/cabinet.step'] }, { source_urls: ['https://media.example/photo.png'] }]) assert.equal(autoCreateSchema.safeParse(input).success, true);
  for (const extra of [{ mode: 'diffusion' }, { parameters: {} }, { effort: 'low' }, { source: 'text' }, { quality: 'cheap' }, { engine: ['other'] }, { request_id: '../unsafe' }]) assert.equal(autoCreateSchema.safeParse({ description: 'A cabinet', ...extra }).success, false);
  for (const input of [{}, { description: ' ' }, { name: 'Cabinet' }, { source_urls: ['http://media.example/photo.png'] }, { source_urls: ['https://user:password@media.example/photo.png'] }, { source_urls: ['https://media.example/photo.png#fragment'] }]) assert.equal(autoCreateSchema.safeParse(input).success, false);
});

test('CAD source-frame metadata accepts only a named axis and a finite positive unit scale', () => {
  assert.equal(autoCreateSchema.safeParse({ file_paths: ['/assembly.step'], source_up_axis: 'z' }).success, true);
  assert.equal(autoCreateSchema.safeParse({ file_paths: ['/part.obj'], source_up_axis: 'y', meters_per_unit: 0.001 }).success, true);
  for (const source_up_axis of ['auto', 'up', 'Z']) assert.equal(autoCreateSchema.safeParse({ description: 'A part', source_up_axis }).success, false);
  for (const meters_per_unit of [0, -1, Infinity, NaN, '0.001']) assert.equal(autoCreateSchema.safeParse({ description: 'A part', meters_per_unit }).success, false);
});

test('JSON automatic CAD requests forward declared source frame without selecting build settings', async t => {
  const dir = await directory(t);
  const client = api(async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { source_up_axis: 'z', meters_per_unit: 0.001, urls: ['https://media.example/part.obj'], mode: 'auto', dryRun: true });
    return response({ selection: { ...selection, mode: 'cad' }, dryRun: true });
  }, dir);
  await client.createAuto({ source_urls: ['https://media.example/part.obj'], source_up_axis: 'z', meters_per_unit: 0.001, dryRun: true });
});

test('dryRun preserves the server selection, sends no idempotency header and writes no receipt', async t => {
  const dir = await directory(t);
  let calls = 0;
  const client = api(async (url, options) => {
    calls++;
    assert.equal(url.pathname, '/api/v1/external/assets/create');
    assert.equal(options.headers['Idempotency-Key'], undefined);
    assert.deepEqual(JSON.parse(options.body), { description: 'A storage bin', quality: 'speed', engine: ['isaac_sim'], mode: 'auto', dryRun: true });
    return response({ selection, dryRun: true });
  }, dir);
  assert.deepEqual(await client.createAuto({ description: 'A storage bin', quality: 'speed', engine: ['isaac_sim'], dryRun: true, request_id: requestId }), { selection, dryRun: true });
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(dir), []);
});

test('automatic dryRun and submit use their own deadline while reads retain the configured deadline', async t => {
  const dir = await directory(t);
  const deadlines = [];
  const original = AbortSignal.timeout;
  AbortSignal.timeout = milliseconds => { deadlines.push(milliseconds); return new AbortController().signal; };
  t.after(() => { AbortSignal.timeout = original; });
  const client = new PalatialClient({ apiKey: 'test-key', timeoutMs: 1234, receiptDir: dir, fetchImpl: async (_url, options) => {
    return response(options.method === 'GET' ? { status: 'READY' } : JSON.parse(options.body).dryRun ? { selection, dryRun: true } : { id: 'asset-deadline', selection, dryRun: false });
  } });
  await client.createAuto({ description: 'A bin', dryRun: true });
  await client.createAuto({ description: 'A bin', request_id: requestId });
  await client.getAsset('asset-deadline');
  assert.deepEqual(deadlines, [180000, 180000, 1234]);
  client.autoTimeoutMs = 45000;
  await client.createAuto({ description: 'A bin', dryRun: true });
  assert.equal(deadlines.at(-1), 45000);
});

test('URL inputs are forwarded to the server without downloading them locally', async t => {
  const dir = await directory(t);
  const urls = ['https://media.example/photo.png', 'https://media.example/assembly.step'];
  const client = api(async (url, options) => {
    assert.equal(url.hostname, 'dev.example');
    assert.deepEqual(JSON.parse(options.body).urls, urls);
    assert.equal(JSON.parse(options.body).source_urls, undefined);
    return response({ selection, dryRun: true });
  }, dir);
  await client.createAuto({ source_urls: urls, dryRun: true });
});

test('local photos and CAD files share the repeated files contract with URL and goal fields', async t => {
  const dir = await directory(t);
  const files = [path.join(dir, 'photo.webp'), path.join(dir, 'assembly.obj')];
  await writeFile(files[0], 'photo'); await writeFile(files[1], 'CAD');
  const urls = ['https://media.example/side.png'];
  const client = api(async (_url, options) => {
    assert.ok(options.body instanceof FormData);
    const inputs = options.body.getAll('files');
    assert.deepEqual(inputs.map(file => file.name), ['photo.webp', 'assembly.obj']);
    assert.equal(await inputs[0].text(), 'photo');
    assert.equal(await inputs[1].text(), 'CAD');
    assert.deepEqual(options.body.getAll('engine'), ['isaac_sim', 'mujoco']);
    assert.equal(options.body.get('urls'), JSON.stringify(urls));
    assert.equal(options.body.get('dryRun'), 'true');
    assert.equal(options.body.get('request_id'), null);
    assert.equal(options.body.get('source_up_axis'), 'z');
    assert.equal(options.body.get('meters_per_unit'), '0.001');
    return response({ selection: { ...selection, mode: 'cad' }, dryRun: true });
  }, dir);
  const result = await client.createAuto({ file_paths: files, source_urls: urls, engine: ['isaac_sim', 'mujoco'], source_up_axis: 'z', meters_per_unit: 0.001, dryRun: true });
  assert.equal(result.selection.mode, 'cad');
});

test('all local inputs are validated before the request and submission receipt', async t => {
  const dir = await directory(t);
  const empty = path.join(dir, 'empty.png'); await writeFile(empty, '');
  const text = path.join(dir, 'input.txt'); await writeFile(text, 'text');
  let calls = 0;
  const client = api(async () => { calls++; }, path.join(dir, 'receipts'));
  await assert.rejects(client.createAuto({ file_paths: [empty] }), /nonempty/);
  await assert.rejects(client.createAuto({ file_paths: [text] }), /supported CAD/);
  await assert.rejects(client.createAuto({ file_paths: [path.join(dir, 'missing.png')] }), { code: 'ENOENT' });
  await assert.rejects(client.createAuto({ mode: 'diffusion', description: 'A bin' }));
  assert.equal(calls, 0);
  assert.deepEqual((await readdir(dir)).sort(), ['empty.png', 'input.txt']);
});

test('local media limits are checked before reading bytes, sending or writing a receipt', async t => {
  const dir = await directory(t);
  const files = [];
  for (let i = 0; i < 4; i++) {
    const file = path.join(dir, `large-${i}.png`);
    await writeFile(file, ''); await truncate(file, 17 * 1024 ** 2); files.push(file);
  }
  let calls = 0;
  const client = api(async () => { calls++; }, path.join(dir, 'receipts'));
  await assert.rejects(client.createAuto({ file_paths: files }), /64 MiB/);
  await truncate(files[0], 20 * 1024 ** 2 + 1);
  await assert.rejects(client.createAuto({ file_paths: [files[0]] }), /20 MiB/);
  assert.equal(calls, 0);
  assert.equal((await readdir(dir)).length, 4);
});

test('submission writes a stable request identity before sending and retains the full server response', async t => {
  const dir = await directory(t);
  const native = { id: 'asset-auto', selection, dryRun: false, billing: { mode: 'postpaid_stage_v1' }, status: { status: 'PROCESSING' }, viewerUrl: 'https://dev.example/viewer/asset-auto' };
  const client = api(async (_url, options) => {
    assert.equal(options.headers['Idempotency-Key'], requestId);
    assert.equal(options.headers['x-api-key'], 'test-key');
    const receipts = await readdir(dir);
    assert.equal(receipts.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(dir, receipts[0]), 'utf8')).request_id, requestId);
    assert.equal(JSON.parse(options.body).request_id, undefined);
    return response(native);
  }, dir);
  const result = await client.createAuto({ description: 'A bin', request_id: requestId });
  for (const [key, value] of Object.entries(native)) assert.deepEqual(result[key], value);
  assert.equal(result.asset_id, native.id);
  assert.equal(result.request_id, requestId);
  assert.equal(JSON.parse(await readFile(result.receipt_file, 'utf8')).status, 'accepted');
});

test('omitted request ID is generated once and recoverable after a lost response without automatic retry', async t => {
  const dir = await directory(t);
  let id; let calls = 0;
  const client = api(async (_url, options) => { calls++; id = options.headers['Idempotency-Key']; throw new Error('connection lost'); }, dir);
  await assert.rejects(client.createAuto({ description: 'A bin' }), error => {
    assert.equal(error.request_id, id);
    assert.match(id, /^[a-f0-9-]{36}$/);
    assert.match(error.message, new RegExp(id));
    assert.match(error.message, /same inputs/);
    return true;
  });
  assert.equal(calls, 1);
  const receipts = await readdir(dir);
  assert.equal(receipts.length, 1);
  const receipt = JSON.parse(await readFile(path.join(dir, receipts[0]), 'utf8'));
  assert.equal(receipt.request_id, id);
  assert.equal(receipt.status, 'submission_outcome_unknown');
});

test('submit rejection preserves typed error, request ID and definitive rejected receipt', async t => {
  const dir = await directory(t);
  const client = api(async () => response({ code: 'AUTO_REQUEST_CONFLICT', message: 'Inputs changed.', hint: 'Replay the original request.' }, 409), dir);
  await assert.rejects(client.createAuto({ description: 'A bin', request_id: requestId }), error => {
    assert.ok(error instanceof PalatialApiError);
    assert.equal(error.toJSON().request_id, requestId);
    assert.equal(error.toJSON().code, 'AUTO_REQUEST_CONFLICT');
    assert.ok(error.toJSON().receipt_file);
    return true;
  });
  const file = (await readdir(dir))[0];
  assert.equal(JSON.parse(await readFile(path.join(dir, file), 'utf8')).status, 'rejected');
});

test('malformed replay asset identifiers stay out of typed errors', async t => {
  const dir = await directory(t);
  const client = api(async () => response({ code: 'AUTO_REQUEST_IN_PROGRESS', message: 'Request in progress.', assetId: '../unsafe' }, 409), dir);
  await assert.rejects(client.createAuto({ description: 'A bin', request_id: requestId }), error => {
    assert.equal(error.toJSON().asset_id, undefined);
    assert.equal(error.toJSON().assetId, undefined);
    return true;
  });
});

test('compatibility recipes retain dryRun and replay while MCP overview uses unified intent', async () => {
  const overview = await readGuide('overview');
  assert.match(overview.text, /sole MCP tool `palatial_agent`/);
  assert.doesNotMatch(overview.text, /palatial_create_auto/);
  for (const topic of ['recipes']) {
    const guide = await readGuide(topic);
    assert.match(guide.text, /palatial_create_auto/);
    assert.match(guide.text, /dryRun/);
    assert.match(guide.text, /request_id/);
    assert.match(guide.text, /same|identical/);
  }
});

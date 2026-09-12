import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PalatialClient } from '../src/client.js';
import { credentialPath, getApiKey, saveApiKey, deleteApiKey } from '../src/auth.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const secret = 'unit-test-key-never-log';
const basic = { source: 'text', name: 'Test bin', description: 'Rigid storage bin' };
async function fixture(t, fetchImpl, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'palatial-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, client: new PalatialClient({ apiKey: secret, fetchImpl, receiptDir: path.join(dir, 'requests'), ...options }) };
}

test('text creation uses the documented endpoint, records the asset ID, and never polls by recreating', async t => {
  const calls = [];
  const { client } = await fixture(t, async (url, init) => {
    calls.push({ url: String(url), init });
    return init.method === 'POST' ? json({ id: 'asset-1', status: { status: 'SUBMITTED' } }, 201) : json({ status: 'READY' });
  });
  const result = await client.create(basic);
  assert.equal(result.asset_id, 'asset-1');
  assert.deepEqual(JSON.parse(calls[0].init.body).engine, ['isaac_sim']);
  assert.match(calls[0].url, /assets\/create\/texttosim$/);
  assert.equal(JSON.parse(await readFile(result.receipt_file)).asset_id, 'asset-1');
  assert.equal((await client.getAsset(result.asset_id)).status, 'READY');
  assert.equal(calls.filter(c => c.init.method === 'POST').length, 1);
});

test('configured API origin follows the created asset into its durable receipt', async t => {
  const { client } = await fixture(t, async () => json({ id: 'dev-asset' }, 201), {
    baseUrl: 'https://dashboard.dev.palatial.cloud/api/v1/external/',
  });
  const created = await client.create(basic);
  assert.equal(created.dashboard_url, 'https://dashboard.dev.palatial.cloud');
  const receipt = JSON.parse(await readFile(created.receipt_file));
  assert.equal(receipt.api_origin, 'https://dashboard.dev.palatial.cloud');
  assert.equal(receipt.dashboard_url, created.dashboard_url);
});

test('workspace enumeration establishes connectivity but does not assert create authorization', async t => {
  const { client } = await fixture(t, async () => json({ data: [{ id: 'workspace-1' }] }));
  const result = await client.doctor();
  assert.equal(result.authenticated, true);
  assert.equal(result.creation_authorization, 'not_verified');
});

test('status polling preserves processing and export phases without inferring completion', async t => {
  const record = { status: 'PROCESSING_IMPORT', progress: 84,
    processingSummary: { runId: 'run-1', currentStageKey: 'export', runStatus: 'running' },
    export: { status: 'PROCESSING' } };
  const { client } = await fixture(t, async () => json(record));
  const result = await client.getAsset('asset-1');
  assert.equal(result.status, 'PROCESSING_IMPORT');
  assert.deepEqual(result.details, record);
});

test('multiview and CAD use actual multipart files and repeated engine fields', async t => {
  const captured = [];
  const { dir, client } = await fixture(t, async (url, init) => { captured.push({ url: String(url), body: init.body }); return json({ id: 'asset-files' }, 201); });
  const image = path.join(dir, 'front.jpg');
  const mesh = path.join(dir, 'part.step');
  const datasheet = path.join(dir, 'spec.pdf');
  await writeFile(image, 'image fixture'); await writeFile(mesh, 'STEP fixture'); await writeFile(datasheet, '%PDF fixture');
  await client.create({ ...basic, source: 'image', views: { front: image, back: image }, engine: ['isaac_sim', 'mujoco'] });
  assert.equal(captured[0].body.get('front').name, 'front.jpg');
  assert.equal(captured[0].body.get('file'), null);
  assert.deepEqual(captured[0].body.getAll('engine'), ['isaac_sim', 'mujoco']);
  await client.create({ ...basic, source: 'cad', mesh_path: mesh, image_path: image, datasheet_path: datasheet, units: 'mm' });
  assert.match(captured[1].url, /cadtosim$/);
  assert.equal(await captured[1].body.get('mesh').text(), 'STEP fixture');
  assert.equal(captured[1].body.get('image').type, 'image/jpeg');
  assert.equal(captured[1].body.get('datasheet').type, 'application/pdf');
  assert.equal(captured[1].body.get('units'), 'mm');
});

test('invalid input is rejected before any remote write', async t => {
  let calls = 0;
  const { client } = await fixture(t, async () => { calls++; return json({}); });
  const inputs = [
    { ...basic, source: 'image' },
    { ...basic, source: 'image', views: { front: '/missing.jpg' } },
    { ...basic, image_path: '/missing.jpg' },
    { ...basic, source: 'cad', mesh_path: '/missing.step' },
    { ...basic, decimation_mode: 'strict' },
    { ...basic, decimation_mode: 'strict', decimation_target_faces: 200, decimation_target_ratio: 0.4 }
  ];
  for (const input of inputs) await assert.rejects(client.create(input));
  assert.equal(calls, 0);
});

test('ambiguous create failures are not retried and retain recovery evidence without secrets', async t => {
  let calls = 0;
  const { client } = await fixture(t, async () => { calls++; throw new Error(`socket closed ${secret}`); });
  await assert.rejects(client.create(basic), error => {
    assert.match(error.message, /may have accepted/);
    assert.match(error.message, /Recovery receipt/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.equal(calls, 1);
});

test('missing create ID fails explicitly without another submission', async t => {
  let calls = 0;
  const { client } = await fixture(t, async () => { calls++; return json({}, 201); });
  await assert.rejects(client.create(basic), /job may exist/);
  assert.equal(calls, 1);
});

test('export strips API credentials on storage redirect, streams ZIP, and caches by SHA-256', async t => {
  const calls = [];
  const zip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
  const { dir, client } = await fixture(t, async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/status')) return json({ status: { status: 'READY' } });
    if (String(url).endsWith('/export')) return new Response(null, { status: 307, headers: { Location: 'https://storage.example.test/file.zip?signature=secret-url' } });
    return new Response(zip, { headers: { 'Content-Type': 'application/zip' } });
  });
  const receipt = await client.download('asset-zip', dir);
  assert.equal(receipt.cached, false);
  assert.equal(receipt.validation, 'not_inspected');
  assert.equal(receipt.sha256.length, 64);
  assert.deepEqual(calls[2].init.headers, {});
  assert.equal(calls[1].init.headers['x-api-key'], secret);
  assert.equal((await client.download('asset-zip', dir)).cached, true);
  assert.equal(calls.length, 3);
  const stored = await readFile(receipt.receipt_file, 'utf8');
  assert.ok(!stored.includes('signature='));
  assert.ok(!stored.includes(secret));
});

test('export preserves existing files and does not charge for a non-READY asset', async t => {
  const calls = [];
  const { dir, client } = await fixture(t, async url => { calls.push(String(url)); return json({ status: 'PROCESSING_FAILED' }); });
  await assert.rejects(client.download('asset-x', dir), /PROCESSING_FAILED/);
  assert.equal(calls.length, 1);
  await writeFile(path.join(dir, 'asset-y-export.zip'), 'preserve me');
  await assert.rejects(client.download('asset-y', dir), /already exists/);
  assert.equal(calls.length, 1);
  assert.equal(await readFile(path.join(dir, 'asset-y-export.zip'), 'utf8'), 'preserve me');
});

test('corrupt exports are removed and never retried automatically', async t => {
  let exports = 0;
  const { dir, client } = await fixture(t, async url => {
    if (String(url).endsWith('/status')) return json({ status: 'READY' });
    exports++; return new Response('not a ZIP', { headers: { 'Content-Type': 'application/octet-stream' } });
  });
  await assert.rejects(client.download('asset-bad', dir), /not a ZIP/);
  await assert.rejects(stat(path.join(dir, 'asset-bad-export.zip')), { code: 'ENOENT' });
  assert.equal(exports, 1);
});

test('API calls forbid insecure origins and do not leak arbitrary server error bodies', async t => {
  assert.throws(() => new PalatialClient({ apiKey: secret, baseUrl: 'http://example.com' }), /HTTPS/);
  assert.throws(() => new PalatialClient({ apiKey: secret, baseUrl: 'https://user:pass@example.com' }), /credentials/);
  const { client } = await fixture(t, async () => new Response(secret, { status: 403 }));
  await assert.rejects(client.doctor(), error => { assert.ok(!error.message.includes(secret)); assert.match(error.message, /403/); return true; });
});

test('saved credentials have restricted permissions and environment keys take precedence', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'palatial-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: dir };
  await saveApiKey(secret, env);
  assert.equal(await getApiKey(env), secret);
  assert.equal(await getApiKey({ ...env, PALATIAL_API_KEY: 'override' }), 'override');
  if (process.platform !== 'win32') assert.equal((await stat(credentialPath(env))).mode & 0o777, 0o600);
  await deleteApiKey(env);
  await assert.rejects(getApiKey(env), /not authenticated/);
});

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

test('dryRun preserves the server selection, sends no idempotency header and writes no receipt', async t => {
  const dir = await directory(t);
  let calls = 0;
  const client = api(async (url, options) => {
    calls++;
    assert.equal(url.pathname, '/api/v1/external/assets/create/auto');
    assert.equal(options.headers['Idempotency-Key'], undefined);
    assert.deepEqual(JSON.parse(options.body), { description: 'A storage bin', quality: 'speed', engine: ['isaac_sim'], dryRun: true });
    return response({ selection, dryRun: true });
  }, dir);
  assert.deepEqual(await client.createAuto({ description: 'A storage bin', quality: 'speed', engine: ['isaac_sim'], dryRun: true, request_id: requestId }), { selection, dryRun: true });
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(dir), []);
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
  const files = [path.join(dir, 'photo.webp'), path.join(dir, 'assembly.step')];
  await writeFile(files[0], 'photo'); await writeFile(files[1], 'CAD');
  const urls = ['https://media.example/side.png'];
  const client = api(async (_url, options) => {
    assert.ok(options.body instanceof FormData);
    const inputs = options.body.getAll('files');
    assert.deepEqual(inputs.map(file => file.name), ['photo.webp', 'assembly.step']);
    assert.equal(await inputs[0].text(), 'photo');
    assert.equal(await inputs[1].text(), 'CAD');
    assert.deepEqual(options.body.getAll('engine'), ['isaac_sim', 'mujoco']);
    assert.equal(options.body.get('urls'), JSON.stringify(urls));
    assert.equal(options.body.get('dryRun'), 'true');
    assert.equal(options.body.get('request_id'), null);
    return response({ selection: { ...selection, mode: 'cad' }, dryRun: true });
  }, dir);
  const result = await client.createAuto({ file_paths: files, source_urls: urls, engine: ['isaac_sim', 'mujoco'], dryRun: true });
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

test('auto tool exposes typed server selection errors and correction hints', async t => {
  const dir = await directory(t);
  const client = await connect(t, api(async () => response({ code: 'AUTO_INPUT_INSUFFICIENT', message: 'Specify the object.', remedy: 'Provide a clearer photo or a description.' }, 422), dir));
  const result = await client.callTool({ name: 'palatial_create_auto', arguments: { description: 'An object', dryRun: true } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, 'AUTO_INPUT_INSUFFICIENT');
  assert.equal(result.structuredContent.remedy, 'Provide a clearer photo or a description.');
  assert.equal(result.structuredContent.http_status, 422);
  assert.deepEqual(await readdir(dir), []);
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

test('selection service failure preserves its typed code and redacts credentials and URL queries', async t => {
  const dir = await directory(t);
  const client = await connect(t, api(async () => response({ code: 'AUTO_SELECTION_UNAVAILABLE', message: 'Selection failed test-key', hint: 'Try later: https://service.example/selection?token=private', ignored: 'private' }, 503), dir));
  const result = await client.callTool({ name: 'palatial_create_auto', arguments: { description: 'A bin', dryRun: true } });
  assert.equal(result.structuredContent.code, 'AUTO_SELECTION_UNAVAILABLE');
  assert.equal(result.structuredContent.http_status, 503);
  assert.match(result.structuredContent.message, /\[REDACTED\]/);
  assert.equal(result.structuredContent.hint, 'Try later: https://service.example/selection');
  assert.equal(result.structuredContent.ignored, undefined);
  assert.ok(!JSON.stringify(result).includes('test-key'));
});

test('auto tool schema contains goals and source inputs but no generation decisions', async t => {
  const client = await connect(t, {});
  const tool = (await client.listTools()).tools.find(tool => tool.name === 'palatial_create_auto');
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.idempotentHint, false, 'Omission generates a new ID, so repeated empty-ID calls are not idempotent.');
  for (const field of ['description', 'file_paths', 'source_urls', 'request_id', 'dryRun', 'quality', 'engine']) assert.ok(tool.inputSchema.properties[field]);
  for (const field of ['mode', 'effort', 'parameters', 'shape_model', 'source']) assert.equal(tool.inputSchema.properties[field], undefined);
});

test('registered automatic MCP path submits and replays through real HTTP with one server asset', async t => {
  const dir = await directory(t);
  const calls = []; const accepted = new Map(); let assets = 0;
  const server = createHttpServer(async (req, res) => {
    assert.equal(req.url, '/api/v1/external/assets/create/auto');
    assert.equal(req.headers['x-api-key'], 'test-key');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const id = req.headers['idempotency-key'];
    calls.push({ body, id }); res.setHeader('content-type', 'application/json');
    if (body.dryRun) { assert.equal(id, undefined); res.end(JSON.stringify({ selection, dryRun: true })); return; }
    const prior = accepted.get(id);
    if (prior && prior.body !== JSON.stringify(body)) { res.statusCode = 409; res.end(JSON.stringify({ code: 'AUTO_REQUEST_CONFLICT', message: 'Changed inputs.', hint: 'Replay the original inputs.' })); return; }
    if (!prior) accepted.set(id, { body: JSON.stringify(body), result: { id: `asset-${++assets}`, selection, dryRun: false, request_id: id } });
    res.end(JSON.stringify(accepted.get(id).result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = await connect(t, new PalatialClient({ apiKey: 'test-key', baseUrl: `http://127.0.0.1:${server.address().port}/api/v1/external/`, allowHttpForTests: true, receiptDir: dir }));
  const input = { description: 'A storage bin', request_id: requestId };
  const preview = await client.callTool({ name: 'palatial_create_auto', arguments: { ...input, dryRun: true } });
  assert.equal(preview.structuredContent.dryRun, true);
  const created = await client.callTool({ name: 'palatial_create_auto', arguments: input });
  const replay = await client.callTool({ name: 'palatial_create_auto', arguments: input });
  assert.equal(created.structuredContent.asset_id, replay.structuredContent.asset_id);
  assert.deepEqual(created.structuredContent.selection, selection);
  assert.equal(created.structuredContent.request_id, requestId);
  const conflict = await client.callTool({ name: 'palatial_create_auto', arguments: { ...input, description: 'A changed bin' } });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent.code, 'AUTO_REQUEST_CONFLICT');
  assert.equal(assets, 1);
  assert.equal(calls.length, 4);
});

test('packaged overview and recipes explain automatic dryRun and idempotent recovery', async () => {
  for (const topic of ['overview', 'recipes']) {
    const guide = await readGuide(topic);
    assert.match(guide.text, /palatial_create_auto/);
    assert.match(guide.text, /dryRun/);
    assert.match(guide.text, /request_id/);
    assert.match(guide.text, /same|identical/);
  }
});

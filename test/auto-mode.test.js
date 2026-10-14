import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PalatialClient, createSchema, mcpCreateSchema, mcpCreateInput } from '../src/client.js';
import { createServer } from '../src/mcp.js';

const id = 'auto-existing-asset';
const requestId = 'auto-existing-stable-id';
const selection = { mode: 'diffusion', settings: { name: 'Ceramic Bowl', mode: 'diffusion', engine: ['isaac_sim'], parameters: { structure: 'single_object', mesh_quality: 'medium' } }, reason: 'Suitable curved geometry. Mesh quality is fixed at medium for a single object.' };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function directory(t) { const dir = await mkdtemp(path.join(tmpdir(), 'palatial-auto-mode-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function connected(t, client) {
  const server = createServer({ clientFactory: async () => client });
  const mcp = new Client({ name: 'existing-auto-mode-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await mcp.connect(b);
  t.after(async () => { await mcp.close(); await server.close(); }); return mcp;
}

test('existing create schema accepts auto for every source and makes metadata optional only there', () => {
  for (const input of [
    { source: 'text', description: 'A bowl' },
    { source: 'image', image_path: '/bowl.png' },
    { source: 'image', image_paths: ['/a.png', '/b.png'] },
    { source: 'cad', mesh_path: '/part.obj', source_up_axis: 'z', meters_per_unit: 0.001 },
    { source: 'files', files: [{ path: '/part.step' }] },
    { source: 'image', source_urls: ['https://media.example/bowl.png'] }
  ]) assert.equal(mcpCreateSchema.safeParse({ ...input, mode: 'auto', quality: 'balanced', dryRun: true }).success, true, JSON.stringify(input));
  for (const mode of ['diffusion', 'parametric', 'mad_max']) {
    assert.equal(mcpCreateSchema.safeParse({ source: 'text', mode, description: 'A bowl' }).success, false);
    assert.equal(mcpCreateSchema.safeParse({ source: 'text', mode, name: 'Test bowl' }).success, false);
  }
  assert.equal(createSchema.safeParse({ source: 'text', shape_model: 'auto', description: 'A bowl' }).success, false);
  assert.equal(mcpCreateSchema.safeParse({ source: 'text', mode: 'auto' }).success, false);
});

test('auto refuses manual settings, purpose overrides and unsupported media before any remote write', async t => {
  const dir = await directory(t); let calls = 0;
  const client = new PalatialClient({ apiKey: 'fixture', receiptDir: dir, fetchImpl: async () => { calls++; } });
  const base = { source: 'text', mode: 'auto', description: 'A ceramic bowl' };
  for (const extra of [{ parameters: {} }, { effort: 'low' }, { shape_model: 'auto' }, { product_research: 'on' }, { texture_model: 'auto' }, { collision_quality: 'medium' }, { mesh_quality: 'high' }, { video_path: '/video.mp4' }, { reference_mesh_path: '/guide.glb' }, { views: { front: '/a.png', back: '/b.png' } }, { units: 'm' }]) {
    assert.equal(createSchema.safeParse({ ...base, ...extra }).success, false);
    await assert.rejects(client.create({ ...base, ...extra }), /AUTO_INPUT_FIELD_CONFLICT/);
  }
  await assert.rejects(client.create({ source: 'files', mode: 'auto', files: [{ path: '/part.step', purpose: 'exact_geometry' }] }), /purpose/);
  assert.equal(mcpCreateSchema.safeParse({ ...base, collision_quality: 'auto' }).success, false);
  assert.equal(mcpCreateInput({ ...base, collision_quality: 'auto' }).collision_quality, 'auto', 'MCP normalization must not silently remove an auto override.');
  await assert.rejects(client.create(mcpCreateInput({ ...base, collision_quality: 'auto' })), /collision_quality/);
  assert.equal(calls, 0); assert.deepEqual(await readdir(dir), []);
});

test('automatic-only goals remain invalid on explicit and legacy requests', async t => {
  const dir = await directory(t); let calls = 0;
  const client = new PalatialClient({ apiKey: 'fixture', receiptDir: dir, fetchImpl: async () => { calls++; } });
  const base = { source: 'text', name: 'Test bowl', description: 'A ceramic bowl' };
  for (const route of [{ mode: 'diffusion' }, { shape_model: 'auto' }]) for (const goal of [{ dryRun: true }, { request_id: requestId }, { quality: 'speed' }, { source_urls: ['https://media.example/bowl.png'] }, { source_up_axis: 'y' }]) await assert.rejects(client.create({ ...base, ...route, ...goal }), /requires mode=auto/);
  assert.equal(calls, 0);
});

test('normal auto text preview and compatibility tool use the same unified JSON contract', async t => {
  const dir = await directory(t); const calls = [];
  const client = new PalatialClient({ apiKey: 'fixture', receiptDir: dir, fetchImpl: async (url, options) => { calls.push({ path: url.pathname, body: JSON.parse(options.body), key: options.headers['Idempotency-Key'] }); return reply({ selection, dryRun: true }); } });
  const goals = { description: 'A ceramic bowl', engine: ['isaac_sim'], quality: 'balanced', dryRun: true };
  const normal = await client.create({ source: 'text', mode: 'auto', ...goals });
  const compatibility = await client.createAuto(goals);
  assert.deepEqual(normal, compatibility); assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].path, '/api/v1/external/assets/create');
  assert.equal(calls[0].body.mode, 'auto'); assert.equal(calls[0].body.source, undefined); assert.equal(calls[0].key, undefined);
  assert.deepEqual(await readdir(dir), []);
});

test('normal auto photos, CAD and mixed files preserve bytes and source metadata in unified files', async t => {
  const dir = await directory(t); const photo = path.join(dir, 'bowl.png'), mesh = path.join(dir, 'part.obj');
  await writeFile(photo, 'photo fixture'); await writeFile(mesh, 'CAD fixture');
  const calls = [];
  const client = new PalatialClient({ apiKey: 'fixture', receiptDir: path.join(dir, 'receipts'), fetchImpl: async (url, options) => { calls.push({ url, options }); return reply({ selection, dryRun: true }); } });
  const requests = [
    { source: 'image', image_path: photo },
    { source: 'image', image_paths: [photo] },
    { source: 'cad', mesh_path: mesh, image_path: photo, source_up_axis: 'z', meters_per_unit: 0.001 },
    { source: 'files', files: [{ path: photo }, { path: mesh }], source_up_axis: 'z', meters_per_unit: 0.001 }
  ];
  for (const input of requests) {
    await client.create({ ...input, mode: 'auto', dryRun: true, quality: 'balanced', source_urls: ['https://media.example/extra.png'] });
    const { url, options } = calls.at(-1);
    assert.equal(url.pathname, '/api/v1/external/assets/create');
    const form = options.body; assert.ok(form instanceof FormData);
    assert.equal(form.get('mode'), 'auto'); assert.equal(form.get('source'), null);
    assert.equal(form.get('urls'), '["https://media.example/extra.png"]');
    assert.equal(await form.getAll('files')[0].text(), 'photo fixture');
    if (input.mesh_path || input.files) {
      assert.equal(await form.getAll('files')[1].text(), 'CAD fixture');
      assert.equal(form.get('source_up_axis'), 'z'); assert.equal(form.get('meters_per_unit'), '0.001');
    }
    for (const localField of ['image_path', 'image_paths', 'mesh_path', 'file_paths']) assert.equal(form.get(localField), null);
  }
});

test('normal auto submission shares stable receipt identity and preserves server selection', async t => {
  const dir = await directory(t);
  const client = new PalatialClient({ apiKey: 'fixture', receiptDir: dir, fetchImpl: async (url, options) => { assert.equal(url.pathname, '/api/v1/external/assets/create'); assert.equal(options.headers['Idempotency-Key'], requestId); assert.equal(JSON.parse(options.body).mode, 'auto'); return reply({ id, selection, dryRun: false, request_id: requestId }); } });
  const result = await client.create({ source: 'text', mode: 'auto', description: 'A bowl', request_id: requestId });
  assert.equal(result.asset_id, id); assert.deepEqual(result.selection, selection); assert.equal(result.request_id, requestId);
  assert.equal(JSON.parse(await readFile(result.receipt_file, 'utf8')).status, 'accepted');
});

test('legacy shape_model auto keeps its ordinary route and is not automatic selection', async t => {
  const dir = await directory(t); const calls = [];
  const client = new PalatialClient({ apiKey: 'fixture', receiptDir: dir, fetchImpl: async (url, options) => { calls.push({ url, options }); return reply({ id }); } });
  await client.create({ source: 'text', name: 'Legacy bowl', description: 'A bowl', shape_model: 'auto' });
  assert.ok(calls[0].url.pathname.endsWith('/assets/create/texttosim'));
  assert.equal(JSON.parse(calls[0].options.body).shape_model, 'auto');
  assert.equal(JSON.parse(calls[0].options.body).mode, undefined); assert.equal(calls[0].options.headers['Idempotency-Key'], undefined);
});

test('unified auto error preserves refusal remedies, failed asset identity and admission billing', async t => {
  const dir = await directory(t); let status = 409;
  const client = new PalatialClient({ apiKey: 'fixture', receiptDir: dir, fetchImpl: async () => status === 409 ? reply({ code: 'AUTO_SUBMISSION_FAILED', message: 'The existing request owns a failed asset.', remedy: 'Inspect its asset.', assetId: id }, 409) : reply({ code: 'insufficient_credits', billingMode: 'postpaid_stage_v1' }, 403) });
  await assert.rejects(client.create({ source: 'text', mode: 'auto', description: 'A bowl', request_id: requestId }), error => { assert.equal(error.toJSON().asset_id, id); assert.equal(error.toJSON().remedy, 'Inspect its asset.'); return true; });
  status = 403;
  await assert.rejects(client.create({ source: 'text', mode: 'auto', description: 'A bowl', request_id: requestId }), error => { assert.match(error.toJSON().billing_guidance.message, /Nothing was created/); return true; });
});

test('registered primary MCP auto creation previews and replays through the existing HTTP endpoint', async t => {
  const dir = await directory(t); const accepted = new Map(); let assets = 0; const calls = [];
  const server = createHttpServer(async (req, res) => {
    assert.equal(req.url, '/api/v1/external/assets/create'); assert.equal(req.headers['x-api-key'], 'fixture');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(body.mode, 'auto');
    const key = req.headers['idempotency-key']; calls.push({ body, key }); res.setHeader('content-type', 'application/json');
    if (body.dryRun) { assert.equal(key, undefined); res.end(JSON.stringify({ selection, dryRun: true })); return; }
    const prior = accepted.get(key);
    if (prior && prior.input !== JSON.stringify(body)) { res.statusCode = 409; res.end(JSON.stringify({ code: 'AUTO_IDEMPOTENCY_CONFLICT', message: 'Inputs differ.', remedy: 'Replay the original input.' })); return; }
    if (!prior) accepted.set(key, { input: JSON.stringify(body), result: { id: `asset-${++assets}`, selection, dryRun: false } });
    res.end(JSON.stringify(accepted.get(key).result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const client = await connected(t, new PalatialClient({ apiKey: 'fixture', receiptDir: dir, baseUrl: `http://127.0.0.1:${server.address().port}/api/v1/external/`, allowHttpForTests: true }));
  const input = { source: 'text', mode: 'auto', description: 'A ceramic bowl', engine: ['isaac_sim'], request_id: requestId };
  const call = args => client.callTool({ name: 'palatial_create_asset', arguments: args });
  assert.equal((await call({ ...input, dryRun: true })).structuredContent.dryRun, true);
  const created = await call(input); assert.notEqual(created.isError, true);
  const replay = await call(input); assert.equal(replay.structuredContent.asset_id, created.structuredContent.asset_id);
  const compatibility = await client.callTool({ name: 'palatial_create_auto', arguments: { description: input.description, engine: input.engine, request_id: requestId } });
  assert.equal(compatibility.structuredContent.asset_id, created.structuredContent.asset_id);
  const conflict = await call({ ...input, description: 'A changed bowl' });
  assert.equal(conflict.isError, true); assert.equal(conflict.structuredContent.code, 'AUTO_IDEMPOTENCY_CONFLICT');
  assert.equal(assets, 1); assert.equal(calls.length, 5);
});

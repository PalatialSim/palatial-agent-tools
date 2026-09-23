import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PalatialClient, validateCreate, createSchema } from '../src/client.js';
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

test('creation forwards documented shape and pipeline options', async t => {
  let body;
  const { client } = await fixture(t, async (_url, init) => { body = JSON.parse(init.body); return json({ id: 'asset-options' }, 201); });
  await client.create({ ...basic, shape_model: 'parametric', mesh_quality: 'high', collision_quality: 'sdf', optimize_textures: false, texture_max_resolution: 2048 });
  assert.equal(body.shape_model, 'parametric');
  assert.equal(body.mesh_quality, 'high');
  assert.equal(body.collision_quality, 'sdf');
  assert.equal(body.optimize_textures, false);
  assert.equal(body.texture_max_resolution, 2048);
});

test('parametric effort reaches text and image creates and rejects unsupported routes', async t => {
  const bodies = [];
  const { dir, client } = await fixture(t, async (_url, init) => { bodies.push(init.body); return json({ id: 'effort-asset' }, 201); });
  await client.create({ ...basic, shape_model: 'parametric', effort: 'medium' });
  assert.equal(JSON.parse(bodies[0]).effort, 'medium');
  const image = path.join(dir, 'photo.jpg');
  await writeFile(image, 'photo fixture');
  await client.create({ ...basic, source: 'image', image_path: image, shape_model: 'parametric', effort: 'mad_max' });
  assert.equal(bodies[1].get('effort'), 'mad_max');
  await client.create({ ...basic, source: 'image', image_path: image, shape_model: 'parametric', reconstruct: false });
  assert.equal(bodies[2].get('reconstruct'), 'false');
  for (const input of [
    { ...basic, effort: 'medium' },
    { ...basic, shape_model: 'diffusion', effort: 'low' },
    { ...basic, source: 'cad', mesh_path: '/part.usd', effort: 'mad_max' },
    { ...basic, reconstruct: true },
    { ...basic, source: 'image', image_path: image, shape_model: 'parametric', effort: 'medium', reconstruct: false }
  ]) assert.throws(() => validateCreate(input));
  assert.equal(bodies.length, 3);
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
  await client.create({ ...basic, source: 'cad', mesh_path: mesh, image_path: image, datasheet_path: datasheet, up_direction: 'z' });
  assert.match(captured[1].url, /cadtosim$/);
  assert.equal(await captured[1].body.get('mesh').text(), 'STEP fixture');
  assert.equal(captured[1].body.get('image').type, 'image/jpeg');
  assert.equal(captured[1].body.get('datasheet').type, 'application/pdf');
  assert.equal(captured[1].body.get('up_direction'), 'z');
  assert.equal(captured[1].body.get('units'), null);
});

test('WebP references keep their MIME type for single, multiview, parametric, and CAD creates', async t => {
  const bodies = [];
  const { dir, client } = await fixture(t, async (_url, init) => {
    bodies.push(init.body);
    return json({ id: 'webp-asset' }, 201);
  });
  const image = path.join(dir, 'reference.webp');
  const mesh = path.join(dir, 'part.step');
  await writeFile(image, 'webp fixture');
  await writeFile(mesh, 'STEP fixture');

  await client.create({ ...basic, source: 'image', image_path: image });
  await client.create({ ...basic, source: 'image', views: { front: image, back: image } });
  await client.create({ ...basic, source: 'image', image_paths: [image, image], shape_model: 'parametric' });
  await client.create({ ...basic, source: 'cad', mesh_path: mesh, image_path: image, up_direction: 'z' });

  assert.equal(bodies[0].get('file').type, 'image/webp');
  assert.equal(bodies[1].get('front').type, 'image/webp');
  assert.equal(bodies[1].get('back').type, 'image/webp');
  assert.deepEqual(bodies[2].getAll('file').map(file => file.type), ['image/webp', 'image/webp']);
  assert.equal(bodies[3].get('image').type, 'image/webp');
});

test('CAD with no reference image uploads only the mesh and preserves scale choices', async t => {
  const captured = [];
  const { dir, client } = await fixture(t, async (_url, init) => { captured.push(init.body); return json({ id: 'bare-cad' }, 201); });
  const mesh = path.join(dir, 'part.obj');
  await writeFile(mesh, 'mesh fixture');
  await client.create({ ...basic, source: 'cad', mesh_path: mesh, meters_per_unit: 0.002, up_direction: 'z', keep_existing_shape: true });
  assert.equal(captured[0].get('image'), null);
  assert.equal(captured[0].get('meters_per_unit'), '0.002');
  assert.equal(captured[0].get('keep_existing_shape'), 'true');
  assert.throws(() => validateCreate({ ...basic, source: 'cad', mesh_path: mesh, meters_per_unit: 0.002, up_direction: 'z', apply_textures: true }), /requires a CAD reference/);
  assert.equal(captured.length, 1);
});

test('CAD GLB appearance intent and optional reference reach the server inspection path', async t => {
  let body;
  const { dir, client } = await fixture(t, async (_url, init) => { body = init.body; return json({ id: 'glb-cad' }, 201); });
  const mesh = path.join(dir, 'part.glb');
  const image = path.join(dir, 'reference.jpg');
  await writeFile(mesh, 'embedded-texture fixture');
  await writeFile(image, 'photo fixture');
  await client.create({ ...basic, source: 'cad', mesh_path: mesh, image_path: image, units: 'm', up_direction: 'y', keep_existing_textures: true });
  assert.equal(body.get('mesh').name, 'part.glb');
  assert.equal(body.get('image').name, 'reference.jpg');
  assert.equal(body.get('keep_existing_textures'), 'true');
});

test('auto uses diffusion multiview inputs while parametric accepts fifty files', async t => {
  const { dir, client } = await fixture(t, async () => json({ id: 'asset-routing' }, 201));
  const views = {};
  for (const view of ['front', 'left', 'back', 'right']) {
    const file = path.join(dir, `${view}.jpg`);
    await writeFile(file, 'image fixture');
    views[view] = file;
  }
  const automatic = await client.create({ ...basic, source: 'image', shape_model: 'auto', views });
  assert.equal(automatic.asset_id, 'asset-routing');
  const imagePaths = [];
  for (let index = 0; index < 50; index += 1) {
    const file = path.join(dir, `parametric-${index}.jpg`);
    await writeFile(file, 'image fixture');
    imagePaths.push(file);
  }
  const created = await client.create({ ...basic, source: 'image', shape_model: 'parametric', image_paths: imagePaths });
  assert.equal(created.asset_id, 'asset-routing');
});

test('invalid input is rejected before any remote write', async t => {
  let calls = 0;
  const { client } = await fixture(t, async () => { calls++; return json({}); });
  const inputs = [
    { ...basic, source: 'image' },
    { ...basic, source: 'image', views: { front: '/missing.jpg' } },
    { ...basic, image_path: '/missing.jpg' },
    { ...basic, apply_textures: true },
    { ...basic, source: 'cad', mesh_path: '/missing.step' },
    { ...basic, decimation_mode: 'strict' },
    { ...basic, decimation_mode: 'strict', decimation_target_faces: 200, decimation_target_ratio: 0.4 }
  ];
  for (const input of inputs) await assert.rejects(client.create(input));
  assert.equal(calls, 0);
});

test('source-specific fields and CAD source frames are validated before upload', async t => {
  let calls = 0;
  const { client } = await fixture(t, async () => { calls++; return json({ id: 'unexpected' }, 201); });
  const cad = { ...basic, source: 'cad', mesh_path: '/missing.step', image_path: '/missing.png' };
  const rejected = [
    { ...basic, source: 'image', image_path: '/missing.png', apply_textures: false },
    { ...cad, image_paths: ['/a.png', '/b.png'], up_direction: 'z' },
    cad,
    { ...cad, units: 'mm', up_direction: 'z' },
    { ...cad, mesh_path: '/missing.obj', up_direction: 'z' },
    { ...cad, mesh_path: '/missing.obj', units: 'mm' },
    { ...cad, mesh_path: '/missing.usd', units: 'm' },
    { ...cad, mesh_path: '/missing.jt', up_direction: 'z' }
  ];
  for (const input of rejected) await assert.rejects(client.create(input));
  assert.equal(calls, 0);
  assert.doesNotThrow(() => validateCreate({ ...cad, mesh_path: '/part.obj', units: 'mm', up_direction: 'z' }));
  assert.doesNotThrow(() => validateCreate({ ...cad, up_direction: 'z' }));
  assert.doesNotThrow(() => validateCreate({ ...cad, mesh_path: '/part.usd' }));
});

test('body type and its solver are accepted together and refused when they contradict', () => {
  const soft = { ...basic, engine: ['newton'], body_type: 'soft_bodies', newton_solver: 'vbd' };
  assert.doesNotThrow(() => validateCreate(soft));
  assert.doesNotThrow(() => validateCreate({ ...basic, body_type: 'mixed_bodies' }));
  assert.doesNotThrow(() => validateCreate({ ...basic, newton_solver: 'mujoco' }));
  // The API swaps a solver the body type cannot use instead of reporting it, so
  // an agent that asked for one and got another would never find out.
  assert.throws(() => validateCreate({ ...soft, newton_solver: 'mujoco' }), /only newton_solver=vbd/);
  assert.throws(() => validateCreate({ ...basic, body_type: 'rigid_bodies', newton_solver: 'vbd' }), /soft-body solver/);
  assert.throws(() => validateCreate({ ...basic, body_type: 'squishy' }));
});

test('mesh and material switches reach every source', () => {
  for (const field of ['repair_mesh', 'replace_glass', 'auto_scale']) {
    assert.doesNotThrow(() => validateCreate({ ...basic, [field]: true }));
    assert.doesNotThrow(() => validateCreate({ ...basic, [field]: false }));
    assert.throws(() => validateCreate({ ...basic, [field]: 'yes' }));
  }
});

test('CAD reuse flags are CAD-only and refuse the combinations that contradict them', () => {
  const cad = { source: 'cad', name: 'Test part', description: 'A part', mesh_path: '/part.usd', image_path: '/ref.png' };
  for (const field of ['regenerate_parts', 'keep_existing_textures', 'keep_existing_shape', 'physics_validation_only']) {
    assert.doesNotThrow(() => validateCreate({ ...cad, [field]: true }));
    assert.throws(() => validateCreate({ ...basic, [field]: true }), /only for CAD input/);
  }
  assert.throws(() => validateCreate({ ...cad, keep_existing_shape: true, regenerate_parts: true }), /opposite things/);
  assert.throws(() => validateCreate({ ...cad, physics_validation_only: true, regenerate_parts: true }), /regenerate_parts=true/);
  assert.throws(() => validateCreate({ ...cad, keep_existing_textures: true, apply_textures: true }), /apply_textures=true/);
  assert.throws(() => validateCreate({ ...cad, physics_validation_only: true, apply_textures: true }), /apply_textures=true/);
  // Keeping only one half is a real request and must stay available.
  assert.doesNotThrow(() => validateCreate({ ...cad, keep_existing_textures: true, regenerate_parts: true }));
});

test('keeping a CAD appearance is refused on the formats that cannot carry one', () => {
  const direct = { source: 'cad', name: 'Test part', description: 'A part', image_path: '/ref.png', mesh_path: '/part.obj', units: 'm', up_direction: 'z' };
  // External texture sidecars do not travel with a single mesh upload.
  for (const field of ['keep_existing_textures', 'physics_validation_only']) {
    assert.throws(() => validateCreate({ ...direct, [field]: true }), /cannot preserve an authored appearance/);
  }
  assert.throws(() => validateCreate({ ...direct, apply_textures: false }), /cannot preserve an authored appearance/);
  // A GLB may carry bound texture bytes. The API inspects them after upload;
  // the client cannot establish that from the file extension alone.
  assert.doesNotThrow(() => validateCreate({ ...direct, mesh_path: '/part.glb', keep_existing_textures: true }));
  assert.doesNotThrow(() => validateCreate({ ...direct, mesh_path: '/part.glb', physics_validation_only: true }));
  assert.doesNotThrow(() => validateCreate({ ...direct, mesh_path: '/part.glb', apply_textures: false }));
  // A direct mesh can remain untextured when there was no reference image,
  // but the keep-existing flag still promises appearance the file cannot prove.
  assert.doesNotThrow(() => validateCreate({ ...direct, image_path: undefined, apply_textures: false }));
  assert.throws(() => validateCreate({ ...direct, image_path: undefined, physics_validation_only: true }), /cannot preserve an authored appearance/);
  // Shape reuse promises nothing about appearance, so it stays available.
  assert.doesNotThrow(() => validateCreate({ ...direct, keep_existing_shape: true }));
  // The formats that can carry an appearance keep all of it.
  assert.doesNotThrow(() => validateCreate({ ...direct, mesh_path: '/part.usda', units: undefined, up_direction: undefined, physics_validation_only: true }));
  assert.doesNotThrow(() => validateCreate({ ...direct, mesh_path: '/part.step', units: undefined, keep_existing_textures: true }));
});

test('CAD meters_per_unit is limited to direct meshes and conflicts are rejected', () => {
  const direct = { ...basic, source: 'cad', mesh_path: '/part.glb', up_direction: 'z', meters_per_unit: 0.001 };
  assert.doesNotThrow(() => validateCreate(direct));
  assert.doesNotThrow(() => validateCreate({ ...direct, units: 'mm' }));
  assert.throws(() => validateCreate({ ...direct, units: 'cm' }), /conflict/);
  assert.throws(() => validateCreate({ ...direct, meters_per_unit: 0 }), /too_small|positive/);
  assert.throws(() => validateCreate({ ...direct, mesh_path: '/part.step' }), /omit meters_per_unit/);
  assert.throws(() => validateCreate({ ...direct, mesh_path: '/part.usdc' }), /omit units, meters_per_unit/);
});

test('every documented create parameter is reachable through the schema', () => {
  const documented = [
    'body_type', 'newton_solver', 'repair_mesh', 'replace_glass', 'auto_scale',
    'regenerate_parts', 'keep_existing_textures', 'keep_existing_shape', 'physics_validation_only',
    'effort', 'reconstruct', 'meters_per_unit'
  ];
  for (const field of documented) assert.ok(field in createSchema.shape, `${field} missing from createSchema`);
});

test('names, descriptions, and workspace IDs match the public API contract', async t => {
  let calls = 0;
  const { client } = await fixture(t, async () => { calls++; return json({ id: 'unexpected' }, 201); });
  for (const input of [
    { ...basic, name: 'bad/name' },
    { ...basic, name: '    ' },
    { ...basic, description: '   ' },
    { ...basic, workspace: 'workspace-1' }
  ]) await assert.rejects(client.create(input));
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
  assert.equal(receipt.source_status, 'READY');
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

test('failed export requires explicit confirmation before any billable request', async t => {
  const calls = [];
  const zip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
  const { dir, client } = await fixture(t, async url => {
    calls.push(String(url));
    return String(url).endsWith('/status') ? json({ status: 'PROCESSING_FAILED' }) : new Response(zip, { headers: { 'Content-Type': 'application/zip' } });
  });
  await assert.rejects(client.download('asset-x', dir), /allow_failed_export=true/);
  assert.equal(calls.length, 1);
  const partial = await client.download('asset-x', dir, { allowFailedExport: true });
  assert.equal(partial.export_classification, 'partial_or_unvalidated');
  assert.equal(calls.length, 3);
  await writeFile(path.join(dir, 'asset-y-export.zip'), 'preserve me');
  await assert.rejects(client.download('asset-y', dir), /already exists/);
  assert.equal(calls.length, 3);
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

test('asset listing encodes workspace filters and pagination in the documented filter object', async t => {
  const { client } = await fixture(t, async (url, init) => {
    assert.equal(init.method, 'GET');
    assert.deepEqual(JSON.parse(url.searchParams.get('filter')), { limit: 5, skip: 10, where: { search: 'bin & lid', 'status.status': 'READY' } });
    return json({ data: [{ id: 'a' }] });
  });
  assert.deepEqual(await client.listAssets({ search: 'bin & lid', status: 'READY', limit: 5, skip: 10 }), { data: [{ id: 'a' }] });
  await assert.rejects(client.listAssets({ limit: 101 }));
});

test('asset details, pipeline progress and batch status use distinct documented routes', async t => {
  const calls = [];
  const { client } = await fixture(t, async (url, init) => { calls.push({ path: url.pathname, method: init.method, body: init.body }); return json({ ok: true }); });
  await client.getAssetDetails('asset-a'); await client.pipelineProgress('asset-a'); await client.batchStatus(['asset-a', 'asset-b']);
  assert.deepEqual(calls.map(c => c.path), ['/api/v1/external/assets/asset-a', '/api/v1/external/assets/asset-a/pipeline-runs/current', '/api/v1/external/assets/statuses']);
  assert.deepEqual(JSON.parse(calls[2].body), { ids: ['asset-a', 'asset-b'] });
  await assert.rejects(client.batchStatus([])); await assert.rejects(client.getAssetDetails('../escape'));
  assert.equal(calls.length, 3);
});

test('variant creation submits only public fields and returns the independent asset ID', async t => {
  let calls = 0;
  const body = { feedback: 'Make it blue', name: 'Blue bin', parameters: { texture_size: 2048 } };
  const { client } = await fixture(t, async (url, init) => {
    calls++; assert.match(url.pathname, /assets\/source-a\/variants$/); assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), body);
    return json({ id: 'variant-a', status: { status: 'SUBMITTED' } }, 201);
  });
  const result = await client.createVariant('source-a', body);
  assert.equal(result.asset_id, 'variant-a'); assert.equal(result.parent_asset_id, 'source-a');
  await assert.rejects(client.createVariant('source-a', { feedback: '   ' }));
  await assert.rejects(client.createVariant('source-a', { ...body, from: 'texture' }));
  assert.equal(calls, 1);
});

test('reprocess preserves exact stage and run controls and never retries ambiguous writes', async t => {
  let calls = 0;
  const body = { from: 'texture', mode: 'step', stopAfter: 'texture', sourceRunId: 'run-1', destination: 'variant', feedback: 'matte finish' };
  const { client } = await fixture(t, async (url, init) => {
    calls++; assert.match(url.pathname, /assets\/asset-a\/reprocess$/); assert.deepEqual(JSON.parse(init.body), body); throw Error('connection closed');
  });
  await assert.rejects(client.reprocess('asset-a', body), /may have accepted/);
  assert.equal(calls, 1);
  await assert.rejects(client.reprocess('asset-a', { from: 'texture', mode: 'unsupported' }));
  assert.equal(calls, 1);
});

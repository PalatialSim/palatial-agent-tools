import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PalatialClient, createSchema, mcpCreateSchema, mcpCreateInput, validateCreate } from '../src/client.js';

const base = { source: 'text', name: 'Mode test bin', description: 'A rigid open storage bin.', engine: ['isaac_sim'] };
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'palatial-modes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const client = new PalatialClient({ apiKey: 'fixture-key', receiptDir: path.join(dir, 'receipts'), fetchImpl: async (url, init) => {
    calls.push({ url: String(url), body: init.body });
    return new Response(JSON.stringify({ id: `mode-${calls.length}` }), { status: 201 });
  } });
  return { dir, calls, client };
}

test('all three routes send mode-shaped JSON without adding legacy build settings', async t => {
  const { client, calls } = await fixture(t);
  for (const route of [
    { mode: 'diffusion', parameters: { structure: 'single_object', run_simulation: false, texture_size: 2048 } },
    { mode: 'parametric', effort: 'low', parameters: { articulation: true, face_budget: 50000 } },
    { mode: 'parametric', effort: 'mad_max', parameters: {} },
    { mode: 'mad_max' }
  ]) {
    await client.create({ ...base, ...route });
    assert.deepEqual(JSON.parse(calls.at(-1).body), { name: base.name, description: base.description, engine: base.engine, ...route });
  }
});

test('route-inappropriate or mistyped parameters are refused before a remote write', async t => {
  const { client, calls } = await fixture(t);
  for (const request of [
    { parameters: {} },
    { mode: 'diffusion', mesh_quality: 'high' },
    { mode: 'diffusion', shape_model: 'diffusion' },
    { mode: 'diffusion', effort: 'low' },
    { mode: 'diffusion', product_research: 'on' },
    { mode: 'diffusion', parameters: { face_budget: 50000 } },
    { mode: 'parametric', parameters: { mesh_quality: 'high' } },
    { mode: 'parametric', parameters: { body_type: 'soft_bodies' } },
    { mode: 'parametric', parameters: { newton_solver: 'vbd' } },
    { mode: 'parametric', parameters: { face_budget: 1999 } },
    { mode: 'parametric', parameters: { face_budget: 200001 } },
    { mode: 'parametric', parameters: { face_budget: '50000' } },
    { mode: 'parametric', parameters: { articulation: 'true' } },
    { mode: 'parametric', effort: 'mad_max', parameters: { run_simulation: false } },
    { mode: 'mad_max', effort: 'low' },
    { mode: 'mad_max', engine: ['isaac_sim', 'mujoco'] },
    { mode: 'mad_max', product_research: 'off' },
    { mode: 'diffusion', parameters: { run_simulation: null } },
    { mode: 'diffusion', parameters: { ignored_setting: true } }
  ]) await assert.rejects(client.create({ ...base, ...request }), undefined, JSON.stringify(request));
  assert.equal(calls.length, 0);
  assert.equal(createSchema.safeParse({ ...base, mode: 'parametric', parameters: { mesh_quality: 'high' } }).success, false, 'MCP schema must reject unsupported settings even with a mock API client.');
});

test('multipart parameters preserve JSON types and use the documented file fields', async t => {
  const { dir, calls, client } = await fixture(t);
  const image = path.join(dir, 'front.webp');
  await writeFile(image, 'image fixture');
  await client.create({ ...base, source: 'image', mode: 'diffusion', image_path: image, parameters: { structure: 'single_object', run_simulation: false, decimation_mode: 'strict', decimation_target_faces: 20000 } });
  const body = calls[0].body;
  assert.match(calls[0].url, /imagetosim$/);
  assert.equal(body.get('mode'), 'diffusion');
  assert.deepEqual(JSON.parse(body.get('parameters')), { structure: 'single_object', run_simulation: false, decimation_mode: 'strict', decimation_target_faces: 20000 });
  assert.equal(body.get('file').name, 'front.webp');
  assert.equal(body.get('file').type, 'image/webp');
  assert.equal(body.get('image_path'), null);
});

test('MCP auto collision uses the server default in JSON and multipart without changing the caller input', async t => {
  const { dir, calls, client } = await fixture(t);
  const image = path.join(dir, 'front.png');
  await writeFile(image, 'image fixture');
  const inputs = [
    { ...base, mode: 'diffusion', parameters: { collision_quality: 'auto', structure: 'single_object' } },
    { ...base, source: 'image', mode: 'parametric', image_path: image, parameters: { collision_quality: 'auto', face_budget: 50000 } },
    { ...base, source: 'cad', mesh_path: path.join(dir, 'mesh.obj'), units: 'm', up_direction: 'z', collision_quality: 'auto' }
  ];
  await writeFile(inputs[2].mesh_path, 'mesh fixture');
  for (const input of inputs) {
    const original = structuredClone(input);
    await client.create(mcpCreateInput(mcpCreateSchema.parse(input)));
    const body = calls.at(-1).body;
    const sent = typeof body === 'string' ? JSON.parse(body) : Object.fromEntries(body.entries());
    assert.equal(sent.collision_quality, undefined);
    const parameters = typeof sent.parameters === 'string' ? JSON.parse(sent.parameters) : sent.parameters;
    assert.equal(parameters?.collision_quality, undefined);
    assert.deepEqual(input, original);
  }
});

test('video-only creates and videos with mixed photos work for every route with empty parameters', async t => {
  const { dir, client, calls } = await fixture(t);
  const video = path.join(dir, 'object.mov'), image = path.join(dir, 'object.png');
  await writeFile(video, 'video fixture'); await writeFile(image, 'image fixture');
  for (const route of [{ mode: 'diffusion' }, { mode: 'parametric', effort: 'low' }, { mode: 'parametric', effort: 'mad_max' }]) {
    await client.create({ ...base, source: 'image', ...route, video_path: video, product_research: 'specs_only', parameters: {} });
    assert.equal(calls.at(-1).body.get('video').type, 'video/quicktime');
  }
  await client.create({ ...base, source: 'image', mode: 'diffusion', video_path: video, image_paths: [image], views: { front: image }, product_research: 'off' });
  assert.equal(calls.at(-1).body.getAll('file').length, 1);
  assert.equal(calls.at(-1).body.get('front').name, 'object.png');
  const before = calls.length;
  for (const fields of [{ mesh_quality: 'high' }, { create_articulation: true }, { collision_quality: 'medium' }, { texture_model: 'auto' }]) {
    await assert.rejects(client.create({ ...base, source: 'image', shape_model: 'parametric', video_path: video, ...fields }), /CREATE_PARAMETERS_INVALID/);
  }
  await assert.rejects(client.create({ ...base, source: 'image', mode: 'diffusion', video_path: video, parameters: { structure: 'single_object' } }), /CREATE_PARAMETERS_INVALID/);
  await assert.rejects(client.create({ ...base, mode: 'mad_max', video_path: video }), /Text generation/);
  assert.equal(calls.length, before);
  await client.create({ ...base, source: 'image', shape_model: 'parametric', effort: 'low', video_path: video });
  assert.equal(calls.at(-1).body.get('shape_model'), 'parametric');
});

test('Mad Max accepts a scanned GLB on text and image requests and counts it in the eight-input cap', async t => {
  const { dir, client, calls } = await fixture(t);
  const mesh = path.join(dir, 'scan.glb'), image = path.join(dir, 'object.jpg');
  await writeFile(mesh, 'mesh fixture'); await writeFile(image, 'image fixture');
  await client.create({ ...base, mode: 'mad_max', reference_mesh_path: mesh });
  assert.match(calls[0].url, /texttosim$/);
  assert.equal(calls[0].body.get('reference_mesh').name, 'scan.glb');
  await client.create({ ...base, source: 'image', mode: 'mad_max', reference_mesh_path: mesh, image_paths: Array(7).fill(image) });
  assert.equal(calls[1].body.getAll('file').length, 7);
  await assert.rejects(client.create({ ...base, source: 'image', mode: 'mad_max', reference_mesh_path: mesh, image_paths: Array(8).fill(image) }), /at most 7/);
  await assert.rejects(client.create({ ...base, source: 'image', mode: 'mad_max', image_paths: Array(9).fill(image) }), /at most 8/);
  await assert.rejects(client.create({ ...base, mode: 'parametric', reference_mesh_path: mesh }), /only for text\/image Mad Max/);
  assert.equal(calls.length, 2);
});

test('video type, empty inputs and the 300 MiB cap are validated before upload', async t => {
  const { dir, client, calls } = await fixture(t);
  for (const [name, bytes, match] of [['object.avi', 4, /MP4 or MOV/], ['empty.mp4', 0, /nonempty/], ['large.mp4', 300 * 1024 ** 2 + 1, /300 MiB/]]) {
    const video = path.join(dir, name); await writeFile(video, ''); await truncate(video, bytes);
    await assert.rejects(client.create({ ...base, source: 'image', mode: 'diffusion', video_path: video }), match);
  }
  assert.equal(calls.length, 0);
});

test('nested decimation and legacy Parametric face budgets refuse settings the builder cannot honor', () => {
  assert.throws(() => validateCreate({ ...base, mode: 'diffusion', parameters: { decimation_mode: 'strict' } }), /exactly one target/);
  assert.throws(() => validateCreate({ ...base, shape_model: 'parametric', decimation_mode: 'strict', decimation_target_ratio: 0.5 }), /PARAMETRIC_DECIMATION_REQUIRES_FACE_TARGET/);
  assert.throws(() => validateCreate({ ...base, shape_model: 'parametric', decimation_mode: 'strict', decimation_target_faces: 500000 }), /PARAMETRIC_FACE_BUDGET_UNSUPPORTED/);
  assert.equal(validateCreate({ ...base, mode: 'parametric', parameters: { face_budget: 2000 } }).parameters.face_budget, 2000);
  assert.equal(validateCreate({ ...base, mode: 'parametric', parameters: { face_budget: 200000 } }).parameters.face_budget, 200000);
});

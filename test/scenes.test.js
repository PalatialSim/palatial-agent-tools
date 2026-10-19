import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PalatialClient } from '../src/client.js';
import { createServer } from '../src/mcp.js';
import { createSceneSchema, createSceneLegacy, answerSceneSchema, sceneSourceSchema } from '../src/scenes.js';

const workspace = '0123456789abcdef01234567';
const sceneId = 'abcdef0123456789abcdef01';
const requestId = '43292215-7330-489c-83b5-324c3b337e9a';
const zip = Buffer.from('504b030400000000', 'hex');
const version = `sha256:${createHash('sha256').update(zip).digest('hex')}`;
const input = { workspace, request_id: requestId, description: 'Reconstruct this workshop.', confirm_spend: true, options: { object_build_mode: 'mock_mad_max' } };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = { key: 'owned/source', filename: 'room.png', mediaType: 'image/png', sha256: hash(Buffer.from('photo')), bytes: 5 };
const response = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
function api(fetchImpl, opts = {}) { return new PalatialClient({ apiKey: 'test-key', baseUrl: 'https://dev.example/api/v1/external/', fetchImpl, ...opts }); }
async function temporary(t) { const dir = await mkdtemp(path.join(tmpdir(), 'palatial-scenes-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function connect(t, client) {
  const server = createServer({ clientFactory: async () => client });
  const mcp = new Client({ name: 'scene-contract', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await mcp.connect(b);
  t.after(async () => { await mcp.close(); await server.close(); });
  return mcp;
}

test('all local input files are checked before creating a scene draft', async t => {
  const directory = await temporary(t);
  const photo = path.join(directory, 'photo.png'); await writeFile(photo, 'valid');
  let requests = 0;
  await assert.rejects(api(async () => { requests++; }).createScene({ ...input, source_paths: [photo, path.join(directory, 'missing.png')] }), { code: 'ENOENT' });
  assert.equal(requests, 0);
  const invalidName = path.join(directory, 'invalid filename.png'); await writeFile(invalidName, 'photo');
  await assert.rejects(api(async () => { requests++; }).createScene({ ...input, source_paths: [invalidName] }), /source filename/);
  assert.equal(requests, 0);
});

test('started replay sends original expected revision and matching owned sources to server validation', async t => {
  const directory = await temporary(t); const photo = path.join(directory, 'room.png'); await writeFile(photo, 'photo');
  const calls = [];
  const state = { scene_id: sceneId, status: 'running', revision: 9, confirmed_request_revision: 2, sources: [source] };
  const client = api(async (url, opts) => { calls.push({ route: url.pathname, body: opts.body && JSON.parse(opts.body) }); return response(state); });
  assert.equal((await createSceneLegacy(client, { ...input, source_paths: [photo] })).scene_id, sceneId);
  const generate = calls.find(call => call.route.endsWith('/generate'));
  assert.equal(generate.body.expected_revision, 2);
  assert.deepEqual(generate.body.sources, [source]);
  assert.ok(!calls.some(call => call.route.endsWith('/sources')));
});

test('request_id reuse with changed local content conflicts without another upload or generation', async t => {
  const directory = await temporary(t); const photo = path.join(directory, 'room.png'); await writeFile(photo, 'changed');
  const calls = [];
  const client = api(async url => { calls.push(url.pathname); return response({ scene_id: sceneId, status: 'running', revision: 2, confirmed_request_revision: 1, sources: [source] }); });
  await assert.rejects(createSceneLegacy(client, { ...input, source_paths: [photo] }), /request_id conflicts/);
  assert.ok(!calls.some(call => /sources|generate$/.test(call)));
});

test('server rejects changed replay options and the error preserves the scene handle', async () => {
  const state = { scene_id: sceneId, status: 'running', confirmed_request_revision: 1, sources: [] };
  const client = api(async url => url.pathname.endsWith('/generate') ? new Response(JSON.stringify({ code: 'SCENE_REQUEST_CONFLICT', message: 'The request ID belongs to different scene input.' }), { status: 409 }) : response(state));
  await assert.rejects(createSceneLegacy(client, input), error => { assert.match(error.message, /SCENE_REQUEST_CONFLICT/); assert.match(error.message, new RegExp(sceneId)); assert.match(error.message, /No automatic retry/); return true; });
});

test('multipart uploads resume completed parts with exact binary lengths and complete checksum', async t => {
  const directory = await temporary(t); const filename = path.join(directory, 'video.mp4');
  const bytes = Buffer.alloc(33 * 1024 ** 2, 7); await writeFile(filename, bytes);
  const parts = [];
  let uploadId;
  const client = api(async (url, options) => {
    if (url.pathname.endsWith('/start')) { const body = JSON.parse(options.body); assert.equal(body.bytes, bytes.length); assert.match(body.uploadRequestId, /^[a-f0-9-]{36}$/); uploadId = 'a'.repeat(32); return response({ uploadId, partSizeBytes: 16 * 1024 ** 2, partCount: 3, completedParts: [{ partNumber: 1, etag: 'first' }] }); }
    if (url.pathname.includes('/parts/')) { const partNumber = Number(url.pathname.split('/').pop()); assert.equal(options.headers['Content-Type'], 'application/octet-stream'); assert.equal(options.headers['Content-Length'], String(options.body.byteLength)); parts.push(partNumber); assert.equal(hash(options.body), hash(bytes.subarray((partNumber - 1) * 16 * 1024 ** 2, partNumber * 16 * 1024 ** 2))); return response({ partNumber, etag: `part-${partNumber}` }); }
    if (url.pathname.endsWith('/complete')) { const body = JSON.parse(options.body); assert.equal(body.sha256, hash(bytes)); assert.deepEqual(body.parts.map(part => part.partNumber), [1, 2, 3]); return response({ source: { ...source, filename: 'video.mp4', mediaType: 'video/mp4', sha256: hash(bytes), bytes: bytes.length } }); }
    return response({ scene_id: sceneId, status: 'draft', revision: 0 });
  });
  await createSceneLegacy(client, { ...input, source_paths: [filename] });
  assert.deepEqual(parts, [2, 3]);
  assert.match(uploadId, /^[a-f0-9]{32}$/);
});

test('failed upload returns recoverable identity without starting or automatically retrying', async t => {
  const directory = await temporary(t); const filename = path.join(directory, 'room.png'); await writeFile(filename, 'photo');
  const calls = [];
  const client = api(async url => { calls.push(url.pathname); if (url.pathname.endsWith('/sources')) throw new Error('upload connection lost test-key https://storage.example/file?token=secret'); return response({ scene_id: sceneId, status: 'draft', revision: 0 }); });
  await assert.rejects(createSceneLegacy(client, { ...input, source_paths: [filename] }), error => { assert.match(error.message, new RegExp(sceneId)); assert.match(error.message, new RegExp(requestId)); assert.doesNotMatch(error.message, /test-key|token=secret/); return true; });
  assert.equal(calls.filter(route => route.endsWith('/sources')).length, 1);
  assert.ok(!calls.some(route => route.endsWith('/generate')));
});

test('read preserves unknown costs and cancellation partial failures', async () => {
  const value = { scene_id: sceneId, cost: { director: null, objects: null, total: null }, cancellation: { requested: true, failures: ['child'] } };
  assert.deepEqual(await api(async () => response(value)).getScene(sceneId), value);
});

test('versioned scene download caches verified receipts and preserves existing output', async t => {
  const directory = await temporary(t); let requests = 0;
  const client = api(async url => {
    requests++;
    if (String(url).includes('/download')) return new Response(zip, { headers: { 'content-type': 'application/zip', etag: `"${version}"`, 'content-length': String(zip.length) } });
    return response({ download: { version } });
  });
  const args = { scene_id: sceneId, version, output_dir: directory };
  const first = await client.downloadScene(args); assert.equal(first.cached, false);
  assert.equal((await client.downloadScene(args)).cached, true); assert.equal(requests, 2);
  await writeFile(first.file, 'modified');
  await assert.rejects(client.downloadScene(args), /already exists/);
  assert.equal(requests, 2);
  assert.equal(await readFile(first.file, 'utf8'), 'modified');
});

test('invalid and oversized scene downloads clean reserved output without following redirects', async t => {
  for (const [payload, options] of [['not a zip', {}], [Buffer.from('504b030400', 'hex'), { maxDownloadBytes: 4 }]]) {
    const directory = await temporary(t);
    const payloadVersion = `sha256:${hash(Buffer.from(payload))}`;
    const client = api(async () => new Response(payload, { headers: { etag: `"${payloadVersion}"`, 'content-length': String(payload.length) } }), options);
    await assert.rejects(client.downloadScene({ scene_id: sceneId, version: payloadVersion, output_dir: directory }), /ZIP|download limit/);
    assert.deepEqual(await readdir(directory), []);
  }
  const directory = await temporary(t); let calls = 0;
  const client = api(async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://untrusted.example/?secret=value' } }); });
  await assert.rejects(client.downloadScene({ scene_id: sceneId, version, output_dir: directory }), /did not return an archive/);
  assert.equal(calls, 1);
});

test('scene inputs follow shared Backend instruction, selection and upload bounds', async t => {
  assert.equal(createSceneSchema.safeParse({ ...input, description: 'a'.repeat(4000) }).success, true);
  assert.equal(createSceneSchema.safeParse({ ...input, description: 'a'.repeat(4001) }).success, false);
  assert.equal(answerSceneSchema.safeParse({ scene_id: sceneId, expected_head: version, instruction: 'a'.repeat(4000) }).success, true);
  assert.equal(answerSceneSchema.safeParse({ scene_id: sceneId, expected_head: version, instruction: 'a'.repeat(4001) }).success, false);
  assert.equal(createSceneSchema.safeParse({ ...input, source_paths: Array.from({ length: 32 }, (_, index) => `source-${index}.png`) }).success, true);
  assert.equal(createSceneSchema.safeParse({ ...input, source_paths: Array.from({ length: 33 }, (_, index) => `source-${index}.png`) }).success, false);
  assert.equal(createSceneSchema.safeParse({ ...input, source_paths: Array.from({ length: 32 }, (_, index) => `source-${index}.png`), sources: [source] }).success, false);
  assert.equal(sceneSourceSchema.safeParse({ ...source, bytes: 1_000_000_000 }).success, true);
  assert.equal(sceneSourceSchema.safeParse({ ...source, bytes: 1_000_000_001 }).success, false);
  const directory = await temporary(t); const filename = path.join(directory, 'oversized.mp4');
  const file = await import('node:fs/promises').then(fs => fs.open(filename, 'w'));
  await file.truncate(1_000_000_001); await file.close();
  let requests = 0;
  await assert.rejects(api(async () => { requests++; }).createScene({ ...input, source_paths: [filename] }), /1 GB/);
  assert.equal(requests, 0);
});

test('scene download rejects ETag, Content-Length and package digest mismatches and cleans output', async t => {
  const validHeaders = { 'content-type': 'application/zip', etag: `"${version}"`, 'content-length': String(zip.length) };
  const changedZip = Buffer.from(zip); changedZip[changedZip.length - 1] = 1;
  for (const [body, headers, expected] of [
    [zip, { ...validHeaders, etag: `"sha256:${'b'.repeat(64)}"` }, /ETag/],
    [zip, { ...validHeaders, etag: undefined }, /ETag/],
    [zip, { ...validHeaders, 'content-length': undefined }, /Content-Length/],
    [zip, { ...validHeaders, 'content-length': String(zip.length + 1) }, /byte count/],
    [changedZip, validHeaders, /SHA-256/]
  ]) {
    const directory = await temporary(t);
    const filteredHeaders = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
    const client = api(async () => new Response(body, { headers: filteredHeaders }));
    await assert.rejects(client.downloadScene({ scene_id: sceneId, version, output_dir: directory }), expected);
    assert.deepEqual(await readdir(directory), []);
  }
});

test('cached archive cannot claim another version even when its receipt matches the modified file', async t => {
  const directory = await temporary(t);
  const client = api(async () => new Response(zip, { headers: { etag: `"${version}"`, 'content-length': String(zip.length) } }));
  const args = { scene_id: sceneId, version, output_dir: directory };
  const first = await client.downloadScene(args);
  const changedZip = Buffer.from(zip); changedZip[changedZip.length - 1] = 1;
  await writeFile(first.file, changedZip);
  const receipt = JSON.parse(await readFile(first.receipt_file, 'utf8'));
  receipt.sha256 = hash(changedZip);
  await writeFile(first.receipt_file, JSON.stringify(receipt));
  await assert.rejects(client.downloadScene(args), /already exists/);
});

test('deprecated recovery client methods remain callable without advertising recovery tools', async () => {
  const calls = [];
  const client = api(async (url, options) => { calls.push({ path: url.pathname, body: JSON.parse(options.body) }); return response({ scene_id: sceneId, status: 'running' }); });
  await client.recoverScene({ scene_id: sceneId, expected_head: version });
  await client.retrySceneStart({ scene_id: sceneId, confirm_spend: true });
  assert.equal(calls.length, 2);
});

test('one-shot URL start forwards autoContinue and never calls legacy endpoints', async () => {
  const calls = [];
  const client = api(async (url, options) => { calls.push({ path: url.pathname, body: JSON.parse(options.body) }); return response({ scene_id: sceneId, status: 'running' }); });
  await client.createScene({ ...input, auto_continue: true, sources: [{ filename: 'room.png', media_type: 'image/png', url: 'https://example.com/room.png' }] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `/api/v1/external/workspaces/${workspace}/scene-generations/start`);
  assert.equal(calls[0].body.autoContinue, true);
  assert.equal(calls[0].body.sources[0].url, 'https://example.com/room.png');
  assert.equal(createSceneSchema.safeParse({ ...input, sources: [{ filename: 'room.png', media_type: 'image/png', url: 'file:///private/photo' }] }).success, false);
});

test('large source streams only to signed storage and upload completion needs no generate', async t => {
  const directory = await temporary(t); const filename = path.join(directory, 'video.mp4');
  const bytes = Buffer.alloc(33 * 1024 ** 2, 7); await writeFile(filename, bytes);
  const calls = [];
  const client = api(async (url, options) => {
    const uri = new URL(url); calls.push(uri.pathname);
    if (uri.pathname.endsWith('/start')) {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.sources, [{ filename: 'video.mp4', media_type: 'video/mp4', bytes: bytes.length, sha256: hash(bytes) }]);
      return response({ scene_id: sceneId, status: 'uploading', uploads: [{ filename: 'video.mp4', method: 'PUT', url: 'https://storage.example/video', headers: { 'Content-Type': 'video/mp4' }, expires_in: 3600 }] });
    }
    if (uri.host === 'storage.example') {
      assert.equal(options.headers['x-api-key'], undefined); assert.equal(options.redirect, 'error');
      let size = 0; const digest = createHash('sha256');
      for await (const chunk of options.body) { size += chunk.length; digest.update(chunk); }
      assert.equal(size, bytes.length); assert.equal(digest.digest('hex'), hash(bytes));
      return new Response(null, { status: 200 });
    }
    return response({ scene_id: sceneId, status: 'running' });
  });
  assert.equal((await client.createScene({ ...input, source_paths: [filename] })).status, 'running');
  assert.equal(calls.length, 3);
  assert.ok(!calls.some(route => /source-uploads|generate$/.test(route)));
});

test('download without a version resolves the current accepted delivery', async t => {
  const directory = await temporary(t); const calls = [];
  const client = api(async url => { calls.push(url.pathname); return url.pathname.endsWith('/download') ? new Response(zip, { headers: { 'content-type': 'application/zip', etag: `"${version}"`, 'content-length': String(zip.length) } }) : response({ download: { version } }); });
  assert.equal((await client.downloadScene({ scene_id: sceneId, output_dir: directory })).version, version);
  assert.equal(calls.length, 2);
});

test('signed upload failure preserves identity without retries or leaking storage URL', async t => {
  const directory = await temporary(t); const filename = path.join(directory, 'video.mp4');
  const file = await import('node:fs/promises').then(fs => fs.open(filename, 'w'));
  await file.truncate(33 * 1024 ** 2); await file.close();
  let requests = 0;
  const client = api(async (url, options) => {
    requests++;
    if (new URL(url).pathname.endsWith('/start')) return response({ scene_id: sceneId, uploads: [{ filename: 'video.mp4', method: 'PUT', url: 'https://storage.example/video?signature=private', headers: { 'Content-Type': 'video/mp4' } }] });
    throw new Error('Storage failed https://storage.example/video?signature=private');
  });
  await assert.rejects(client.createScene({ ...input, source_paths: [filename] }), error => {
    assert.match(error.message, new RegExp(sceneId)); assert.match(error.message, new RegExp(requestId));
    assert.doesNotMatch(error.message, /signature|storage.example/); return true;
  });
  assert.equal(requests, 2);
});

test('combined inline bytes stay bounded and remaining small files use signed uploads', async t => {
  const directory = await temporary(t);
  const filenames = [path.join(directory, 'one.mp4'), path.join(directory, 'two.mp4')];
  for (const filename of filenames) {
    const file = await import('node:fs/promises').then(fs => fs.open(filename, 'w'));
    await file.truncate(20 * 1024 ** 2); await file.close();
  }
  let uploaded = 0;
  const client = api(async (url, options) => {
    if (new URL(url).pathname.endsWith('/start')) {
      const sources = JSON.parse(options.body).sources;
      assert.ok(sources[0].base64); assert.equal(sources[1].base64, undefined);
      return response({ scene_id: sceneId, uploads: [{ filename: 'two.mp4', method: 'PUT', url: 'https://storage.example/two', headers: { 'Content-Type': 'video/mp4' } }] });
    }
    if (new URL(url).host === 'storage.example') {
      for await (const chunk of options.body) uploaded += chunk.length;
      return new Response(null, { status: 200 });
    }
    return response({ scene_id: sceneId, status: 'running' });
  });
  await client.createScene({ ...input, source_paths: filenames });
  assert.equal(uploaded, 20 * 1024 ** 2);
});

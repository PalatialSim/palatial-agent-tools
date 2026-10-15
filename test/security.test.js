import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { autoCreateSchema } from '../src/auto-create.js';
import { PalatialClient } from '../src/client.js';
import { createSceneSchema } from '../src/scenes.js';
import { runSetup } from '../src/setup.js';

const workspace = '0123456789abcdef01234567';
const sceneId = 'abcdef0123456789abcdef01';
const requestId = '43292215-7330-489c-83b5-324c3b337e9a';
const sceneInput = { workspace, request_id: requestId, description: 'Reconstruct this workshop.', confirm_spend: true };
const zip = Buffer.from('504b030400000000', 'hex');
const version = `sha256:${createHash('sha256').update(zip).digest('hex')}`;
const response = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const archiveResponse = () => new Response(zip, { headers: { 'content-type': 'application/zip', etag: `"${version}"`, 'content-length': String(zip.length) } });
function api(fetchImpl, opts = {}) { return new PalatialClient({ apiKey: 'test-key', baseUrl: 'https://dev.example/api/v1/external/', fetchImpl, ...opts }); }
async function temporary(t) { const dir = await mkdtemp(path.join(tmpdir(), 'palatial-security-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const blockedUrls = ['https://169.254.169.254/latest/meta-data/', 'https://127.0.0.1/photo.png', 'https://10.0.0.1/photo.png', 'https://[::1]/photo.png', 'https://localhost/photo.png', 'https://metadata.google.internal/computeMetadata/v1/', 'https://2130706433/', 'https://8.8.8.8/photo.png', 'https://0x7f000001/photo.png', 'https://0177.0.0.1/photo.png', 'https://127.1/photo.png', 'https://[::ffff:127.0.0.1]/photo.png', 'https://localhost./photo.png', 'https://metadata.google.internal./photo.png', 'https://foo.localhost/photo.png'];

test('UNC and device paths are rejected before any filesystem call', async t => {
  const dir = await temporary(t);
  const paths = ['\\\\attacker\\share\\a.jpg', '//attacker/share/a.jpg', '\\\\?\\C:\\a.jpg', '\\\\.\\pipe\\a.jpg'];
  for (const filename of paths) {
    let calls = 0;
    const client = api(async () => { calls++; return response({ dryRun: true }); });
    await assert.rejects(client.createAuto({ file_paths: [filename], dryRun: true }), error => {
      assert.notEqual(error.code, 'ENOENT');
      assert.match(error.message, /UNC or device/);
      return true;
    });
    assert.equal(calls, 0);
    await assert.rejects(client.createScene({ ...sceneInput, source_paths: [filename.replace(/a\.jpg$/, 'room.png')] }), /UNC or device/);
    await assert.rejects(client.downloadScene({ scene_id: sceneId, version, output_dir: filename }), /UNC or device/);
  }
  const photo = path.join(dir, 'photo.jpg');
  await writeFile(photo, 'photo');
  let body;
  const client = api(async (_url, options) => { body = options.body; return response({ selection: { mode: 'parametric' }, dryRun: true }); }, { receiptDir: dir });
  await client.createAuto({ file_paths: [photo], dryRun: true });
  assert.equal(await body.getAll('files')[0].text(), 'photo');
});

test('source URLs reject loopback, private, link-local, metadata and bare IP hosts', async t => {
  const dir = await temporary(t);
  for (const url of blockedUrls) {
    assert.equal(autoCreateSchema.safeParse({ source_urls: [url] }).success, false);
    assert.equal(createSceneSchema.safeParse({ ...sceneInput, sources: [{ filename: 'room.png', media_type: 'image/png', url }] }).success, false);
    let calls = 0;
    const client = api(async () => { calls++; return response({ dryRun: true }); }, { receiptDir: dir });
    await assert.rejects(client.createAuto({ source_urls: [url], dryRun: true }), error => { assert.doesNotMatch(error.message, /secret/); return true; });
    assert.equal(calls, 0);
  }
  const urls = ['https://media.example/photo.png', 'https://cdn.example/part.obj?x=1', 'https://cdn.example./photo.png'];
  let forwarded;
  const client = api(async (_url, options) => { forwarded = JSON.parse(options.body).urls; return response({ selection: {}, dryRun: true }); }, { receiptDir: dir });
  await client.createAuto({ source_urls: urls, dryRun: true });
  assert.deepEqual(forwarded, urls);
});

test('automatic create refuses symbolic links and still uploads a regular file', async t => {
  const dir = await temporary(t);
  const secret = path.join(dir, 'id_rsa');
  await writeFile(secret, 'PRIVATE-KEY');
  const link = path.join(dir, 'photo.jpg');
  await symlink(secret, link);
  let calls = 0;
  const client = api(async () => { calls++; return response({ dryRun: true }); }, { receiptDir: dir });
  await assert.rejects(client.createAuto({ file_paths: [link], dryRun: true }), /symbolic link/);
  assert.equal(calls, 0);
  const photo = path.join(dir, 'room.jpg');
  await writeFile(photo, 'room-photo');
  let text;
  const uploading = api(async (_url, options) => { text = await options.body.getAll('files')[0].text(); return response({ selection: {}, dryRun: true }); }, { receiptDir: dir });
  await uploading.createAuto({ file_paths: [photo], dryRun: true });
  assert.equal(text, 'room-photo');
});

test('automatic sources are capped at 32 entries and 4096 or 8192 characters', async () => {
  const paths = count => Array.from({ length: count }, (_, index) => `part-${index}.png`);
  const urls = count => Array.from({ length: count }, (_, index) => `https://media.example/part-${index}.png`);
  assert.equal(autoCreateSchema.safeParse({ file_paths: paths(32) }).success, true);
  assert.equal(autoCreateSchema.safeParse({ source_urls: urls(32) }).success, true);
  assert.equal(autoCreateSchema.safeParse({ file_paths: paths(16), source_urls: urls(16) }).success, true);
  assert.equal(autoCreateSchema.safeParse({ file_paths: paths(33) }).success, false);
  assert.equal(autoCreateSchema.safeParse({ source_urls: urls(33) }).success, false);
  assert.equal(autoCreateSchema.safeParse({ file_paths: paths(17), source_urls: urls(16) }).success, false);
  assert.equal(autoCreateSchema.safeParse({ file_paths: [`${'a'.repeat(4092)}.png`] }).success, true);
  assert.equal(autoCreateSchema.safeParse({ file_paths: [`${'a'.repeat(4093)}.png`] }).success, false);
  const prefix = 'https://media.example/';
  assert.equal(autoCreateSchema.safeParse({ source_urls: [prefix + 'a'.repeat(8192 - prefix.length)] }).success, true);
  assert.equal(autoCreateSchema.safeParse({ source_urls: [prefix + 'a'.repeat(8193 - prefix.length)] }).success, false);
  let calls = 0;
  const client = api(async () => { calls++; });
  await assert.rejects(client.createAuto({ file_paths: paths(33) }), error => { assert.notEqual(error.code, 'ENOENT'); assert.match(error.message, /32/); return true; });
  assert.equal(calls, 0);
});

test('scene source URLs drop credentials and fragments before the request', async () => {
  const secret = 'secret-token';
  const fragment = 'fragtoken';
  let calls = 0;
  const client = api(async () => { calls++; return response({ scene_id: sceneId }); });
  await assert.rejects(client.createScene({ ...sceneInput, sources: [{ filename: 'room.png', media_type: 'image/png', url: `https://user:${secret}@example.com/room.png#${fragment}` }] }), error => {
    assert.doesNotMatch(error.message, new RegExp(`${secret}|${fragment}|user:`));
    return true;
  });
  assert.equal(calls, 0);
  assert.equal(createSceneSchema.safeParse({ ...sceneInput, sources: [{ filename: 'room.png', media_type: 'image/png', url: 'https://user:pass@example.com/room.png#frag' }] }).success, false);
  let body;
  const allowed = api(async (_url, options) => { body = JSON.parse(options.body); return response({ scene_id: sceneId, status: 'running' }); });
  await allowed.createScene({ ...sceneInput, sources: [{ filename: 'room.png', media_type: 'image/png', url: 'https://example.com/room.png?x=1' }] });
  assert.equal(body.sources[0].url, 'https://example.com/room.png?x=1');
});

test('scene sources reject UNC paths and symbolic links, then upload a regular file', async t => {
  const dir = await temporary(t);
  let calls = 0;
  const client = api(async () => { calls++; return response({ scene_id: sceneId }); });
  await assert.rejects(client.createScene({ ...sceneInput, source_paths: ['\\\\attacker\\share\\room.png'] }), error => { assert.notEqual(error.code, 'ENOENT'); assert.match(error.message, /UNC or device/); return true; });
  assert.equal(calls, 0);
  const secret = path.join(dir, 'id_rsa');
  await writeFile(secret, 'PRIVATE-KEY');
  const link = path.join(dir, 'room.png');
  await symlink(secret, link);
  await assert.rejects(client.createScene({ ...sceneInput, source_paths: [link] }), /symbolic link/);
  assert.equal(calls, 0);
  const photo = path.join(dir, 'bench.png');
  await writeFile(photo, 'bench');
  let body;
  const uploading = api(async (_url, options) => { body = JSON.parse(options.body); return response({ scene_id: sceneId, status: 'running' }); });
  await uploading.createScene({ ...sceneInput, source_paths: [photo] });
  assert.equal(body.sources[0].base64, Buffer.from('bench').toString('base64'));
  assert.equal(body.sources[0].filename, 'bench.png');
});

test('scene receipts are read only when they are small regular files', { timeout: 10000 }, async t => {
  const dir = await temporary(t);
  const stem = `${sceneId}-scene-${version.slice(7, 19)}`;
  const out = path.join(dir, 'safe-out');
  await mkdir(out);
  const receiptPath = path.join(out, `${stem}-receipt.json`);
  const elsewhere = path.join(dir, 'real-receipt.json');
  const destination = path.join(out, `${stem}.zip`);
  await writeFile(destination, zip);
  await writeFile(elsewhere, JSON.stringify({ scene_id: sceneId, version, api_origin: 'https://dev.example', file: destination, sha256: version.slice(7), bytes: zip.length, extra: 'pwned' }));
  await symlink(elsewhere, receiptPath);
  const client = api(async () => { throw new Error('should not download'); });
  await assert.rejects(client.downloadScene({ scene_id: sceneId, version, output_dir: out }), /regular file/);
  await rm(receiptPath);
  const huge = await open(receiptPath, 'w');
  await huge.truncate(1024 * 1024);
  await huge.close();
  await assert.rejects(client.downloadScene({ scene_id: sceneId, version, output_dir: out }), /size limit/);
  await rm(receiptPath);
  if (process.platform !== 'win32') {
  const fifo = path.join(out, `${stem}-receipt.json`);
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  await assert.rejects(client.downloadScene({ scene_id: sceneId, version, output_dir: out }), /regular file/);
  await rm(fifo);
  }
  const fresh = path.join(dir, 'fresh');
  await mkdir(fresh);
  await writeFile(path.join(fresh, `${stem}-receipt.json`), '{not json');
  const downloading = api(async url => String(url).includes('/download') ? archiveResponse() : response({ download: { version } }));
  const result = await downloading.downloadScene({ scene_id: sceneId, version, output_dir: fresh });
  assert.equal(result.cached, false);
  assert.equal((await readFile(result.file)).length, zip.length);
  assert.ok(result.file.startsWith(path.resolve(fresh) + path.sep));
});

test('cached archives are hashed only after a regular-file and size check', async t => {
  const dir = await temporary(t);
  const stem = `${sceneId}-scene-${version.slice(7, 19)}`;
  const hugeDir = path.join(dir, 'huge');
  await mkdir(hugeDir);
  const hugeFile = path.join(hugeDir, `${stem}.zip`);
  const handle = await open(hugeFile, 'w');
  await handle.truncate(2 * 1024 * 1024);
  await handle.close();
  await writeFile(path.join(hugeDir, `${stem}-receipt.json`), JSON.stringify({ scene_id: sceneId, version, api_origin: 'https://dev.example', file: hugeFile, sha256: version.slice(7), bytes: 2 * 1024 * 1024 }));
  const limited = api(async () => { throw new Error('should not download'); }, { maxDownloadBytes: 1024 });
  await assert.rejects(limited.downloadScene({ scene_id: sceneId, version, output_dir: hugeDir }), /download limit/);
  const linkDir = path.join(dir, 'link');
  await mkdir(linkDir);
  const real = path.join(dir, 'real.zip');
  await writeFile(real, zip);
  const linked = path.join(linkDir, `${stem}.zip`);
  await symlink(real, linked);
  await writeFile(path.join(linkDir, `${stem}-receipt.json`), JSON.stringify({ scene_id: sceneId, version, api_origin: 'https://dev.example', file: linked, sha256: version.slice(7), bytes: zip.length, validation: 'attacker-claimed-valid' }));
  await assert.rejects(api(async () => { throw new Error('should not download'); }).downloadScene({ scene_id: sceneId, version, output_dir: linkDir }), /regular file/);
  const good = path.join(dir, 'good');
  const client = api(async url => String(url).includes('/download') ? archiveResponse() : response({ download: { version } }));
  const first = await client.downloadScene({ scene_id: sceneId, version, output_dir: good });
  assert.equal(first.cached, false);
  assert.equal(first.bytes, zip.length);
  const second = await client.downloadScene({ scene_id: sceneId, version, output_dir: good });
  assert.equal(second.cached, true);
  assert.equal(second.sha256, version.slice(7));
});

test('output directories reject symlinks and keep writes inside a real directory', async t => {
  const dir = await temporary(t);
  const outside = path.join(dir, 'outside');
  await mkdir(outside);
  const link = path.join(dir, 'linked');
  await symlink(outside, link);
  const client = api(async () => archiveResponse());
  await assert.rejects(client.downloadScene({ scene_id: sceneId, version, output_dir: link }), /symlink/);
  await assert.rejects(client.downloadScene({ scene_id: sceneId, version, output_dir: path.join(link, 'child') }), /symlink/);
  assert.deepEqual(await readdir(outside), []);
  const output = path.join(dir, 'real-out');
  const result = await client.downloadScene({ scene_id: sceneId, version, output_dir: output });
  assert.equal(result.cached, false);
  assert.equal(path.dirname(result.file), path.resolve(output));
  assert.ok((await realpath(result.file)).startsWith(await realpath(output) + path.sep));
  assert.deepEqual((await readdir(output)).sort(), [`${sceneId}-scene-${version.slice(7, 19)}-receipt.json`, `${sceneId}-scene-${version.slice(7, 19)}.zip`].sort());
});

test('a supplied scene version confirms with the server and returns only receipt fields', async t => {
  const dir = await temporary(t);
  const stem = `${sceneId}-scene-${version.slice(7, 19)}`;
  const output = path.join(dir, 'planted');
  await mkdir(output);
  const destination = path.join(output, `${stem}.zip`);
  await writeFile(destination, zip);
  await writeFile(path.join(output, `${stem}-receipt.json`), JSON.stringify({ scene_id: sceneId, version, api_origin: 'https://dev.example', file: destination, sha256: version.slice(7), bytes: zip.length, downloaded_at: '2026-10-15T00:00:00.000Z', validation: 'attacker-claimed-valid', extra: 'pwned' }));
  const calls = [];
  const mismatch = api(async url => { calls.push(String(url)); return response({ download: { version: `sha256:${'b'.repeat(64)}` } }); });
  await assert.rejects(mismatch.downloadScene({ scene_id: sceneId, version, output_dir: output }), /already exists/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes('/download'), false);
  const confirmed = [];
  const match = api(async url => { confirmed.push(String(url)); return response({ download: { version } }); });
  const result = await match.downloadScene({ scene_id: sceneId, version, output_dir: output });
  assert.equal(result.cached, true);
  assert.equal(result.extra, undefined);
  assert.equal(result.validation, 'not_inspected');
  assert.equal(result.simulator_acceptance, 'not_tested');
  assert.equal(result.sha256, version.slice(7));
  assert.equal(confirmed.some(url => url.includes('/download')), false);
});

test('setup resolves codex and claude from PATH and never from the working directory', async t => {
  const root = await temporary(t);
  const cwd = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  await mkdir(cwd);
  await mkdir(bin);
  await writeFile(path.join(cwd, process.platform === 'win32' ? 'codex.EXE' : 'codex'), 'planted');
  await writeFile(path.join(bin, process.platform === 'win32' ? 'codex.EXE' : 'codex'), 'real');
  const spawned = [];
  const setup = await runSetup({
    client: 'codex', executable: '/pkg/bin/palatial-agent.js', env: { PATH: `${cwd}${path.delimiter}${bin}` }, cwd,
    runner: command => { spawned.push(command); return { status: 0, stdout: 'registered', stderr: '' }; }
  });
  assert.deepEqual(spawned, [await realpath(path.join(bin, process.platform === 'win32' ? 'codex.EXE' : 'codex'))]);
  assert.equal(path.isAbsolute(spawned[0]), true);
  assert.equal(setup.failed, false);
  assert.equal(setup.output.results[0].registered, true);
  const planted = [];
  await symlink(path.join(cwd, process.platform === 'win32' ? 'codex.EXE' : 'codex'), path.join(bin, 'codex-link'));
  await rm(path.join(bin, process.platform === 'win32' ? 'codex.EXE' : 'codex'));
  await symlink(path.join(cwd, process.platform === 'win32' ? 'codex.EXE' : 'codex'), path.join(bin, process.platform === 'win32' ? 'codex.EXE' : 'codex'));
  const skipped = await runSetup({
    client: 'codex', executable: '/pkg/bin/palatial-agent.js', env: { PATH: bin }, cwd,
    runner: command => { planted.push(command); return { status: 0, stdout: '', stderr: '' }; }
  });
  assert.deepEqual(planted, []);
  assert.equal(skipped.failed, true);
  assert.match(skipped.output.results[0].message, /PATH/);
  const dry = await runSetup({ client: 'codex', executable: '/pkg/bin/palatial-agent.js', dryRun: true, env: { PATH: bin }, cwd });
  assert.equal(dry.output.commands[0].command, 'codex');
});

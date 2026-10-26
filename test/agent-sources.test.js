import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { uploadAgentSource, submitAgentWithFiles } from '../src/agent-sources.js';

async function fixture(t, { storageHost = `${'a'.repeat(32)}.r2.cloudflarestorage.com`, mutate = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'palatial-agent-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'cabinet.mp4');
  const bytes = Buffer.alloc(8 * 1024 ** 2 + 16, 7);
  await writeFile(filename, bytes);
  const assetId = '333333333333333333333333';
  const key = `uploads/projects/${assetId}/uploads/cabinet.mp4`;
  const calls = [];
  const client = {
    autoTimeoutMs: 1000,
    async request(route, options) {
      calls.push({ route, ...options });
      if (route.endsWith('/init')) return { key, uploadId: 'upload-1', completionToken: 'token-1' };
      if (route.endsWith('/sign-parts')) return { signedUrls: [`https://${storageHost}/bucket/file?part=${options.body.partNumbers[0]}&signature=private`] };
      return { attachment: { id: 'cabinet.mp4', name: 'cabinet.mp4', kind: 'video', mimeType: 'video/mp4', bytesInAsset: true } };
    },
    async fetch(url, options) {
      calls.push({ storage: true, url: String(url), ...options });
      if (mutate) await writeFile(filename, Buffer.alloc(bytes.length, 9));
      return new Response('', { status: 200, headers: { etag: `part-${calls.length}` } });
    }
  };
  return { client, filename, assetId, calls, bytes };
}

test('source upload chunks only the explicit file and returns native attachment metadata', async t => {
  const f = await fixture(t);
  const result = await uploadAgentSource(f.client, { asset_id: f.assetId, file_path: f.filename });
  assert.equal(result.attachment.bytesInAsset, true);
  const uploads = f.calls.filter(call => call.storage);
  assert.deepEqual(uploads.map(call => call.body.length), [8 * 1024 ** 2, 16]);
  for (const upload of uploads) {
    assert.equal(upload.redirect, 'error');
    assert.equal(upload.headers, undefined);
  }
  const complete = f.calls.at(-1);
  assert.match(complete.route, /\/sources\/complete$/);
  assert.equal(complete.body.completionToken, 'token-1');
  assert.equal(complete.body.sizeBytes, f.bytes.length);
  assert.deepEqual(complete.body.parts.map(part => part.partNumber), [1, 2]);
});
test('source upload refuses storage redirects to foreign hosts without disclosing bytes', async t => {
  const f = await fixture(t, { storageHost: 'example.com' });
  await assert.rejects(uploadAgentSource(f.client, { asset_id: f.assetId, file_path: f.filename }), /outside Palatial object storage/);
  assert.equal(f.calls.filter(call => call.storage).length, 0);
  assert.equal(f.calls.some(call => call.route?.endsWith('/complete')), false);
});
test('a changed source never finalizes and upload is not automatically retried', async t => {
  const f = await fixture(t, { mutate: true });
  await assert.rejects(uploadAgentSource(f.client, { asset_id: f.assetId, file_path: f.filename }), /changed during upload/);
  assert.equal(f.calls.filter(call => call.route?.endsWith('/init')).length, 1);
  assert.equal(f.calls.some(call => call.route?.endsWith('/complete')), false);
});
test('source upload refuses symlinks and unsupported files before allocating storage', async t => {
  const f = await fixture(t);
  await assert.rejects(uploadAgentSource(f.client, { asset_id: f.assetId, file_path: path.join(path.dirname(f.filename), 'a.webm') }), /Unsupported/);
  const link = path.join(path.dirname(f.filename), 'linked.mp4');
  await symlink(f.filename, link);
  await assert.rejects(uploadAgentSource(f.client, { asset_id: f.assetId, file_path: link }), /symbolic link/);
  assert.equal(f.calls.length, 0);
});


test('file intents generate one identity per call and share it through reservation and final submission', async t => {
  const f = await fixture(t);
  const originalRequest = f.client.request;
  const reservations = [], intents = [];
  f.client.base = new URL('https://dashboard.dev.palatial.cloud/api/v1/external/');
  f.client.apiKey = 'fixture-key';
  f.client.receiptDir = path.join(path.dirname(f.filename), 'receipts');
  f.client.request = async (route, options) => {
    if (route === 'agent/sources') { reservations.push(options.body); return { assetId: f.assetId }; }
    return originalRequest(route, options);
  };
  f.client.startAgentTurn = async input => { intents.push(input); return { id: input.requestId }; };
  const input = Object.freeze({ message: 'Build this cabinet.', files: Object.freeze([f.filename]) });
  await submitAgentWithFiles(f.client, input);
  await submitAgentWithFiles(f.client, input);
  assert.equal(intents.length, 2);
  assert.equal(reservations.length, 2);
  assert.notEqual(intents[0].requestId, intents[1].requestId);
  for (let i = 0; i < 2; i++) assert.equal(reservations[i].requestId, intents[i].requestId);
  assert.equal(Object.hasOwn(input, 'requestId'), false);
  const uploaded = f.calls.filter(call => call.route?.endsWith('/sources/init')).length;
  await submitAgentWithFiles(f.client, { ...input, requestId: intents[0].requestId });
  assert.deepEqual(intents[2], intents[0]);
  assert.equal(reservations.length, 2);
  assert.equal(f.calls.filter(call => call.route?.endsWith('/sources/init')).length, uploaded);
});

async function intentFixture(t) {
  const f = await fixture(t);
  const request = f.client.request;
  f.intents = [];
  f.client.base = new URL('https://dashboard.dev.palatial.cloud/api/v1/external/');
  f.client.apiKey = 'fixture-key';
  f.client.receiptDir = path.join(path.dirname(f.filename), 'receipts');
  f.client.request = async (route, options) => {
    if (route === 'agent/sources') { f.calls.push({ route, ...options }); return { assetId: f.assetId }; }
    return request(route, options);
  };
  f.client.startAgentTurn = async input => { f.intents.push(input); return { id: input.requestId }; };
  f.file = async (name, size = 16) => {
    const filename = path.join(path.dirname(f.filename), name);
    await writeFile(filename, Buffer.alloc(size, 7));
    return filename;
  };
  return f;
}

test('small photos go with intent without reserving a project or uploading', async t => {
  const f = await intentFixture(t);
  const files = await Promise.all(['front.png', 'back.JPG', 'side.jpeg', 'detail.webp'].map(name => f.file(name)));
  const input = Object.freeze({ requestId: 'small-photos', message: 'Build this bin.', files: Object.freeze(files) });
  await submitAgentWithFiles(f.client, input);
  assert.equal(f.calls.length, 0);
  assert.equal(Object.hasOwn(f.intents[0], 'assetId'), false);
  assert.deepEqual(f.intents[0].attachments.map(a => a.inlineData.mimeType), ['image/png', 'image/jpeg', 'image/jpeg', 'image/webp']);
  for (const a of f.intents[0].attachments) assert.deepEqual(Buffer.from(a.inlineData.data, 'base64'), Buffer.alloc(16, 7));
  assert.equal(Object.hasOwn(input, 'attachments'), false);
});

test('mixed files retain verified uploads and preserve an existing project', async t => {
  const f = await intentFixture(t);
  const files = await Promise.all([f.file('small.png'), f.file('large.png', 2 * 1024 ** 2 + 1), f.file('part.glb')]);
  await submitAgentWithFiles(f.client, { requestId: 'mixed', assetId: f.assetId, message: 'Use these sources.', files });
  assert.equal(f.calls.some(c => c.route === 'agent/sources'), false);
  assert.equal(f.calls.filter(c => c.route?.endsWith('/init')).length, 2);
  assert.equal(f.calls.filter(c => c.route?.endsWith('/complete')).length, 2);
  assert.equal(f.intents[0].assetId, f.assetId);
  assert.equal(f.intents[0].attachments[0].kind, 'image');
  assert.equal(f.intents[0].attachments.filter(a => a.bytesInAsset).length, 2);
});

test('inline count and combined byte budgets include supplied attachments', async t => {
  const f = await intentFixture(t);
  const photo = await f.file('limit.png', 2 * 1024 ** 2);
  const existing = { name: 'existing.png', inlineData: { mimeType: 'image/png', data: Buffer.alloc(2 * 1024 ** 2).toString('base64') } };
  await submitAgentWithFiles(f.client, { requestId: 'byte-budget', message: 'Use all views.', attachments: [existing], files: Array(6).fill(photo) });
  const attachments = f.intents[0].attachments;
  assert.deepEqual(attachments[0], existing);
  assert.equal(attachments.filter(a => a.inlineData).length, 6);
  assert.equal(attachments.filter(a => a.bytesInAsset).length, 1);
  assert.equal(f.calls.filter(c => c.route === 'agent/sources').length, 1);
  const tiny = await f.file('tiny.webp');
  await submitAgentWithFiles(f.client, { requestId: 'count-budget', message: 'Use every view.', attachments: Array(7).fill(existing), files: [tiny] });
  // Existing invalid inputs remain the server's refusal; the client does not add to an exceeded budget.
  assert.equal(f.intents[1].attachments.at(-1).bytesInAsset, true);
  await submitAgentWithFiles(f.client, { requestId: 'count-limit', message: 'Use every view.', files: Array(9).fill(tiny) });
  assert.equal(f.intents[2].attachments.filter(a => a.inlineData).length, 8);
  assert.equal(f.intents[2].attachments.filter(a => a.bytesInAsset).length, 1);
});

test('inline response-loss replay retains more than one MiB of exact input and rejects changed files', async t => {
  const f = await intentFixture(t);
  const filename = await f.file('boundary.png', 2 * 1024 ** 2);
  const input = { requestId: 'inline-replay', message: 'Build this bin.', files: [filename] };
  let lose = true;
  f.client.startAgentTurn = async prepared => {
    f.intents.push(prepared);
    if (lose) { lose = false; throw new Error('response lost'); }
    return { id: 'same-turn', replayed: true };
  };
  await assert.rejects(submitAgentWithFiles(f.client, input), /response lost/);
  assert.equal((await submitAgentWithFiles(f.client, input)).replayed, true);
  assert.deepEqual(f.intents[0], f.intents[1]);
  assert.equal(f.calls.length, 0);
  await writeFile(filename, Buffer.alloc(2 * 1024 ** 2, 9));
  await assert.rejects(submitAgentWithFiles(f.client, input), /different intent or source bytes/);
  assert.equal(f.intents.length, 2);
});

test('changed inline photos in mixed submissions are refused before intent', async t => {
  const f = await intentFixture(t);
  const photo = await f.file('front.png');
  const request = f.client.request;
  f.client.request = async (route, options) => {
    if (route === 'agent/sources') await writeFile(photo, Buffer.alloc(16, 9));
    return request(route, options);
  };
  await assert.rejects(submitAgentWithFiles(f.client, { message: 'Build it.', files: [photo, f.filename] }), /source changed before submission/);
  assert.equal(f.intents.length, 0);
});

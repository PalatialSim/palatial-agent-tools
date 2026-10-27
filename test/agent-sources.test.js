import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, symlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { uploadAgentSource, submitAgentWithFiles, agentMultipart } from '../src/agent-sources.js';

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
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      calls.push({ storage: true, url: String(url), ...options, body: Buffer.concat(chunks) });
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
    assert.equal(upload.headers['x-api-key'], undefined);
    assert.equal(upload.headers['Content-Length'], String(upload.body.length));
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


async function intentFixture(t) {
  const f = await fixture(t);
  const request = f.client.request;
  f.intents = [];
  f.routes = [];
  f.client.base = new URL('https://dashboard.dev.palatial.cloud/api/v1/external/');
  f.client.apiKey = 'fixture-key';
  f.client.receiptDir = path.join(path.dirname(f.filename), 'receipts');
  f.client.request = async (route, options) => {
    if (route === 'agent/sources') { f.calls.push({ route, ...options }); return { assetId: f.assetId }; }
    if (route === 'agent' || /^assets\/[^/]+\/agent$/.test(route)) {
      f.routes.push(route);
      if (options.uploadBody) {
        const chunks = [];
        for await (const chunk of options.uploadBody.body) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        assert.equal(bytes.length, options.uploadBody.length);
        f.intents.push({ bytes, contentType: options.uploadBody.contentType });
      } else f.intents.push(options.body);
      return { id: 'same-turn', replayed: !options.uploadBody };
    }
    return request(route, options);
  };
  f.client.startAgentTurn = async input => { f.intents.push(input); return { id: 'same-turn', replayed: true }; };
  f.file = async (name, size = 16) => {
    const filename = path.join(path.dirname(f.filename), name);
    await writeFile(filename, Buffer.alloc(size, 7));
    return filename;
  };
  return f;
}

function multipartRequest(bytes) {
  const text = bytes.toString();
  return JSON.parse(text.slice(text.indexOf('\r\n\r\n') + 4, text.indexOf('\r\n--', text.indexOf('\r\n\r\n') + 4)));
}

test('one POST carries mixed files, preserves existing project and uses manifest-only replay', async t => {
  const f = await intentFixture(t);
  const files = await Promise.all([f.file('front.png'), f.file('part.glb'), f.file('clip.mp4')]);
  const input = Object.freeze({ requestId: 'mixed', assetId: f.assetId, message: 'Build this bin.', files: Object.freeze(files) });
  await submitAgentWithFiles(f.client, input);
  assert.equal(f.calls.length, 0);
  const request = multipartRequest(f.intents[0].bytes);
  assert.equal(request.assetId, undefined);
  assert.deepEqual(request.files.map(file => [file.part, file.originalName, file.kind, file.sizeBytes]), [['file0', 'front.png', 'image', 16], ['file1', 'part.glb', 'cad', 16], ['file2', 'clip.mp4', 'video', 16]]);
  assert.equal(request.attachments, undefined);
  assert.match(f.intents[0].contentType, /^multipart\/form-data; boundary=/);
  assert.equal((await submitAgentWithFiles(f.client, input)).replayed, true);
  assert.deepEqual(f.intents[1], { ...request, files: request.files.map(({ part, ...file }) => file) });
  assert.deepEqual(f.routes, [`assets/${f.assetId}/agent`, `assets/${f.assetId}/agent`]);
  const receipts = await readdir(f.client.receiptDir);
  const receipt = await readFile(path.join(f.client.receiptDir, receipts[0]), 'utf8');
  assert.equal(receipt.includes('inlineData'), false);
  assert.ok(receipt.length < 4096);
  assert.equal(Object.hasOwn(input, 'attachments'), false);
});

test('omitting identity creates fresh requests and leaves caller input unchanged', async t => {
  const f = await intentFixture(t);
  const input = Object.freeze({ message: 'Use this clip.', files: Object.freeze([f.filename]) });
  await submitAgentWithFiles(f.client, input);
  await submitAgentWithFiles(f.client, input);
  assert.notEqual(multipartRequest(f.intents[0].bytes).requestId, multipartRequest(f.intents[1].bytes).requestId);
  assert.equal(Object.hasOwn(input, 'requestId'), false);
});

test('lost multipart response recovers through small manifest without retransmitting bytes', async t => {
  const f = await intentFixture(t);
  const request = f.client.request;
  let lost = true;
  f.client.request = async (route, options) => {
    const result = await request(route, options);
    if (options.uploadBody && lost) { lost = false; throw new Error('response lost'); }
    return result;
  };
  const input = { requestId: 'recover', message: 'Build it.', files: [f.filename] };
  assert.equal((await submitAgentWithFiles(f.client, input)).replayed, true);
  assert.equal(f.intents.filter(intent => intent.bytes).length, 1);
  assert.equal(f.intents[1].files[0].originalName, 'cabinet.mp4');
  assert.ok(JSON.stringify(f.intents[1]).length < 1024);
  await writeFile(f.filename, Buffer.alloc(f.bytes.length, 9));
  await assert.rejects(submitAgentWithFiles(f.client, input), /different intent or source bytes/);
  assert.equal(f.intents.length, 2);
});

test('missing bytes permits exactly one retransmission and another lost response returns to caller', async t => {
  const f = await intentFixture(t);
  let uploads = 0, manifests = 0;
  f.client.request = async (_route, options) => {
    if (options.uploadBody) { uploads++; throw new Error('connection lost'); }
    manifests++;
    throw Object.assign(new Error('bytes required'), { code: 'AGENT_SOURCE_BYTES_REQUIRED', http_status: 400 });
  };
  await assert.rejects(submitAgentWithFiles(f.client, { requestId: 'missing', message: 'Build it.', files: [f.filename] }), /connection lost/);
  assert.equal(uploads, 2);
  assert.equal(manifests, 1);
});

test('definitive native conflict never retransmits files', async t => {
  const f = await intentFixture(t);
  let count = 0;
  f.client.request = async () => { count++; throw Object.assign(new Error('conflict'), { code: 'REQUEST_ID_CONFLICT', http_status: 409 }); };
  await assert.rejects(submitAgentWithFiles(f.client, { requestId: 'conflict', message: 'Build it.', files: [f.filename] }), /conflict/);
  assert.equal(count, 1);
});

test('large inputs use internal parts and retry only the small stored request', async t => {
  const f = await intentFixture(t);
  const large = path.join(path.dirname(f.filename), 'large.mp4');
  const handle = await open(large, 'w');
  await handle.truncate(64 * 1024 ** 2 + 1);
  await handle.close();
  const input = { requestId: 'large', message: 'Build it.', files: [large] };
  await submitAgentWithFiles(f.client, input);
  assert.equal(f.calls.filter(call => call.route === 'agent/sources').length, 1);
  assert.equal(f.calls.filter(call => call.storage).length, 9);
  assert.equal(f.intents[0].attachments[0].bytesInAsset, true);
  const before = f.calls.length;
  await submitAgentWithFiles(f.client, input);
  assert.equal(f.calls.length, before);
  const { assetId, ...stored } = f.intents[0];
  assert.equal(assetId, f.assetId);
  assert.deepEqual(f.intents[1], stored);
  assert.deepEqual(f.routes, [`assets/${f.assetId}/agent`]);
});

test('legacy inline receipts replay their exact old JSON and reject changed files', async t => {
  const f = await intentFixture(t);
  const filename = await f.file('front.png');
  const input = { requestId: 'legacy', message: 'Build it.', files: [filename] };
  const { createHash } = await import('node:crypto');
  const { digestRegularFile } = await import('../src/input-guards.js');
  const sources = [{ path: filename, ...await digestRegularFile(filename, 1024) }];
  const intent = { requestId: input.requestId, message: input.message };
  const fingerprint = createHash('sha256').update(JSON.stringify({ intent, sources })).digest('hex');
  const owner = createHash('sha256').update(JSON.stringify([f.client.base.href, f.client.apiKey, input.requestId])).digest('hex');
  const old = { ...intent, attachments: [{ name: 'front.png', kind: 'image', inlineData: { mimeType: 'image/png', data: Buffer.alloc(16, 7).toString('base64') } }] };
  const { mkdir } = await import('node:fs/promises');
  await mkdir(f.client.receiptDir);
  await writeFile(path.join(f.client.receiptDir, `agent-source-intent-${owner}.json`), JSON.stringify({ fingerprint, input: old }));
  await submitAgentWithFiles(f.client, input);
  assert.deepEqual(f.intents, [old]);
});

test('multipart refuses changed file bytes before sending its file part', async t => {
  const f = await intentFixture(t);
  const { digestRegularFile } = await import('../src/input-guards.js');
  const source = { path: f.filename, ...await digestRegularFile(f.filename, 1024 ** 3) };
  const multipart = agentMultipart({ requestId: 'changed', message: 'Build it.' }, [source]);
  await writeFile(f.filename, Buffer.alloc(source.size, 9));
  let chunks = 0;
  await assert.rejects(async () => { for await (const _chunk of multipart.uploadBody.body) chunks++; }, /changed before submission/);
  assert.equal(chunks, 1);
});

test('a file above 1 GiB is refused before allocation or network transfer', async t => {
  const f = await intentFixture(t);
  const filename = path.join(path.dirname(f.filename), 'oversized.step');
  const handle = await open(filename, 'w');
  await handle.truncate(1024 ** 3 + 1);
  await handle.close();
  await assert.rejects(submitAgentWithFiles(f.client, { requestId: 'too-large', message: 'Build it.', files: [filename] }), /above the byte limit/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.intents.length, 0);
});

test('existing metadata attachments accompany multipart and digest replay without changing their identity', async t => {
  const f = await intentFixture(t);
  const existing = { name: 'owned.png', kind: 'image', mimeType: 'image/png', bytesInAsset: true };
  const input = { requestId: 'existing', assetId: f.assetId, message: 'Use these files.', attachments: [existing], files: [f.filename] };
  await submitAgentWithFiles(f.client, input);
  await submitAgentWithFiles(f.client, input);
  assert.deepEqual(multipartRequest(f.intents[0].bytes).attachments, [existing]);
  assert.deepEqual(f.intents[1].attachments, [existing]);
});

test('a failed storage part retries only that part with the same signed destination', async t => {
  const f = await fixture(t);
  const fetch = f.client.fetch;
  let failed = false;
  f.client.fetch = async (url, options) => {
    const response = await fetch(url, options);
    if (!failed) { failed = true; return new Response('', { status: 503 }); }
    return response;
  };
  await uploadAgentSource(f.client, { asset_id: f.assetId, file_path: f.filename });
  const transfers = f.calls.filter(call => call.storage);
  assert.equal(transfers.length, 3);
  assert.equal(transfers[0].url, transfers[1].url);
  assert.equal(transfers[0].body.length, transfers[1].body.length);
  assert.equal(f.calls.filter(call => call.route?.endsWith('/init')).length, 1);
});

test('Node fetch sends the multipart stream over HTTP with the declared byte count', async t => {
  const { createServer } = await import('node:http');
  const { PalatialClient } = await import('../src/client.js');
  const f = await intentFixture(t);
  let received;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = Buffer.concat(chunks);
    assert.equal(received.length, Number(req.headers['content-length']));
    assert.equal(req.headers['x-api-key'], 'fixture-key');
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'http-turn' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new PalatialClient({ apiKey: 'fixture-key', baseUrl: `http://127.0.0.1:${server.address().port}/api/v1/external/`, allowHttpForTests: true, receiptDir: f.client.receiptDir });
  const photo = await f.file('front.png');
  assert.equal((await client.startAgentWithFiles({ requestId: 'http', message: 'Build it.', files: [photo] })).id, 'http-turn');
  assert.equal(multipartRequest(received).files[0].originalName, 'front.png');
});

test('hidden storage PUT keeps progressing beyond 30 seconds without a whole-transfer deadline', async t => {
  const f = await fixture(t);
  await writeFile(f.filename, Buffer.alloc(3 * 64 * 1024, 7));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let chunks = 0;
  f.client.fetch = async (_url, options) => {
    assert.equal(options.duplex, 'half');
    for await (const chunk of options.body) {
      assert.ok(Buffer.isBuffer(chunk));
      chunks++;
      t.mock.timers.tick(20000);
      assert.equal(options.signal.aborted, false);
    }
    return new Response('', { headers: { etag: 'part-etag' } });
  };
  await uploadAgentSource(f.client, { asset_id: f.assetId, file_path: f.filename });
  assert.equal(chunks, 3);
  assert.equal(f.calls.filter(call => call.route?.endsWith('/init')).length, 1);
  assert.equal(f.calls.filter(call => call.route?.endsWith('/complete')).length, 1);
});


test('MP4 and MOV above 300 MiB are refused before hashing, receipts, or network on both transports', async t => {
  const f = await intentFixture(t);
  for (const extension of ['.mp4', '.MOV']) {
    const filename = path.join(path.dirname(f.filename), `too-large${extension}`);
    const handle = await open(filename, 'w');
    await handle.truncate(300 * 1024 ** 2 + 1);
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const reading = t.mock.method(prototype, 'read', () => { throw new Error('Oversized videos must not be hashed.'); });
    const expected = error => error.code === 'AGENT_VIDEO_TOO_LARGE' && /300 MiB \(314572800 bytes\).*Mad Max/.test(error.message);
    await assert.rejects(uploadAgentSource(f.client, { asset_id: f.assetId, file_path: filename }), expected);
    await assert.rejects(submitAgentWithFiles(f.client, { requestId: 'too-large-video', message: 'Build it.', files: [filename] }), expected);
    assert.equal(reading.mock.callCount(), 0);
    reading.mock.restore();
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.intents.length, 0);
  await assert.rejects(readdir(f.client.receiptDir), error => error.code === 'ENOENT');
});

test('a non-video larger than 300 MiB retains resumable transport and the 1 GiB budget', async t => {
  const f = await intentFixture(t);
  const filename = path.join(path.dirname(f.filename), 'large.step');
  const handle = await open(filename, 'w');
  await handle.truncate(300 * 1024 ** 2 + 1);
  await handle.close();
  const reachedTransport = new Error('Reached supported resumable transport.');
  f.client.request = async route => { f.calls.push({route}); throw reachedTransport; };
  await assert.rejects(submitAgentWithFiles(f.client, { requestId: 'large-cad', message: 'Use this CAD.', files: [filename] }), error => error === reachedTransport);
  assert.equal(f.calls[0].route, 'agent/sources');
});

test('manual multipart metadata accepts the exact video cap and refuses one byte more', () => {
  const source = { path: '/explicit/clip.mp4', size: 300 * 1024 ** 2, sha256: 'a'.repeat(64) };
  assert.equal(agentMultipart({ message: 'Use this clip.' }, [source]).manifest.files[0].sizeBytes, source.size);
  assert.throws(() => agentMultipart({ message: 'Use this clip.' }, [{...source,size:source.size+1}]), error => error.code === 'AGENT_VIDEO_TOO_LARGE');
});

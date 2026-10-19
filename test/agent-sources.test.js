import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { uploadAgentSource } from '../src/agent-sources.js';

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

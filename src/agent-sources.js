import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { assertLocalPath, assertPublicHttpsUrl, digestHandle, digestRegularFile, openRegularFile, readCappedRegularFile, resolveOutputDirectory, assertResolvedDirectory } from './input-guards.js';

export const agentSourceUploadSchema = z.object({
  asset_id: z.string().regex(/^[a-fA-F0-9]{24}$/),
  file_path: z.string().min(1).describe('Explicit local image, CAD/3D or MP4/MOV source to upload to this unpaid project. Uploading alone never submits generation.')
}).strict();
const extensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.glb', '.gltf', '.obj', '.stl', '.ply', '.fbx', '.dae', '.3ds', '.step', '.stp', '.iges', '.igs', '.usd', '.usdz', '.mp4', '.mov']);

/** Transport bytes only: the server owns source admission and the Agent owns intent. */
export async function uploadAgentSource(client, input) {
  const p = agentSourceUploadSchema.parse(input);
  assertLocalPath(p.file_path);
  const ext = path.extname(p.file_path).toLowerCase();
  if (!extensions.has(ext)) throw new Error('Unsupported Agent source file type.');
  const filename = path.basename(p.file_path);
  if (filename.length > 240 || filename.includes('..') || /[\\/\x00-\x1f]/.test(filename)) throw new Error('Use a plain source filename.');
  const opened = await openRegularFile(p.file_path);
  try {
    const bytes = opened.info.size;
    const limit = ['.mp4', '.mov'].includes(ext) ? 300 * 1024 ** 2 : 256 * 1024 ** 2;
    if (bytes < 1 || bytes > limit) throw new Error(`Agent source must be a nonempty file at most ${limit} bytes.`);
    const digest = await digestHandle(opened.handle, bytes);
    const route = `agent/assets/${p.asset_id}/sources`;
    const upload = await client.request(`${route}/init`, { method: 'POST', structuredErrors: true, body: { fileName: filename, sizeBytes: bytes } });
    if (typeof upload.key !== 'string' || !upload.key.startsWith(`uploads/projects/${p.asset_id}/uploads/`) ||
        typeof upload.uploadId !== 'string' || !upload.uploadId || typeof upload.completionToken !== 'string' || !upload.completionToken) throw new Error('Invalid source upload receipt. Inspect the project before retrying.');
    const parts = [];
    const chunkSize = 8 * 1024 ** 2;
    for (let offset = 0, partNumber = 1; offset < bytes; offset += chunkSize, partNumber++) {
      const signed = await client.request(`${route}/sign-parts`, { method: 'POST', structuredErrors: true, body: { key: upload.key, uploadId: upload.uploadId, partNumbers: [partNumber] } });
      if (!Array.isArray(signed.signedUrls) || signed.signedUrls.length !== 1) throw new Error('Invalid source upload part receipt.');
      const url = new URL(assertPublicHttpsUrl(signed.signedUrls[0]));
      if (!/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(url.hostname)) throw new Error('Source upload URL is outside Palatial object storage.');
      const buffer = Buffer.alloc(Math.min(chunkSize, bytes - offset));
      const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead !== buffer.length) throw new Error('Source file changed during upload.');
      // Never send the API key to storage, follow redirects or retry a mutation.
      const response = await client.fetch(url, { method: 'PUT', body: buffer, redirect: 'error', signal: AbortSignal.timeout(client.autoTimeoutMs) });
      if (!response.ok) throw new Error(`Source upload failed (HTTP ${response.status}). Inspect the project before retrying.`);
      const eTag = response.headers.get('etag');
      if (!eTag) throw new Error('Source upload returned no part identity.');
      parts.push({ eTag, partNumber });
    }
    const finalInfo = await opened.handle.stat();
    if (finalInfo.size !== bytes || await digestHandle(opened.handle, bytes) !== digest) throw new Error('Source file changed during upload; no source was finalized.');
    return await client.request(`${route}/complete`, { method: 'POST', structuredErrors: true, body: { key: upload.key, uploadId: upload.uploadId, completionToken: upload.completionToken, sizeBytes: bytes, parts } });
  } finally { await opened.handle.close(); }
}


/** Preserve the exact admitted source identities before intent POST, including response-loss replay. */
export async function submitAgentWithFiles(client, input) {
  const { files, ...submittedIntent } = input;
  // One source operation shares a fresh identity across reservation and intent.
  // Never mutate the caller's object: another call without an ID is new work.
  const intent = { ...submittedIntent, requestId: submittedIntent.requestId ?? randomUUID() };
  if (files.length + (intent.attachments?.length || 0) > 50) throw new Error('At most 50 source attachments and files combined.');
  const sources = [];
  for (const filename of files) {
    assertLocalPath(filename);
    const ext = path.extname(filename).toLowerCase();
    if (!extensions.has(ext)) throw new Error('Unsupported Agent source file type.');
    const max = ['.mp4', '.mov'].includes(ext) ? 300 * 1024 ** 2 : 256 * 1024 ** 2;
    const identity = await digestRegularFile(filename, max);
    if (identity.size < 1) throw new Error('Agent source must be nonempty.');
    sources.push({ path: path.resolve(filename), ...identity });
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ intent, sources })).digest('hex');
  const owner = createHash('sha256').update(JSON.stringify([client.base.href, client.apiKey, intent.requestId])).digest('hex');
  const directory = await resolveOutputDirectory(client.receiptDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertResolvedDirectory(directory);
  const receipt = path.join(directory, `agent-source-intent-${owner}.json`);
  const replay = async () => {
    const bytes = await readCappedRegularFile(receipt, 1024 * 1024);
    if (!bytes) return undefined;
    const saved = JSON.parse(bytes.toString('utf8'));
    if (saved.fingerprint !== fingerprint) throw new Error('Request ID already has different intent or source bytes. Preserve the original request and inspect its receipt.');
    return saved.input;
  };
  const prior = await replay();
  if (prior) return client.startAgentTurn(prior);
  const lock = await open(`${receipt}.lock`, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('This source intent is already being prepared. Preserve request_id and inspect its local receipt before retrying.');
    throw error;
  });
  try {
    const raced = await replay();
    if (raced) return await client.startAgentTurn(raced);
    let assetId = intent.assetId;
    if (!assetId) {
      const reserved = await client.request('agent/sources', { method: 'POST', structuredErrors: true, body: { requestId: intent.requestId } });
      if (typeof reserved.assetId !== 'string' || !/^[a-f0-9]{24}$/i.test(reserved.assetId)) throw new Error('Native source reservation returned no asset identity. Preserve request_id.');
      assetId = reserved.assetId;
    }
    const attachments = [...(intent.attachments || [])];
    for (const source of sources) {
      if (JSON.stringify(await digestRegularFile(source.path, source.size)) !== JSON.stringify({ size: source.size, sha256: source.sha256 })) throw new Error('A source changed before upload.');
      const uploaded = await uploadAgentSource(client, { asset_id: assetId, file_path: source.path });
      if (!uploaded?.attachment?.bytesInAsset) throw new Error('Native upload returned no stored source attachment.');
      attachments.push(uploaded.attachment);
    }
    const prepared = { ...intent, assetId, attachments };
    const handle = await open(receipt, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ fingerprint, input: prepared }) + '\n'); }
    finally { await handle.close(); }
    return await client.startAgentTurn(prepared);
  } finally {
    await lock.close();
    await unlink(`${receipt}.lock`).catch(() => {});
  }
}

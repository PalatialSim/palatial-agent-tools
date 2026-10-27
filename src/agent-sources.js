import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, unlink, rename } from 'node:fs/promises';
import { z } from 'zod';
import { progressUpload } from './upload-progress.js';
import { agentFileMaxBytes, assertAgentFileSize } from './agent-file-limits.js';
export { agentFileMaxBytes } from './agent-file-limits.js';
import { assertLocalPath, assertPublicHttpsUrl, digestHandle, digestRegularFile, openRegularFile, readCappedRegularFile, resolveOutputDirectory, assertResolvedDirectory } from './input-guards.js';

// An existing asset is addressed by path; the body carries only the message and optional extras.
export function agentTurnRoute(body) {
  if (body.assetId === undefined) return { route: 'agent', body };
  const { assetId, ...rest } = body;
  return { route: `assets/${encodeURIComponent(assetId)}/agent`, body: rest };
}

export const agentSourceUploadSchema = z.object({
  asset_id: z.string().regex(/^[a-fA-F0-9]{24}$/),
  file_path: z.string().min(1).describe('Explicit local image, CAD/3D or MP4/MOV source. Videos must be at most 300 MiB, the current Mad Max processing limit; other files at most 1 GiB. Uploading alone never submits generation.')
}).strict();
const extensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.glb', '.gltf', '.obj', '.stl', '.ply', '.fbx', '.dae', '.3ds', '.step', '.stp', '.iges', '.igs', '.usd', '.usdz', '.mp4', '.mov', '.pdf', '.txt']);
const mimeTypes = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.mp4', 'video/mp4'], ['.mov', 'video/quicktime'], ['.glb', 'model/gltf-binary'], ['.pdf', 'application/pdf'], ['.txt', 'text/plain']]);
const multipartMaxBytes = 64 * 1024 ** 2;
// Legacy receipts can include the full 12 MiB inline budget encoded as base64.
const intentReceiptMaxBytes = 20 * 1024 ** 2;

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
    assertAgentFileSize({ originalName: filename, sizeBytes: bytes });
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
      // A signed PUT addresses one immutable part: only that part may be retried.
      let response;
      for (let attempt = 0; attempt < 2; attempt++) {
        const body = async function* () {
          for (let offset = 0; offset < buffer.length; offset += 64 * 1024) yield buffer.subarray(offset, offset + 64 * 1024);
        };
        const transfer = progressUpload(body());
        try {
          response = await client.fetch(url, { method: 'PUT', headers: { 'Content-Length': String(buffer.length) }, body: transfer.body, duplex: 'half', redirect: 'error', signal: transfer.signal });
          if (!response.ok && response.status >= 500 && attempt === 0) { await response.body?.cancel(); continue; }
          break;
        } catch (error) { if (attempt === 1) throw error; }
        finally { transfer.close(); }
      }
      if (!response?.ok) throw new Error(`File transfer failed (HTTP ${response?.status}). Inspect the project before retrying.`);
      const eTag = response.headers.get('etag');
      if (!eTag) throw new Error('File transfer returned no part identity.');
      parts.push({ eTag, partNumber });
    }
    const finalInfo = await opened.handle.stat();
    if (finalInfo.size !== bytes || await digestHandle(opened.handle, bytes) !== digest) throw new Error('Source file changed during upload; no source was finalized.');
    return await client.request(`${route}/complete`, { method: 'POST', structuredErrors: true, body: { key: upload.key, uploadId: upload.uploadId, completionToken: upload.completionToken, sizeBytes: bytes, parts } });
  } finally { await opened.handle.close(); }
}


/** Stream one request without materializing file bytes in a receipt or in memory. */
export function agentMultipart(intent, sources) {
  for (const source of sources) assertAgentFileSize({ originalName: path.basename(source.path), sizeBytes: source.size });
  const boundary = `palatial-${randomUUID()}`;
  const fields = sources.map((source, index) => ({
    part: `file${index}`, originalName: path.basename(source.path),
    kind: mimeTypes.get(path.extname(source.path).toLowerCase())?.startsWith('image/') ? 'image' : ['.mp4', '.mov'].includes(path.extname(source.path).toLowerCase()) ? 'video' : ['.pdf', '.txt'].includes(path.extname(source.path).toLowerCase()) ? 'document' : 'cad',
    mimeType: mimeTypes.get(path.extname(source.path).toLowerCase()) || 'application/octet-stream',
    sha256: source.sha256, sizeBytes: source.size
  }));
  const manifest = { ...intent, files: fields.map(({ part, ...file }) => file) };
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ ...intent, files: fields })}\r\n`);
  const prefixes = fields.map(file => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.part}"; filename="${file.originalName.replaceAll('"', '\\"')}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`));
  const end = Buffer.from(`--${boundary}--\r\n`);
  const length = head.length + end.length + sources.reduce((sum, source, index) => sum + prefixes[index].length + source.size + 2, 0);
  const body = async function* () {
    yield head;
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      const opened = await openRegularFile(source.path);
      try {
        if (opened.info.size !== source.size || await digestHandle(opened.handle, source.size) !== source.sha256) throw new Error('A source changed before submission.');
        yield prefixes[index];
        const hash = createHash('sha256');
        for (let offset = 0; offset < source.size;) {
          const buffer = Buffer.alloc(Math.min(64 * 1024, source.size - offset));
          const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, offset);
          if (bytesRead !== buffer.length) throw new Error('A source changed during submission.');
          offset += bytesRead;
          hash.update(buffer);
          yield buffer;
        }
        if ((await opened.handle.stat()).size !== source.size || hash.digest('hex') !== source.sha256) throw new Error('A source changed during submission.');
        yield Buffer.from('\r\n');
      } finally { await opened.handle.close(); }
    }
    yield end;
  };
  return { manifest, uploadBody: { body: body(), contentType: `multipart/form-data; boundary=${boundary}`, length } };
}

/** One public operation: native multipart for small requests, resumable parts for large files. */
export async function submitAgentWithFiles(client, input) {
  const { files, ...submittedIntent } = input;
  const intent = { ...submittedIntent, requestId: submittedIntent.requestId ?? randomUUID() };
  if (files.length + (intent.attachments?.length || 0) > 50) throw new Error('At most 50 attachments and files combined.');
  const sources = [];
  for (const filename of files) {
    assertLocalPath(filename);
    const name = path.basename(filename);
    if (!extensions.has(path.extname(filename).toLowerCase())) throw new Error('Unsupported Agent source file type.');
    if (name.length > 240 || name.includes('..') || /[\\/\x00-\x1f]/.test(name)) throw new Error('Use a plain source filename.');
    const opened = await openRegularFile(filename);
    try {
      assertAgentFileSize({ originalName: name, sizeBytes: opened.info.size });
      sources.push({ path: path.resolve(filename), size: opened.info.size, sha256: await digestHandle(opened.handle, opened.info.size) });
    } finally { await opened.handle.close(); }
  }
  if (sources.reduce((sum, source) => sum + source.size, 0) > agentFileMaxBytes) throw new Error('One Agent request supports at most 1 GiB of files.');
  const fingerprint = createHash('sha256').update(JSON.stringify({ intent, sources })).digest('hex');
  const owner = createHash('sha256').update(JSON.stringify([client.base.href, client.apiKey, intent.requestId])).digest('hex');
  const directory = await resolveOutputDirectory(client.receiptDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertResolvedDirectory(directory);
  const receipt = path.join(directory, `agent-source-intent-${owner}.json`);
  const readReceipt = async () => {
    const bytes = await readCappedRegularFile(receipt, intentReceiptMaxBytes);
    if (!bytes) return undefined;
    const saved = JSON.parse(bytes.toString('utf8'));
    if (saved.fingerprint !== fingerprint) throw new Error('Request ID already has different intent or source bytes. Preserve the original request and inspect its receipt.');
    return saved;
  };
  const lock = await open(`${receipt}.lock`, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('This intent is already being prepared. Preserve request_id and inspect its local receipt before retrying.');
    throw error;
  });
  try {
    let saved = await readReceipt();
    // Old inline receipts retain their original JSON fingerprint and exact request.
    if (saved && saved.version !== 2) return await client.startAgentTurn(saved.input);
    if (intent.attachments?.some(attachment => attachment.inlineData)) throw new Error('Use files for all file bytes when submitting local files; inlineData cannot be combined with multipart.');
    const multipart = agentMultipart(intent, sources);
    const save = async () => {
      const temporary = `${receipt}.${randomUUID()}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(saved) + '\n');
        await handle.close();
        await rename(temporary, receipt);
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        throw error;
      }
    };
    const replay = async () => {
      const { route, body } = agentTurnRoute(saved.input);
      try { return { result: await client.request(route, { method: 'POST', body, structuredErrors: true }) }; }
      catch (error) { if (error.code !== 'AGENT_SOURCE_BYTES_REQUIRED') throw error; return {}; }
    };
    if (saved) {
      const recovered = await replay();
      if (recovered.result) return recovered.result;
    } else {
      saved = { version: 2, transport: sources.reduce((sum, source) => sum + source.size, 0) <= multipartMaxBytes ? 'multipart' : 'parts', fingerprint, sources, input: multipart.manifest, uploaded: [] };
      await save();
    }
    if (saved.transport === 'parts') {
      if (!saved.assetId) {
        const reserved = intent.assetId ? { assetId: intent.assetId } : await client.request('agent/sources', { method: 'POST', structuredErrors: true, body: { requestId: intent.requestId } });
        if (typeof reserved.assetId !== 'string' || !/^[a-f0-9]{24}$/i.test(reserved.assetId)) throw new Error('File reservation returned no project identity. Preserve request_id.');
        saved.assetId = reserved.assetId;
        await save();
      }
      for (let index = saved.uploaded.length; index < sources.length; index++) {
        const source = sources[index];
        const identity = await digestRegularFile(source.path, source.size);
        if (identity.sha256 !== source.sha256 || identity.size !== source.size) throw new Error('A source changed before upload.');
        const uploaded = await uploadAgentSource(client, { asset_id: saved.assetId, file_path: source.path });
        if (!uploaded?.attachment?.bytesInAsset) throw new Error('File upload returned no stored attachment.');
        saved.uploaded.push(uploaded.attachment);
        await save();
      }
      saved.input = { ...intent, assetId: saved.assetId, attachments: [...(intent.attachments || []), ...saved.uploaded] };
      await save();
      return await client.startAgentTurn(saved.input);
    }
    const send = () => {
      const { route, body } = agentTurnRoute(intent);
      return client.request(route, { method: 'POST', uploadBody: agentMultipart(body, sources).uploadBody, structuredErrors: true });
    };
    try { return await send(); }
    catch (error) {
      if ((error.http_status || error.status) && (error.http_status || error.status) < 500) throw error;
      const recovered = await replay();
      if (recovered.result) return recovered.result;
      // Only an authoritative missing-bytes refusal permits one full retransmission.
      return await send();
    }
  } finally {
    await lock.close();
    await unlink(`${receipt}.lock`).catch(() => {});
  }
}

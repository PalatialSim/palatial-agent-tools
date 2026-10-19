import path from 'node:path';
import { z } from 'zod';
import { assertLocalPath, assertPublicHttpsUrl, digestHandle, openRegularFile } from './input-guards.js';

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

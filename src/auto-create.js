import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const sourceUrl = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
}, 'Source URLs must use HTTPS without credentials or a fragment.');
export const autoCreateSchema = z.object({
  description: z.string().trim().min(1).max(2000).describe('What to build, including dimensions, materials, moving parts and intended use. Optional when media supplies the input.').optional(),
  name: z.string().trim().min(4).max(50).regex(/^[a-zA-Z\d_\-.\s]+$/).describe('Optional asset name; the server supplies one when omitted.').optional(),
  workspace: z.string().regex(/^[a-fA-F0-9]{24}$/).describe('Optional workspace ID; defaults to the API-key workspace.').optional(),
  engine: z.array(z.enum(['isaac_sim', 'mujoco', 'newton'])).min(1).max(3).describe('Optional simulator targets; the server validates the selected route against them.').optional(),
  quality: z.enum(['speed', 'balanced', 'accuracy']).describe('Optional goal preference. The server chooses the route and all build settings.').optional(),
  file_paths: z.array(z.string().min(1)).describe('Local photos or CAD/3D files to upload as repeated files, at most 20 MiB each and 64 MiB total. Only these named files are read. The server validates route input limits.').optional(),
  source_urls: z.array(sourceUrl).describe('HTTPS photo or CAD/3D source URLs. Palatial retrieves and validates the media; the client does not download them.').optional(),
  dryRun: z.boolean().default(false).describe('Select a route and settings only: no asset creation, submission or token charge.').optional(),
  request_id: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/).describe('Stable idempotency ID sent as Idempotency-Key for submission. Preserve it after uncertainty; identical replays reuse the asset, changed inputs conflict. Generated once when omitted and saved in the local receipt. Not needed for dryRun.').optional()
}).strict().superRefine((input, ctx) => {
  if (!input.description && !input.file_paths?.length && !input.source_urls?.length) ctx.addIssue({ code: 'custom', message: 'Provide a description, a local file, or a source URL.' });
});

const sourceTypes = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.obj': 'application/octet-stream',
  '.stl': 'application/octet-stream', '.ply': 'application/octet-stream', '.fbx': 'application/octet-stream',
  '.step': 'application/octet-stream', '.stp': 'application/octet-stream', '.iges': 'application/octet-stream',
  '.igs': 'application/octet-stream', '.usd': 'application/octet-stream', '.usda': 'application/octet-stream',
  '.usdc': 'application/octet-stream', '.usdz': 'application/octet-stream'
};

async function requestBody(input) {
  const { file_paths, source_urls, request_id, ...fields } = input;
  const parameters = { ...fields, ...(source_urls?.length ? { urls: source_urls } : {}) };
  if (!file_paths?.length) return parameters;
  const body = new FormData();
  for (const [key, value] of Object.entries(parameters)) {
    if (value === undefined) continue;
    if (key === 'urls') body.append(key, JSON.stringify(value));
    else for (const item of Array.isArray(value) ? value : [value]) body.append(key, String(item));
  }
  let localBytes = 0;
  const sources = [];
  for (const filename of file_paths) {
    const absolute = path.resolve(filename);
    const type = sourceTypes[path.extname(absolute).toLowerCase()];
    if (!type) throw new Error('Auto generation accepts PNG, JPEG, WebP or supported CAD/3D files.');
    const info = await stat(absolute);
    if (!info.isFile() || info.size === 0 || info.size > 20 * 1024 ** 2) throw new Error('Input must be a nonempty regular file of at most 20 MiB.');
    localBytes += info.size;
    if (localBytes > 64 * 1024 ** 2) throw new Error('Automatic generation accepts at most 64 MiB of source media in total.');
    sources.push({ absolute, type, bytes: info.size });
  }
  for (const source of sources) {
    const bytes = await readFile(source.absolute);
    if (bytes.length !== source.bytes) throw new Error('A source file changed before upload; review the inputs and try again.');
    body.append('files', new Blob([bytes], { type: source.type }), path.basename(source.absolute));
  }
  return body;
}

export async function createAuto(client, input) {
  const p = autoCreateSchema.parse(input);
  const body = await requestBody(p);
  if (p.dryRun) return client.request('assets/create/auto', { method: 'POST', body });
  const requestId = p.request_id || randomUUID();
  // A receipt is written before submission so a lost response cannot lose the
  // server's idempotency identity. URLs and local source paths stay out of it.
  const receipt = path.join(client.receiptDir, `auto-${randomUUID()}.json`);
  await mkdir(client.receiptDir, { recursive: true, mode: 0o700 });
  const intent = { request_id: requestId, api_origin: client.base.origin, submitted_at: new Date().toISOString(), status: 'submission_outcome_unknown' };
  await writeFile(receipt, JSON.stringify(intent, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  let result;
  try {
    result = await client.request('assets/create/auto', { method: 'POST', body, idempotencyKey: requestId });
  } catch (error) {
    error.request_id = requestId;
    error.receipt_file = receipt;
    const httpStatus = error.http_status ?? error.status;
    if (httpStatus >= 400 && httpStatus < 500) {
      try { await writeFile(receipt, JSON.stringify({ ...intent, status: 'rejected', http_status: httpStatus, ...(typeof error.code === 'string' ? { code: error.code } : {}) }, null, 2) + '\n', { mode: 0o600 }); }
      catch { error.message += ' The local rejection receipt could not be updated.'; }
    }
    error.message += ` Preserve request_id=${requestId} and replay the same inputs with that ID to recover this submission. Recovery receipt: ${receipt}`;
    throw error;
  }
  const assetId = result?.id;
  if (typeof assetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(assetId)) throw new Error(`Auto create returned no valid asset ID. Preserve request_id=${requestId} and replay the same inputs with that ID. Recovery receipt: ${receipt}`);
  const created = { ...result, asset_id: assetId, request_id: requestId, receipt_file: receipt };
  try { await writeFile(receipt, JSON.stringify({ ...intent, asset_id: assetId, status: 'accepted' }, null, 2) + '\n', { mode: 0o600 }); }
  catch { created.receipt_warning = 'Asset was submitted, but its local receipt could not be updated. Save asset_id and request_id from this response.'; }
  return created;
}

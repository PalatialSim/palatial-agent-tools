import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const sceneIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Scene ID must be a 24-character ObjectId.');
export const sceneDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, 'Expected a SHA-256 version or head.');
const provenance = z.enum(['user_selected', 'user_stated', 'approved_default']);
export const sceneChildIntentSchema = z.object({
  schema: z.literal('palatial.scene-child-intent.v1'),
  bodyType: z.literal('rigid_bodies'),
  objectBehavior: z.enum(['single_object', 'static_parts', 'articulated_parts']),
  packageTarget: z.enum(['IsaacSim', 'Newton', 'MuJoCo']),
  runSimulation: z.boolean(),
  provenance: z.object({ bodyType: provenance, objectBehavior: provenance, packageTarget: provenance, runSimulation: provenance }).strict()
}).strict().describe('Shared Dashboard child intent: object behavior, simulator target, physics validation and the origin of each choice.');
export const sceneOptionsSchema = z.object({
  object_build_mode: z.literal('mock_mad_max').describe('Dev acceptance only: fixture objects through the real scene order and delivery path. The scene director can still incur charges.').optional(),
  max_object_builds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe('Maximum object builds allowed for this scene.').optional(),
  child_intent: sceneChildIntentSchema.optional(),
  allowed_routes: z.array(z.enum(['diffusion', 'parametric', 'mad_max'])).min(1).max(3).refine(routes => new Set(routes).size === routes.length, 'Routes must be distinct.').optional(),
  max_child_attempts: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe('Maximum attempts per child order.').optional()
}).strict();
export const sceneSourceSchema = z.object({
  key: z.string().min(1).max(1024), filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), mediaType: z.string().min(1).max(128),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(1_000_000_000)
}).strict();
export const createSceneSchema = z.object({
  workspace: sceneIdSchema.describe('Workspace ID authorized by the configured API key.'),
  request_id: z.string().uuid().describe('Stable UUID for this scene. Preserve it across uncertain outcomes; do not generate a replacement UUID to retry.'),
  description: z.string().trim().min(1).max(4000).describe('Scene reconstruction instructions, dimensions and intended use, up to 4000 characters.'),
  source_paths: z.array(z.string().min(1)).max(32).describe('Local photos, MP4/MOV/WebM videos or PDF/image floor plans; at most 32 combined sources, each at most 1 GB (1,000,000,000 bytes). Only these named files are uploaded.').optional(),
  sources: z.array(sceneSourceSchema).max(32).describe('Previously uploaded source descriptors owned by this scene, for resuming a draft. External URLs are not accepted.').optional(),
  floor_plan: z.string().min(1).max(128).describe('Exact filename of the source that serves as the floor plan.').optional(),
  confirm_spend: z.literal(true).describe('Explicit user authorization to incur director and object charges. Obtain authorization before calling.'),
  options: sceneOptionsSchema.optional()
}).strict().superRefine((input, ctx) => {
  const names = [...(input.source_paths || []).map(file => path.basename(file)), ...(input.sources || []).map(source => source.filename)];
  if (names.length > 32) ctx.addIssue({ code: 'custom', message: 'A scene selects at most 32 combined local and uploaded sources.' });
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'Scene sources must have distinct filenames.' });
  if (input.floor_plan && !names.includes(input.floor_plan)) ctx.addIssue({ code: 'custom', path: ['floor_plan'], message: 'floor_plan must name one of the scene sources.' });
});
export const listScenesSchema = z.object({ workspace: sceneIdSchema, limit: z.number().int().min(1).max(100).optional(), before: sceneIdSchema.describe('Pagination cursor returned as next_cursor.').optional() }).strict();
export const answerSceneSchema = z.object({ scene_id: sceneIdSchema, expected_head: sceneDigestSchema.describe('Exact input.expected_head from the latest scene read; prevents answering a stale question.'), instruction: z.string().trim().min(1).max(4000).describe('Answer or clarification for the current scene question, up to 4000 characters.') }).strict();
export const recoverSceneSchema = z.object({ scene_id: sceneIdSchema, expected_head: sceneDigestSchema.describe('Exact input.expected_head from the current scene report, including a recovery checkpoint with no question; the server validates recoverability.') }).strict();
export const retrySceneStartSchema = z.object({ scene_id: sceneIdSchema, confirm_spend: z.literal(true).describe('Explicit spending authorization for retrying the frozen confirmed start; the server must prove no native execution occurred.') }).strict();
export const downloadSceneSchema = z.object({ scene_id: sceneIdSchema, output_dir: z.string().min(1), version: sceneDigestSchema.describe('Exact download.version from the scene read. Downloads only an accepted delivery receipt.') }).strict();

const sourceTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
const inlineLimit = 32 * 1024 ** 2;
async function fileDigest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
const route = id => `scene-generations/${sceneIdSchema.parse(id)}`;

async function inspectSource(filename) {
  const mediaType = sourceTypes[path.extname(filename).toLowerCase()];
  if (!mediaType) throw new Error('Scene sources support PNG, JPEG, WebP, PDF, MP4, MOV and WebM.');
  const info = await stat(filename);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(path.basename(filename))) throw new Error('Scene source filename must be 1-128 characters, start with a letter or digit, and use only letters, digits, periods, underscores or hyphens.');
  if (!info.isFile() || info.size < 1 || info.size > 1_000_000_000) throw new Error('Scene source must be a nonempty file within the 1 GB (1,000,000,000 bytes) upload limit.');
  return { path: filename, filename: path.basename(filename), mediaType, bytes: info.size, sha256: await fileDigest(filename) };
}
function uploadUuid(requestId, source) {
  const hex = createHash('sha256').update(`${requestId}:${source.sha256}:${source.filename}:${source.mediaType}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
async function uploadSource(client, sceneId, source, requestId) {
  if (source.bytes <= inlineLimit) {
    const bytes = await readFile(source.path);
    if (bytes.length !== source.bytes || createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('Scene source changed during upload; inspect the draft before retrying.');
    const result = await client.request(`${route(sceneId)}/sources`, { method: 'POST', body: { filename: source.filename, media_type: source.mediaType, base64: bytes.toString('base64') } });
    return sceneSourceSchema.parse(result.source);
  }
  const prefix = `${route(sceneId)}/source-uploads`;
  const upload = await client.request(`${prefix}/start`, { method: 'POST', body: { uploadRequestId: uploadUuid(requestId, source), filename: source.filename, mediaType: source.mediaType, bytes: source.bytes } });
  if (typeof upload.uploadId !== 'string' || !/^[a-f0-9]{32}$/.test(upload.uploadId) || !Number.isSafeInteger(upload.partSizeBytes) || upload.partSizeBytes < 1 || upload.partSizeBytes > 16 * 1024 ** 2 || !Number.isSafeInteger(upload.partCount) || upload.partCount > 60 || upload.partCount !== Math.ceil(source.bytes / upload.partSizeBytes) || !Array.isArray(upload.completedParts)) throw new Error('Invalid scene multipart upload response. Inspect the scene draft before retrying.');
  const file = await open(source.path, 'r');
  try {
    const parts = [];
    for (let partNumber = 1; partNumber <= upload.partCount; partNumber++) {
      const prior = upload.completedParts.find(part => part.partNumber === partNumber);
      if (prior && typeof prior.etag === 'string') { parts.push({ partNumber, etag: prior.etag }); continue; }
      const offset = (partNumber - 1) * upload.partSizeBytes;
      const buffer = Buffer.alloc(Math.min(upload.partSizeBytes, source.bytes - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (bytesRead !== buffer.length) throw new Error('Scene source changed during multipart upload.');
      const part = await client.request(`${prefix}/${encodeURIComponent(upload.uploadId)}/parts/${partNumber}`, { method: 'PUT', binaryBody: buffer });
      if (typeof part.etag !== 'string') throw new Error('Invalid scene upload part receipt.');
      parts.push({ partNumber, etag: part.etag });
    }
    if (await fileDigest(source.path) !== source.sha256) throw new Error('Scene source changed during multipart upload.');
    const result = await client.request(`${prefix}/${encodeURIComponent(upload.uploadId)}/complete`, { method: 'POST', body: { sha256: source.sha256, parts } });
    return sceneSourceSchema.parse(result.source);
  } finally { await file.close(); }
}

export async function createScene(client, input) {
  const p = createSceneSchema.parse(input);
  // Validate every local source before creating a server-side draft.
  const files = [];
  for (const filename of p.source_paths || []) files.push(await inspectSource(filename));
  const draft = await client.request(`workspaces/${p.workspace}/scene-generations`, { method: 'POST', body: { request_id: p.request_id } });
  const sceneId = sceneIdSchema.parse(draft.scene_id);
  try {
    let current = await getScene(client, sceneId);
    const sources = [...(p.sources || [])];
    for (const file of files) {
      if (current.status !== 'draft') {
        const matching = current.sources?.find(source => source.filename === file.filename && source.sha256 === file.sha256 && source.bytes === file.bytes && source.mediaType === file.mediaType);
        if (!matching) throw new Error('request_id conflicts with the sources of the existing scene. Use the original inputs.');
        sources.push(sceneSourceSchema.parse(matching));
      } else sources.push(await uploadSource(client, sceneId, file, p.request_id));
    }
    current = await getScene(client, sceneId);
    const revision = current.status === 'draft' ? current.revision : current.confirmed_request_revision;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Scene has no valid confirmed request revision; inspect it before retrying.');
    return await client.request(`${route(sceneId)}/generate`, { method: 'POST', body: { description: p.description, sources, expected_revision: revision, confirm_spend: p.confirm_spend, ...(p.floor_plan ? { floor_plan: p.floor_plan } : {}), ...(p.options ? { options: p.options } : {}) } });
  } catch (error) {
    error.message = `${error.message} Scene ${sceneId} belongs to request_id ${p.request_id}; inspect it and preserve both IDs before retrying. No automatic retry was made.`;
    throw error;
  }
}
export function getScene(client, sceneId) { return client.request(route(sceneId)); }
export function listScenes(client, input) {
  const { workspace, ...query } = listScenesSchema.parse(input);
  return client.request(`workspaces/${workspace}/scene-generations${Object.keys(query).length ? `?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}` : ''}`);
}
export function answerScene(client, input) { const { scene_id, ...body } = answerSceneSchema.parse(input); return client.request(`${route(scene_id)}/answer`, { method: 'POST', body }); }
export function cancelScene(client, sceneId) { return client.request(`${route(sceneId)}/stop`, { method: 'POST', body: {} }); }
export function recoverScene(client, input) { const { scene_id, ...body } = recoverSceneSchema.parse(input); return client.request(`${route(scene_id)}/recover`, { method: 'POST', body }); }
export function retrySceneStart(client, input) { const { scene_id, ...body } = retrySceneStartSchema.parse(input); return client.request(`${route(scene_id)}/retry-start`, { method: 'POST', body }); }
export async function downloadScene(client, input) {
  const { scene_id, output_dir, version } = downloadSceneSchema.parse(input);
  const directory = path.resolve(output_dir);
  const stem = `${scene_id}-scene-${version.slice(7, 19)}`;
  const destination = path.join(directory, `${stem}.zip`);
  const receiptPath = path.join(directory, `${stem}-receipt.json`);
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (receipt.scene_id === scene_id && receipt.version === version && receipt.api_origin === client.base.origin && receipt.file === destination && receipt.sha256 === version.slice(7) && Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0 && (await stat(destination)).size === receipt.bytes && await fileDigest(destination) === receipt.sha256) return { ...receipt, receipt_file: receiptPath, cached: true };
    throw new Error('Existing scene download receipt is invalid. Choose a new output directory.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const filename of [destination, receiptPath]) {
    try { await stat(filename); throw new Error('Output already exists. Choose a new output directory.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(directory, { recursive: true });
  const file = await open(destination, 'wx', 0o600);
  let complete = false;
  try {
    const response = await client.request(`${route(scene_id)}/download?version=${encodeURIComponent(version)}`, { raw: true });
    // The API streams the accepted archive; it never requires credentialed redirects.
    if (!response.ok || !response.body || /json|text\/html/i.test(response.headers.get('content-type') || '')) throw new Error('Scene download did not return an archive.');
    if (response.headers.get('etag') !== `"${version}"`) throw new Error('Scene archive ETag does not match the requested delivery version.');
    const lengthHeader = response.headers.get('content-length');
    const expectedBytes = Number(lengthHeader);
    if (!lengthHeader || !/^[1-9][0-9]*$/.test(lengthHeader) || !Number.isSafeInteger(expectedBytes)) throw new Error('Scene archive Content-Length is missing or invalid.');
    if (expectedBytes > client.maxDownloadBytes) throw new Error('Scene archive exceeds the client download limit.');
    const hash = createHash('sha256');
    let bytes = 0;
    let signature = Buffer.alloc(0);
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > client.maxDownloadBytes) throw new Error('Scene archive exceeds the client download limit.');
      if (signature.length < 4) signature = Buffer.concat([signature, Buffer.from(chunk)]).subarray(0, 4);
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (!['504b0304', '504b0506', '504b0708'].includes(signature.toString('hex'))) throw new Error('Downloaded scene is not a ZIP archive.');
    if (bytes !== expectedBytes) throw new Error('Scene archive byte count does not match Content-Length.');
    const sha256 = hash.digest('hex');
    if (`sha256:${sha256}` !== version) throw new Error('Scene archive SHA-256 does not match the requested delivery version.');
    await file.sync();
    const receipt = { scene_id, version, file: destination, sha256, bytes, downloaded_at: new Date().toISOString(), api_origin: client.base.origin, validation: 'not_inspected', simulator_acceptance: 'not_tested' };
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    complete = true;
    return { ...receipt, receipt_file: receiptPath, cached: false };
  } finally { await file.close(); if (!complete) await unlink(destination).catch(() => {}); }
}

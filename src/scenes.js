import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { assertLocalPath, assertPublicHttpsUrl, assertResolvedDirectory, digestHandle, digestRegularFile, openRegularFile, readCappedRegularFile, readExact, redactUrlSecrets, resolveOutputDirectory } from './input-guards.js';

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
export const legacyCreateSceneSchema = z.object({
  workspace: sceneIdSchema.describe('Workspace ID authorized by the configured API key.'),
  request_id: z.string().uuid().describe('Stable UUID for this scene. Preserve it across uncertain outcomes; do not generate a replacement UUID to retry.'),
  description: z.string().trim().min(1).max(4000).describe('Scene reconstruction instructions, dimensions and intended use, up to 4000 characters.'),
  source_paths: z.array(z.string().min(1)).max(32).describe('Local photos, MP4/MOV/WebM videos or PDF/image floor plans; at most 32 combined sources, each at most 1 GB (1,000,000,000 bytes). Only these named files are uploaded.').optional(),
  sources: z.array(sceneSourceSchema).max(32).describe('Previously uploaded source descriptors owned by this scene, for resuming a draft. External URLs are not accepted.').optional(),
  floor_plan: z.string().min(1).max(128).describe('Exact filename of the source that serves as the floor plan.').optional(),
  confirm_spend: z.literal(true).describe('Explicit user authorization to incur director and object charges. Obtain authorization before calling. Sent to the server, which accepts only true.'),
  options: sceneOptionsSchema.optional()
}).strict().superRefine((input, ctx) => {
  const names = [...(input.source_paths || []).map(file => path.basename(file)), ...(input.sources || []).map(source => source.filename)];
  if (names.length > 32) ctx.addIssue({ code: 'custom', message: 'A scene selects at most 32 combined local and uploaded sources.' });
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'Scene sources must have distinct filenames.' });
  if (input.floor_plan && !names.includes(input.floor_plan)) ctx.addIssue({ code: 'custom', path: ['floor_plan'], message: 'floor_plan must name one of the scene sources.' });
});
const startSourceUrl = z.url().superRefine((value, ctx) => {
  try { assertPublicHttpsUrl(value); }
  catch (error) { ctx.addIssue({ code: 'custom', message: error.message }); }
});
const startSourceSchema = z.object({
  filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  media_type: z.enum(['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'video/mp4', 'video/quicktime', 'video/webm']),
  url: startSourceUrl
}).strict();
export const createSceneSchema = legacyCreateSceneSchema.safeExtend({
  sources: z.array(z.union([startSourceSchema, sceneSourceSchema])).max(32).describe('HTTPS source URLs with filename and media_type. Previously uploaded descriptors are deprecated.').optional(),
  auto_continue: z.boolean().default(false).describe('Automatically continue checkpoints and continuation questions with the original instructions. Defaults to false.')
});
export const listScenesSchema = z.object({ workspace: sceneIdSchema, limit: z.number().int().min(1).max(100).optional(), before: sceneIdSchema.describe('Pagination cursor returned as next_cursor.').optional() }).strict();
const aliasConfirmSpend = z.literal(true).describe('Required when the scene has settled (stopped, delivered or on its best checkpoint), because continuing it starts new paid work.').optional();
export const answerSceneSchema = z.object({ scene_id: sceneIdSchema, expected_head: sceneDigestSchema.describe('Exact input.expected_head from the latest scene read; prevents answering a stale question.'), instruction: z.string().trim().min(1).max(4000).describe('Answer or clarification for the current scene question, up to 4000 characters.'), confirm_spend: aliasConfirmSpend }).strict();
export const recoverSceneSchema = z.object({ scene_id: sceneIdSchema, expected_head: sceneDigestSchema.describe('Exact input.expected_head from the current scene report, including a recovery checkpoint with no question; the server validates recoverability.'), confirm_spend: aliasConfirmSpend }).strict();
export const sceneObjectIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'Invalid scene object ID.');
export const messageSceneSchema = z.object({
  text: z.string().trim().min(1).max(4000).describe('Message for the scene, up to 4000 characters. Required when next_message.requires_text is true: always for relay and answer, and for continue when the ending takes an answer. Optional for resume; not applied by retry_start.').optional(),
  requestId: z.string().uuid().describe('Stable UUID for this message. The same ID and body replay the stored receipt; a new UUID is a new message.').optional(),
  confirmSpend: z.literal(true).describe('Required when next_message.requires_confirm_spend is true (continuing a settled scene, retrying a refused start). Ignored otherwise.').optional(),
  expectedHead: sceneDigestSchema.describe('Optional next_message.expected_head; the message is refused with scene_head_moved when the scene has moved on. Omit it when next_message.expected_head is null (relay, retry_start): any value is then refused.').optional(),
  regenerateObjects: z.array(sceneObjectIdSchema).min(1).max(1000).describe('Failed or dropped object IDs from next_message.regenerable_objects to rebuild; only with next_message.action continue, so it always needs confirmSpend.').optional()
}).strict().refine(input => !input.regenerateObjects || input.confirmSpend === true, { path: ['confirmSpend'], message: 'Rebuilding objects is new paid work: regenerateObjects needs confirmSpend: true.' });
export const retrySceneStartSchema = z.object({ scene_id: sceneIdSchema, confirm_spend: z.literal(true).describe('Explicit spending authorization for retrying the frozen confirmed start; the server must prove no native execution occurred.') }).strict();
export const downloadSceneSchema = z.object({ scene_id: sceneIdSchema, output_dir: z.string().min(1), version: sceneDigestSchema.describe('Optional exact download.version. Omit to download the current accepted package.').optional() }).strict();

const sourceTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
const inlineLimit = 32 * 1024 ** 2;
const receiptLimit = 64 * 1024;
const route = id => `scene-generations/${sceneIdSchema.parse(id)}`;

async function inspectSource(filename) {
  assertLocalPath(filename);
  const mediaType = sourceTypes[path.extname(filename).toLowerCase()];
  if (!mediaType) throw new Error('Scene sources support PNG, JPEG, WebP, PDF, MP4, MOV and WebM.');
  let opened;
  try { opened = await openRegularFile(filename); }
  catch (error) {
    if (error.code === 'ELOOP') throw new Error('Scene source must be a regular file, not a symbolic link.');
    if (error.code === 'ENOTFILE') throw new Error('Scene source must be a nonempty file within the 1 GB (1,000,000,000 bytes) upload limit.');
    throw error;
  }
  try {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(path.basename(filename))) throw new Error('Scene source filename must be 1-128 characters, start with a letter or digit, and use only letters, digits, periods, underscores or hyphens.');
    if (opened.info.size < 1 || opened.info.size > 1_000_000_000) throw new Error('Scene source must be a nonempty file within the 1 GB (1,000,000,000 bytes) upload limit.');
    const sha256 = await digestHandle(opened.handle, opened.info.size);
    return { path: filename, filename: path.basename(filename), mediaType, bytes: opened.info.size, sha256, handle: opened.handle };
  } catch (error) {
    await opened.handle.close();
    throw error;
  }
}
function uploadUuid(requestId, source) {
  const hex = createHash('sha256').update(`${requestId}:${source.sha256}:${source.filename}:${source.mediaType}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
async function uploadSource(client, sceneId, source, requestId) {
  if (source.bytes <= inlineLimit) {
    const bytes = await readExact(source.handle, source.bytes);
    if (bytes.length !== source.bytes || createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('Scene source changed during upload; inspect the draft before retrying.');
    const result = await client.request(`${route(sceneId)}/sources`, { method: 'POST', body: { filename: source.filename, media_type: source.mediaType, base64: bytes.toString('base64') } });
    return sceneSourceSchema.parse(result.source);
  }
  const prefix = `${route(sceneId)}/source-uploads`;
  const upload = await client.request(`${prefix}/start`, { method: 'POST', body: { uploadRequestId: uploadUuid(requestId, source), filename: source.filename, mediaType: source.mediaType, bytes: source.bytes } });
  if (typeof upload.uploadId !== 'string' || !/^[a-f0-9]{32}$/.test(upload.uploadId) || !Number.isSafeInteger(upload.partSizeBytes) || upload.partSizeBytes < 1 || upload.partSizeBytes > 16 * 1024 ** 2 || !Number.isSafeInteger(upload.partCount) || upload.partCount > 60 || upload.partCount !== Math.ceil(source.bytes / upload.partSizeBytes) || !Array.isArray(upload.completedParts)) throw new Error('Invalid scene multipart upload response. Inspect the scene draft before retrying.');
  const parts = [];
  for (let partNumber = 1; partNumber <= upload.partCount; partNumber++) {
    const prior = upload.completedParts.find(part => part.partNumber === partNumber);
    if (prior && typeof prior.etag === 'string') { parts.push({ partNumber, etag: prior.etag }); continue; }
    const offset = (partNumber - 1) * upload.partSizeBytes;
    const buffer = Buffer.alloc(Math.min(upload.partSizeBytes, source.bytes - offset));
    const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead !== buffer.length) throw new Error('Scene source changed during multipart upload.');
    const part = await client.request(`${prefix}/${encodeURIComponent(upload.uploadId)}/parts/${partNumber}`, { method: 'PUT', binaryBody: buffer });
    if (typeof part.etag !== 'string') throw new Error('Invalid scene upload part receipt.');
    parts.push({ partNumber, etag: part.etag });
  }
  if (await digestHandle(source.handle, source.bytes) !== source.sha256) throw new Error('Scene source changed during multipart upload.');
  const result = await client.request(`${prefix}/${encodeURIComponent(upload.uploadId)}/complete`, { method: 'POST', body: { sha256: source.sha256, parts } });
  return sceneSourceSchema.parse(result.source);
}

async function closeSources(files) {
  await Promise.all(files.map(file => file.handle?.close().catch(() => {})));
}
export async function createSceneLegacy(client, input) {
  const p = legacyCreateSceneSchema.parse(input);
  // Validate every local source before creating a server-side draft.
  const files = [];
  try {
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
    error.message = redactUrlSecrets(`${error.message} Scene ${sceneId} belongs to request_id ${p.request_id}; inspect it and preserve both IDs before retrying. No automatic retry was made.`);
    throw error;
  }
  } finally { await closeSources(files); }
}
export async function createScene(client, input) {
  let p;
  try { p = createSceneSchema.parse(input); }
  catch (error) { error.message = redactUrlSecrets(error.message); throw error; }
  // Old owned-source request files retain their original compatibility path.
  if (p.sources?.some(source => 'key' in source)) {
    if (p.auto_continue || p.sources.some(source => !('key' in source))) throw new Error('Deprecated owned sources cannot be combined with URLs or auto_continue. Use source_paths or URL sources.');
    const { auto_continue, ...legacy } = p;
    return createSceneLegacy(client, legacy);
  }
  const files = [];
  try {
  for (const filename of p.source_paths || []) files.push(await inspectSource(filename));
  const sources = [...(p.sources || [])];
  let inlineBytes = 0;
  for (const file of files) {
    const source = { filename: file.filename, media_type: file.mediaType, bytes: file.bytes, sha256: file.sha256 };
    if (inlineBytes + file.bytes <= inlineLimit) {
      inlineBytes += file.bytes;
      const bytes = await readExact(file.handle, file.bytes);
      if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Scene source changed before upload.');
      source.base64 = bytes.toString('base64');
    }
    sources.push(source);
  }
  const state = await client.request(`workspaces/${p.workspace}/scene-generations/start`, { method: 'POST', body: {
    request_id: p.request_id, description: p.description, sources, autoContinue: p.auto_continue,
    confirm_spend: p.confirm_spend, ...(p.floor_plan ? { floor_plan: p.floor_plan } : {}), ...(p.options ? { options: p.options } : {})
  } });
  const sceneId = sceneIdSchema.parse(state.scene_id);
  try {
    for (const upload of state.uploads || []) {
      const file = files.find(file => file.filename === upload.filename && !sources.find(source => source.filename === file.filename)?.base64);
      if (!file || upload.method !== 'PUT' || !upload.url || new URL(upload.url).protocol !== 'https:' || upload.headers?.['Content-Type'] !== file.mediaType) throw new Error('Invalid scene upload instructions.');
      // Signed storage transfers never carry the API key or follow redirects.
      if (await digestHandle(file.handle, file.bytes) !== file.sha256) throw new Error('Scene source changed before upload.');
      const stream = file.handle.createReadStream({ start: 0, end: file.bytes - 1, autoClose: false });
      try {
        const result = await client.fetch(upload.url, { method: 'PUT', headers: { 'Content-Type': file.mediaType, 'Content-Length': String(file.bytes) }, body: stream, duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(120000) });
        if (!result.ok) throw new Error(`Scene source upload failed (HTTP ${result.status}).`);
      } finally { stream.destroy(); }
    }
    // Upload completion starts the shared service automatically; never call generate.
    return state.uploads?.length ? await getScene(client, sceneId) : state;
  } catch (error) {
    throw new Error(redactUrlSecrets(`Scene upload did not complete. Scene ${sceneId} belongs to request_id ${p.request_id}; preserve both IDs and replay the original inputs. No automatic retry was made.`));
  }
  } finally { await closeSources(files); }
}
/**
 * Reads a scene. The body includes `next_message`, which says what a message sent now would do
 * (`relay`, `answer`, `resume`, `continue`, `retry_start` or `none`), whether it needs text or
 * `confirm_spend`, and the `expected_head` to pin it to. `next_message` is null only when the
 * server could not read the scene's state.
 */
export function getScene(client, sceneId) { return client.request(route(sceneId)); }
/**
 * Sends one message to a scene (`POST scene-generations/{id}/messages`). The server decides the effect from
 * the scene's state, in this order, and shows it beforehand as `next_message.action`:
 * - `retry_start`: a start refused before any run is retried with its original request; `text` is not applied;
 *   needs `confirmSpend`; result `start_retried`.
 * - `answer`: the scene waits on its question; `text` is the answer; result `answered`.
 * - `resume`: the scene is parked at a checkpoint that takes no answer; `text` goes to its director; result `resumed`.
 * - `relay`: the scene is running; `text` goes to its director; result `relayed`, or `queued` until it can take it.
 * - `continue`: the scene ended (delivered, best checkpoint, stopped, held in review) and can be continued; the whole
 *   scene continues as new paid work and needs `confirmSpend`; `text` is required when the ending takes an answer
 *   (`next_message.requires_text`); `regenerateObjects` only applies here; result `continued`.
 * - `none`: refused with 409 `scene_not_messageable` and a `reason` (403 `insufficient_tokens` for a missing balance).
 * The server then checks `expected_head` (409 `scene_head_moved`, with the current `expected_head`), required `text`
 * (400 `scene_message_text_required`), `regenerate_objects` (409 `scene_object_regeneration_unavailable`) and spend
 * consent (409 `confirm_spend_required`, with `next_message`). A message never stops a scene.
 * The receipt is `{ scene_id, message, scene }`; `message` has `request_id`, `action`, `expected_head`,
 * `instruction_applied`, `guidance_status`, `regenerate_objects`, `price_basis`, `replayed` and `at`.
 * Omitting `requestId` generates one; it is returned on the receipt and on errors. The same ID and body replay the
 * receipt; a refusal (HTTP 4xx) records nothing, so a corrected request may reuse the ID, except after 409
 * `request_id_reused`. After 503 `scene_message_unconfirmed` or a lost response, send the same ID and body again.
 * A 403 `insufficient_tokens` refusal starts nothing and never resumes on its own: top up, then send the message again.
 */
export async function messageScene(client, sceneId, input = {}) {
  const id = sceneIdSchema.parse(sceneId);
  const p = messageSceneSchema.parse(input);
  const requestId = p.requestId ?? randomUUID();
  const body = {
    request_id: requestId,
    ...(p.text !== undefined ? { text: p.text } : {}),
    ...(p.confirmSpend ? { confirm_spend: true } : {}),
    ...(p.expectedHead ? { expected_head: p.expectedHead } : {}),
    ...(p.regenerateObjects ? { regenerate_objects: p.regenerateObjects } : {})
  };
  try { return await client.request(`${route(id)}/messages`, { method: 'POST', body, structuredErrors: true }); }
  catch (error) {
    error.request_id = requestId;
    const status = error.http_status ?? error.status;
    if (error.code === 'request_id_reused') {
      error.message = `${error.message} Message request_id ${requestId} belongs to a different message; send this one under a new request_id.`;
    } else if (Number.isInteger(status) && status < 500) {
      // A refused message leaves no record on the scene, so nothing resumes or replays by itself.
      if (error.billing_guidance) {
        error.billing_guidance = { ...error.billing_guidance, message: 'Nothing was sent to the scene. Top up the shared organization/workspace balance in the Palatial dashboard so the net balance is above zero, then send the message again; the same request_id may be reused.' };
        error.message = `Insufficient credits (HTTP ${status}). ${error.billing_guidance.message}`;
      }
      error.message = `${error.message} Message request_id ${requestId} was refused and nothing was recorded; the same request_id may carry a corrected message.`;
    } else {
      error.message = `${error.message} Message request_id ${requestId}: the outcome is unknown; send the same request_id and body again to learn it. A new request_id is a new message.`;
    }
    throw error;
  }
}
export function listScenes(client, input) {
  const { workspace, ...query } = listScenesSchema.parse(input);
  return client.request(`workspaces/${workspace}/scene-generations${Object.keys(query).length ? `?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}` : ''}`);
}
/** @deprecated Use messageScene; kept working as an alias of a message that answers or continues. */
export function answerScene(client, input) { const { scene_id, ...body } = answerSceneSchema.parse(input); return client.request(`${route(scene_id)}/answer`, { method: 'POST', body }); }
export function cancelScene(client, sceneId) { return client.request(`${route(sceneId)}/stop`, { method: 'POST', body: {} }); }
/** @deprecated Use messageScene without text; kept working as an alias of a message that resumes or continues. */
export function recoverScene(client, input) { const { scene_id, ...body } = recoverSceneSchema.parse(input); return client.request(`${route(scene_id)}/recover`, { method: 'POST', body }); }
/** @deprecated Use messageScene with confirmSpend when next_message.action is retry_start. */
export function retrySceneStart(client, input) { const { scene_id, ...body } = retrySceneStartSchema.parse(input); return client.request(`${route(scene_id)}/retry-start`, { method: 'POST', body }); }
function publishedReceipt(receipt, extras) {
  const output = {
    scene_id: receipt.scene_id, version: receipt.version, file: receipt.file, sha256: receipt.sha256, bytes: receipt.bytes, api_origin: receipt.api_origin,
    validation: 'not_inspected', simulator_acceptance: 'not_tested'
  };
  if (typeof receipt.downloaded_at === 'string' && receipt.downloaded_at.length <= 40) output.downloaded_at = receipt.downloaded_at;
  return { ...output, ...extras };
}
async function loadReceipt(receiptPath) {
  const bytes = await readCappedRegularFile(receiptPath, receiptLimit, {
    link: 'Scene download receipt must be a small regular file.',
    size: 'Scene download receipt exceeds the size limit.'
  });
  if (bytes === null) return { exists: false, parsed: null };
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    return { exists: true, parsed: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null };
  } catch { return { exists: true, parsed: null }; }
}
async function assertMissing(filename) {
  try { await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Output already exists. Choose a new output directory.');
}
async function confirmedVersion(client, sceneId) {
  const parsed = sceneDigestSchema.safeParse((await getScene(client, sceneId))?.download?.version);
  return parsed.success ? parsed.data : null;
}
export async function downloadScene(client, input) {
  const { scene_id, output_dir, version: requestedVersion } = downloadSceneSchema.parse(input);
  const directory = await resolveOutputDirectory(output_dir);
  const version = requestedVersion || sceneDigestSchema.parse((await getScene(client, scene_id)).download?.version);
  const stem = `${scene_id}-scene-${version.slice(7, 19)}`;
  const destination = path.join(directory, `${stem}.zip`);
  const receiptPath = path.join(directory, `${stem}-receipt.json`);
  const loaded = await loadReceipt(receiptPath);
  const receipt = loaded.parsed;
  const metadataMatches = Boolean(receipt && receipt.scene_id === scene_id && receipt.version === version && receipt.api_origin === client.base.origin && receipt.file === destination && receipt.sha256 === version.slice(7));
  if (metadataMatches) {
    let info;
    try { info = await lstat(destination); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info) {
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('Scene archive must be a regular file before it can be reused.');
      if (!Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 || receipt.bytes > client.maxDownloadBytes || info.size > client.maxDownloadBytes) throw new Error('Scene archive exceeds the client download limit.');
      if (info.size === receipt.bytes) {
        const archived = await digestRegularFile(destination, client.maxDownloadBytes);
        if (archived.sha256 === receipt.sha256 && (!requestedVersion || await confirmedVersion(client, scene_id) === version)) {
          return publishedReceipt({ scene_id, version, file: destination, sha256: archived.sha256, bytes: archived.size, downloaded_at: receipt.downloaded_at, api_origin: client.base.origin }, { receipt_file: receiptPath, cached: true });
        }
      }
    }
  }
  await assertMissing(destination);
  if (loaded.exists) await unlink(receiptPath);
  await mkdir(directory, { recursive: true });
  await assertResolvedDirectory(directory);
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
    return publishedReceipt(receipt, { receipt_file: receiptPath, cached: false });
  } finally { await file.close(); if (!complete) await unlink(destination).catch(() => {}); }
}

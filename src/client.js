import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const DEFAULT_API_URL = 'https://dashboard.palatial.cloud/api/v1/external/';
const engine = z.enum(['isaac_sim', 'mujoco', 'newton']);
export const assetIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'Invalid asset ID.');
export const createSchema = z.object({
  source: z.enum(['text', 'image', 'cad']).describe('Input type: text prompt, one or more reference images, or CAD mesh plus a reference image.'),
  name: z.string().min(4).max(50).describe('Asset name, 4-50 characters.'),
  description: z.string().min(1).max(500).describe('What to build, including dimensions, materials, articulation, and intended use when known.'),
  workspace: z.string().min(1).describe('All sources: optional workspace ID; omit to use the API-key workspace.').optional(),
  engine: z.array(engine).min(1).max(3).default(['isaac_sim']).describe('All sources: simulator profiles; isaac_sim, mujoco, or newton; defaults to isaac_sim.').optional(),
  image_path: z.string().describe('Image: one PNG/JPEG input; CAD: required PNG/JPEG reference; use instead of views.').optional(),
  image_paths: z.array(z.string()).min(2).max(50).describe('Image with parametric shape_model: 2-50 PNG/JPEG inputs of the same object; each is uploaded as a file.').optional(),
  views: z.object({ front: z.string().describe('Image multiview: front PNG/JPEG path.').optional(), left: z.string().describe('Image multiview: left PNG/JPEG path.').optional(), back: z.string().describe('Image multiview: back PNG/JPEG path.').optional(), right: z.string().describe('Image multiview: right PNG/JPEG path.').optional() }).strict().describe('Image only: named views of one object; provide at least two.').optional(),
  mesh_path: z.string().describe('CAD only: path to the mesh file.').optional(),
  datasheet_path: z.string().describe('CAD only: optional PDF datasheet.').optional(),
  create_articulation: z.boolean().describe('All sources: create joints for moving parts such as doors or wheels.').optional(),
  enable_parts_segmentation: z.boolean().describe('All sources: split into rigid parts; false for one rigid mesh, true for separate parts.').optional(),
  run_simulation: z.boolean().describe('All sources: request physics validation.').optional(),
  mesh_quality: z.enum(['low', 'medium', 'high']).describe('Image and text only: mesh quality preset; not used for CAD.').optional(),
  collision_quality: z.enum(['low', 'medium', 'high', 'x_high', 'sdf']).describe('Image, text, and CAD: collision quality; sdf means signed-distance-field collision.').optional(),
  shape_model: z.enum(['auto', 'diffusion', 'parametric']).describe('Image and text only: auto selects automatically; diffusion is faster, cheaper, and better for organic shapes and accepts one or multiview images; parametric is controllable, better for articulation, and accepts N images (up to 50).').optional(),
  texture_model: z.literal('auto').describe('Image, text, and CAD: auto selects the supported texture model.').optional(),
  decimation: z.boolean().describe('Image, text, and CAD: legacy adaptive reduction switch; prefer decimation_mode.').optional(),
  optimize_textures: z.boolean().describe('Image, text, and CAD: downscale oversized maps without upscaling smaller maps.').optional(),
  texture_max_resolution: z.union([z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096), z.literal(8192)]).describe('Image, text, and CAD: maximum texture edge; smaller maps are never upscaled.').optional(),
  triangle_count: z.enum(['minimal', 'low', 'medium', 'high', 'x_high', 'auto']).describe('Image, text, and CAD: legacy triangle preset; fixed values become strict targets when decimation is enabled.').optional(),
  mesh_density: z.enum(['low', 'medium', 'high']).describe('Image, text, and CAD: density used when triangle_count is auto.').optional(),
  apply_textures: z.boolean().describe('CAD only: generate textures from the reference image.').optional(),
  units: z.enum(['m', 'cm', 'mm', 'inch', 'feet']).describe('Text and CAD: source units; convert them once rather than guessing scale.').optional(),
  up_direction: z.enum(['x', 'y', 'z']).describe('Text and CAD: source up axis.').optional(),
  texture_size: z.union([z.literal(2048), z.literal(4096), z.literal(8192)]).describe('Image, text, and CAD: texture size; 2048, 4096, or 8192.').optional(),
  decimation_mode: z.enum(['auto', 'strict']).describe('Image, text, and CAD: auto is quality-driven; strict requires exactly one explicit target.').optional(),
  decimation_target_faces: z.number().int().min(4).max(10000000).describe('Image, text, and CAD strict mode: maximum 4-10,000,000 faces; exclusive with ratio.').optional(),
  decimation_target_ratio: z.number().min(0.001).max(0.999).describe('Image, text, and CAD strict mode: retain 0.001-0.999 of source faces; mutually exclusive with face target.').optional()
}).strict();

function validateCreate(input) {
  const p = createSchema.parse(input);
  const views = Object.entries(p.views || {}).filter(([, file]) => file);
  if (p.source === 'text' && (p.image_path || p.image_paths || views.length || p.mesh_path || p.datasheet_path)) throw new Error('Text generation does not accept input files.');
  const imageInputs = Number(Boolean(p.image_path)) + Number(Boolean(p.image_paths)) + Number(views.length > 0);
  if (p.source === 'image' && imageInputs !== 1) throw new Error('Image generation requires image_path, image_paths, or named views.');
  if (p.source === 'image' && views.length && views.length < 2) throw new Error('Multiview requires at least two views of the same object.');
  if (p.source === 'image' && p.image_paths && p.shape_model !== 'parametric') throw new Error('image_paths is supported only with shape_model=parametric.');
  if (p.source === 'image' && p.shape_model === 'diffusion' && views.length > 4) throw new Error('diffusion accepts a single image or up to four named views.');
  if (p.source === 'image' && (p.mesh_path || p.datasheet_path)) throw new Error('mesh_path and datasheet_path are only accepted for CAD.');
  if (p.source === 'cad' && (!p.mesh_path || !p.image_path || views.length)) throw new Error('CAD requires mesh_path and a reference image_path; named views are not accepted.');
  if (p.source === 'cad' && (p.mesh_quality || p.shape_model)) throw new Error('mesh_quality and shape_model are not used for CAD input.');
  if (p.source === 'image' && (p.units || p.up_direction)) throw new Error('units and up_direction are not accepted for image input; include requested dimensions and orientation in the description.');
  const targets = Number(p.decimation_target_faces !== undefined) + Number(p.decimation_target_ratio !== undefined);
  if ((p.decimation_mode === 'strict' && targets !== 1) || (p.decimation_mode !== 'strict' && targets)) throw new Error('Strict decimation requires exactly one target; targets are not accepted in other modes.');
  return p;
}

export function statusValue(record) {
  return typeof record?.status === 'string' ? record.status : record?.status?.status;
}

function safeMessage(error, secret) {
  let message = error instanceof Error ? error.message : 'Palatial request failed.';
  if (secret) message = message.split(secret).join('[REDACTED]');
  return message.replace(/https?:\/\/[^\s"']+/g, raw => {
    try { const url = new URL(raw); return url.origin + url.pathname; } catch { return '[URL]'; }
  });
}

async function sha256File(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export class PalatialClient {
  constructor({ apiKey, baseUrl = DEFAULT_API_URL, fetchImpl = fetch, allowHttpForTests = false, timeoutMs = 30000, maxDownloadBytes = 2 * 1024 ** 3, receiptDir = process.env.PALATIAL_STATE_DIR || path.join(homedir(), '.local', 'state', 'palatial-agent') } = {}) {
    if (!apiKey?.trim()) throw new Error('Missing Palatial API key.');
    this.apiKey = apiKey.trim();
    this.base = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
    if (this.base.username || this.base.password || this.base.search || this.base.hash) throw new Error('API URL must not contain credentials, query parameters, or a fragment.');
    if (this.base.protocol !== 'https:' && !(allowHttpForTests && ['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname) && this.base.protocol === 'http:')) throw new Error('Palatial API requires HTTPS.');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxDownloadBytes = maxDownloadBytes;
    this.receiptDir = receiptDir;
  }

  async request(route, { method = 'GET', body, raw = false } = {}) {
    const url = new URL(route, this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname)) throw new Error('Request is outside the configured API.');
    const headers = { 'x-api-key': this.apiKey, Accept: 'application/json' };
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await this.fetch(url, { method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, redirect: raw ? 'manual' : 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const uncertain = method !== 'GET' ? ' The server may have accepted the request. Check your workspace before submitting again; this client does not retry mutations.' : '';
      throw new Error(safeMessage(error, this.apiKey) + uncertain);
    }
    if (raw && response.status >= 300 && response.status < 400) return response;
    if (!response.ok) {
      const reason = { 400: 'Invalid request', 401: 'Invalid or expired API key', 403: 'Access denied or insufficient credits', 404: 'Asset or workspace not found', 409: 'Request conflicts with asset state', 429: 'Rate limit reached' }[response.status] || 'Service request failed';
      throw new Error(`${reason} (HTTP ${response.status}).${method !== 'GET' && response.status >= 500 ? ' Submission outcome is uncertain; inspect your workspace before retrying.' : ''}`);
    }
    if (raw) return response;
    try { return await response.json(); } catch { throw new Error('Palatial returned an invalid JSON response. For a create request, inspect your workspace before submitting again.'); }
  }

  async doctor() {
    const workspaces = await this.request('workspaces');
    const items = Array.isArray(workspaces) ? workspaces : Array.isArray(workspaces?.data) ? workspaces.data : undefined;
    return { authenticated: true, creation_authorization: 'not_verified', api_origin: this.base.origin, ...(items ? { workspace_count: items.length } : {}), message: 'Read-only connectivity check passed. Creating assets also requires workspace owner context and credits; this check does not verify those permissions.' };
  }

  async create(input) {
    const p = validateCreate(input);
    const { source, image_path, image_paths, views, mesh_path, datasheet_path, ...parameters } = p;
    let body = parameters;
    if (source !== 'text') {
      body = new FormData();
      for (const [key, value] of Object.entries(parameters)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) body.append(key, String(item));
      }
      const addFile = async (field, filename, kind) => {
        const absolute = path.resolve(filename);
        const ext = path.extname(absolute).toLowerCase();
        if (kind === 'image' && !['.png', '.jpg', '.jpeg'].includes(ext)) throw new Error('Reference images must be PNG or JPEG.');
        if (kind === 'pdf' && ext !== '.pdf') throw new Error('Datasheets must be PDF.');
        const info = await stat(absolute);
        if (!info.isFile() || info.size > 256 * 1024 ** 2) throw new Error('Input must be a regular file of at most 256 MiB.');
        const type = ext === '.png' ? 'image/png' : ['.jpg', '.jpeg'].includes(ext) ? 'image/jpeg' : ext === '.pdf' ? 'application/pdf' : 'application/octet-stream';
        body.append(field, new Blob([await readFile(absolute)], { type }), path.basename(absolute));
      };
      if (source === 'image') {
        if (image_path) await addFile('file', image_path, 'image');
        else if (image_paths) for (const filename of image_paths) await addFile('file', filename, 'image');
        else for (const [view, file] of Object.entries(views)) if (file) await addFile(view, file, 'image');
      } else {
        await addFile('mesh', mesh_path, 'mesh');
        await addFile('image', image_path, 'image');
        if (datasheet_path) await addFile('datasheet', datasheet_path, 'pdf');
      }
    }
    // Persist intent before the network write. This is recovery evidence, not
    // backend idempotency: an ambiguous submission must never be auto-retried.
    const requestId = randomUUID();
    const requestReceipt = path.join(this.receiptDir, `${requestId}.json`);
    await mkdir(this.receiptDir, { recursive: true, mode: 0o700 });
    const intent = { request_id: requestId, name: p.name, source, engine: p.engine, api_origin: this.base.origin, submitted_at: new Date().toISOString(), status: 'submission_outcome_unknown' };
    await writeFile(requestReceipt, JSON.stringify(intent, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    let result;
    try {
      result = await this.request(`assets/create/${{ text: 'texttosim', image: 'imagetosim', cad: 'cadtosim' }[source]}`, { method: 'POST', body });
    } catch (error) {
      throw new Error(`${safeMessage(error, this.apiKey)} Recovery receipt: ${requestReceipt}`);
    }
    const assetId = result?.id;
    if (typeof assetId !== 'string' || !assetIdSchema.safeParse(assetId).success) throw new Error(`Create response did not contain a valid asset ID. The job may exist: inspect the Palatial dashboard before submitting again. Recovery receipt: ${requestReceipt}`);
    const created = { asset_id: assetId, status: statusValue(result) || 'SUBMITTED', dashboard_url: this.base.origin, request_id: requestId, receipt_file: requestReceipt, message: 'Save this asset ID. Use palatial_get_asset to track it; do not submit again to poll.' };
    try { await writeFile(requestReceipt, JSON.stringify({ ...intent, ...created }, null, 2) + '\n', { mode: 0o600 }); }
    catch { created.receipt_warning = 'Asset was submitted successfully, but the local receipt could not be updated. Save asset_id from this response.'; }
    return created;
  }

  async getAsset(assetId) {
    assetIdSchema.parse(assetId);
    const record = await this.request(`assets/${assetId}/status`);
    const status = statusValue(record) || 'UNKNOWN';
    const result = { asset_id: assetId, status, details: record };
    if (status === 'READY') result.ready_means = 'Outputs are available; inspect validation evidence and test in your target simulator.';
    if (status === 'PROCESSING_FAILED') result.failure_guidance = {
      message: 'Processing failed. Preserve this asset ID and inspect the dashboard or available validation evidence.',
      failed_stage: record.failedStageKey || record.failed_stage || record.stage || null,
      refund: 'Charges for failed stages are refunded.',
      reprocessing: 'Reprocessing charges only for the remaining stages. Confirm before starting it.',
      next_steps: ['Check whether an export is available.', 'Open the asset in the Palatial dashboard.', 'Contact support with this asset ID if the failure is unclear.']
    };
    return result;
  }

  async getAssetDetails(assetId) { assetIdSchema.parse(assetId); return this.request(`assets/${assetId}`); }
  async listAssets({ search, status, limit = 20, skip = 0 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(skip) || skip < 0) throw new Error('limit must be 1-100 and skip must be non-negative.');
    const filter = { limit, skip, where: { ...(search ? { search } : {}), ...(status ? { 'status.status': status } : {}) } };
    return this.request(`assets?filter=${encodeURIComponent(JSON.stringify(filter))}`);
  }
  async batchStatus(assetIds) { return this.request('assets/statuses', { method: 'POST', body: { ids: z.array(assetIdSchema).min(1).max(100).parse(assetIds) } }); }
  async pipelineProgress(assetId) { assetIdSchema.parse(assetId); return this.request(`assets/${assetId}/pipeline-runs/current`); }
  async reprocess(assetId, input) {
    assetIdSchema.parse(assetId);
    const body = z.object({ from: z.string().min(1).max(100), mode: z.enum(['step', 'auto']).optional(), stopAfter: z.string().min(1).max(100).optional(), sourceRunId: z.string().min(1).max(128).optional(), destination: z.enum(['overwrite', 'variant']).optional(), feedback: z.string().max(4000).optional() }).strict().parse(input);
    return this.request(`assets/${assetId}/reprocess`, { method: 'POST', body });
  }

  async createVariant(assetId, input) {
    assetIdSchema.parse(assetId);
    const body = z.object({
      feedback: z.string().trim().min(1).max(2000),
      name: z.string().min(4).max(50).optional(),
      description: z.string().min(1).max(500).optional(),
      parameters: z.record(z.string(), z.unknown()).optional()
    }).strict().parse(input);
    const result = await this.request(`assets/${assetId}/variants`, { method: 'POST', body });
    const variantId = result?.id;
    if (typeof variantId !== 'string' || !assetIdSchema.safeParse(variantId).success) {
      throw new Error('Variant response did not contain a valid asset ID. Inspect the Palatial dashboard before retrying.');
    }
    return { asset_id: variantId, parent_asset_id: assetId, status: statusValue(result) || 'SUBMITTED', details: result, message: 'Variant created as an independent asset. Use palatial_get_asset to track it; do not submit again to poll.' };
  }

  async cancel(assetId) {
    assetIdSchema.parse(assetId);
    return this.request(`assets/${assetId}/cancel-processing`, { method: 'DELETE' });
  }

  async download(assetId, outputDir) {
    assetIdSchema.parse(assetId);
    const directory = path.resolve(outputDir);
    const destination = path.join(directory, `${assetId}-export.zip`);
    const receiptPath = path.join(directory, `${assetId}-receipt.json`);
    // A matching receipt avoids a second billable export request after success.
    try {
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
      if (receipt.asset_id === assetId && receipt.file === destination) {
        const checksum = await sha256File(destination);
        if (checksum === receipt.sha256) return { ...receipt, receipt_file: receiptPath, cached: true };
      }
      throw new Error('Existing download receipt is invalid. Choose a new output directory.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const file of [destination, receiptPath]) {
      try { await stat(file); throw new Error('Output already exists. Choose a new output directory; no export was requested.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const current = await this.getAsset(assetId);
    if (current.status !== 'READY' && current.status !== 'PROCESSING_FAILED') throw new Error(`Asset is ${current.status}; wait until processing completes before exporting.`);
    await mkdir(directory, { recursive: true });
    // Reserve the destination before asking for a billable export.
    const file = await open(destination, 'wx', 0o600);
    let complete = false;
    try {
      let response = await this.request(`assets/${assetId}/media/export`, { raw: true });
      for (let hop = 0; response.status >= 300 && response.status < 400; hop++) {
        if (hop >= 5) throw new Error('Too many export redirects.');
        const location = response.headers.get('location');
        if (!location) throw new Error('Export redirect is missing a URL.');
        const url = new URL(location, response.url || new URL(`assets/${assetId}/media/export`, this.base));
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Export download requires a credential-free HTTPS URL.');
        const sameApi = url.origin === this.base.origin && url.pathname.startsWith(this.base.pathname);
        response = await this.fetch(url, { redirect: 'manual', headers: sameApi ? { 'x-api-key': this.apiKey } : {}, signal: AbortSignal.timeout(120000) });
      }
      if (!response.ok || !response.body) throw new Error(`Export download failed (HTTP ${response.status}).`);
      const mime = response.headers.get('content-type') || '';
      if (/json|text\/html/i.test(mime)) throw new Error('Export endpoint returned a document instead of an archive.');
      const hash = createHash('sha256');
      let bytes = 0;
      let signature = Buffer.alloc(0);
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > this.maxDownloadBytes) throw new Error('Export exceeds the 2 GiB client download limit.');
        if (signature.length < 4) signature = Buffer.concat([signature, Buffer.from(chunk)]).subarray(0, 4);
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      if (!['504b0304', '504b0506', '504b0708'].includes(signature.toString('hex'))) throw new Error('Downloaded file is not a ZIP archive.');
      await file.sync();
      const receipt = { asset_id: assetId, file: destination, sha256: hash.digest('hex'), bytes, downloaded_at: new Date().toISOString(), api_origin: this.base.origin, validation: 'not_inspected', simulator_acceptance: 'not_tested' };
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      complete = true;
      return { ...receipt, receipt_file: receiptPath, cached: false };
    } catch (error) {
      throw new Error(safeMessage(error, this.apiKey) + (current.status === 'PROCESSING_FAILED' ? ' No export package was available for this failed job; failed-stage charges are refunded. Reprocessing charges only for remaining stages and requires confirmation.' : ' No automatic export retry was made; an export credit may already have been consumed.'));
    } finally {
      await file.close();
      if (!complete) await unlink(destination).catch(() => {});
    }
  }
}

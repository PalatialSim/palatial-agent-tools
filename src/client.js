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
  source: z.enum(['text', 'image', 'cad']),
  name: z.string().min(4).max(50),
  description: z.string().min(1).max(500),
  engine: z.array(engine).min(1).max(3).default(['isaac_sim']),
  image_path: z.string().optional(),
  views: z.object({ front: z.string().optional(), left: z.string().optional(), back: z.string().optional(), right: z.string().optional() }).strict().optional(),
  mesh_path: z.string().optional(),
  datasheet_path: z.string().optional(),
  create_articulation: z.boolean().optional(),
  enable_parts_segmentation: z.boolean().optional(),
  run_simulation: z.boolean().optional(),
  units: z.enum(['m', 'cm', 'mm', 'inch', 'feet']).optional(),
  up_direction: z.enum(['x', 'y', 'z']).optional(),
  texture_size: z.union([z.literal(2048), z.literal(4096), z.literal(8192)]).optional(),
  decimation_mode: z.enum(['auto', 'strict']).optional(),
  decimation_target_faces: z.number().int().min(4).max(10000000).optional(),
  decimation_target_ratio: z.number().min(0.001).max(0.999).optional()
}).strict();

function validateCreate(input) {
  const p = createSchema.parse(input);
  const views = Object.entries(p.views || {}).filter(([, file]) => file);
  if (p.source === 'text' && (p.image_path || views.length || p.mesh_path || p.datasheet_path)) throw new Error('Text generation does not accept input files.');
  if (p.source === 'image' && (Boolean(p.image_path) === Boolean(views.length))) throw new Error('Image generation requires one image_path OR at least two named views.');
  if (p.source === 'image' && views.length && views.length < 2) throw new Error('Multiview requires at least two views of the same object.');
  if (p.source === 'image' && (p.mesh_path || p.datasheet_path)) throw new Error('mesh_path and datasheet_path are only accepted for CAD.');
  if (p.source === 'cad' && (!p.mesh_path || !p.image_path || views.length)) throw new Error('CAD requires mesh_path and a reference image_path; named views are not accepted.');
  if (p.source !== 'cad' && (p.units || p.up_direction)) throw new Error('units and up_direction are CAD-only parameters. Include requested dimensions in the description for other inputs.');
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
    const { source, image_path, views, mesh_path, datasheet_path, ...parameters } = p;
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
    return { asset_id: assetId, status: statusValue(record) || 'UNKNOWN', details: record, ready_means: 'Outputs are available; inspect validation evidence and test in your target simulator.' };
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
    if (current.status !== 'READY') throw new Error(`Asset is ${current.status}; wait for READY before exporting.`);
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
      throw new Error(safeMessage(error, this.apiKey) + ' No automatic export retry was made; an export credit may already have been consumed.');
    } finally {
      await file.close();
      if (!complete) await unlink(destination).catch(() => {});
    }
  }
}

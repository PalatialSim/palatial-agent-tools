import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const DEFAULT_API_URL = 'https://dashboard.palatial.cloud/api/v1/external/';
const engine = z.enum(['isaac_sim', 'mujoco', 'newton']);
const assetName = z.string().trim().min(4).max(50).regex(/^[a-zA-Z\d_\-.\s]+$/, 'Asset name may contain only letters, digits, spaces, underscores, hyphens, and periods.');
export const assetIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'Invalid asset ID.');
export const createSchema = z.object({
  source: z.enum(['text', 'image', 'cad']).describe('Input type: text prompt, one or more reference images, or a CAD mesh with an optional reference image.'),
  name: assetName.describe('Asset name, 4-50 characters: letters, digits, spaces, underscores, hyphens, and periods.'),
  description: z.string().trim().min(1).max(500).describe('What to build, including dimensions, materials, articulation, and intended use when known.'),
  workspace: z.string().regex(/^[a-fA-F0-9]{24}$/, 'Workspace must be a 24-character MongoDB ObjectId.').describe('All sources: optional workspace ID; omit to use the API-key workspace.').optional(),
  engine: z.array(engine).min(1).max(3).default(['isaac_sim']).describe('All sources: simulator profiles; isaac_sim, mujoco, or newton; defaults to isaac_sim.').optional(),
  image_path: z.string().describe('Image: one PNG/JPEG/WebP input; CAD: optional PNG/JPEG/WebP reference for texture generation; use instead of views.').optional(),
  image_paths: z.array(z.string()).min(2).max(50).describe('Image with parametric shape_model: 2-50 PNG/JPEG/WebP inputs of the same object; each is uploaded as a file.').optional(),
  views: z.object({ front: z.string().describe('Image multiview: front PNG/JPEG/WebP path.').optional(), left: z.string().describe('Image multiview: left PNG/JPEG/WebP path.').optional(), back: z.string().describe('Image multiview: back PNG/JPEG/WebP path.').optional(), right: z.string().describe('Image multiview: right PNG/JPEG/WebP path.').optional() }).strict().describe('Image only: named views of one object; provide at least two.').optional(),
  reconstruct: z.boolean().describe('Legacy image option accepted by the API but currently ignored by the Queue. It does not generate views from one image or change how supplied views are processed.').optional(),
  mesh_path: z.string().describe('CAD only: path to the mesh file.').optional(),
  datasheet_path: z.string().describe('CAD only: optional PDF datasheet.').optional(),
  create_articulation: z.boolean().describe('All sources: create joints for moving parts such as doors or wheels.').optional(),
  enable_parts_segmentation: z.boolean().describe('All sources: split into rigid parts; false for one rigid mesh, true for separate parts.').optional(),
  run_simulation: z.boolean().describe('All sources: request physics validation.').optional(),
  body_type: z.enum(['rigid_bodies', 'soft_bodies', 'mixed_bodies']).describe('All sources: what the object is made to behave like. rigid_bodies is a solid object, soft_bodies deforms (cloth, garments, cable), mixed_bodies has both. Soft bodies simulate in Newton, so include newton in engine.').optional(),
  newton_solver: z.enum(['mujoco', 'style3D', 'vbd']).describe('All sources: Newton solver. Soft bodies accept only vbd; rigid bodies accept mujoco or style3D. Read only when engine includes newton.').optional(),
  repair_mesh: z.boolean().describe('All sources: close holes and fix bad geometry after generation.').optional(),
  replace_glass: z.boolean().describe('All sources: rebuild transparent or translucent parts as real glass. Set it for clear plastic, acrylic, resin, crystal, and lenses, not only for glass.').optional(),
  auto_scale: z.boolean().describe('All sources: scale the finished asset to the real-world size stated in the description.').optional(),
  mesh_quality: z.enum(['low', 'medium', 'high']).describe('Image and text only: mesh quality preset; not used for CAD.').optional(),
  collision_quality: z.enum(['low', 'medium', 'high', 'x_high', 'sdf']).describe('Image, text, and CAD: collision quality; sdf means signed-distance-field collision.').optional(),
  shape_model: z.enum(['auto', 'diffusion', 'parametric']).describe('Image and text only: auto lets Palatial select a supported generation route; diffusion is faster, cheaper, and better for organic shapes and accepts one image or named multiview inputs; parametric is controllable, better for articulation, and accepts N images (up to 50).').optional(),
  effort: z.enum(['low', 'medium', 'mad_max']).describe('Text and image with shape_model=parametric only: low uses the parametric pipeline; medium and mad_max use the research and authoring route, cost more, and take longer. CAD does not support them.').optional(),
  texture_model: z.literal('auto').describe('Image, text, and CAD: auto selects the supported texture model.').optional(),
  decimation: z.boolean().describe('Image, text, and CAD: legacy adaptive reduction switch; prefer decimation_mode.').optional(),
  optimize_textures: z.boolean().describe('Image, text, and CAD: downscale oversized maps without upscaling smaller maps.').optional(),
  texture_max_resolution: z.union([z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096), z.literal(8192)]).describe('Image, text, and CAD: maximum texture edge; smaller maps are never upscaled.').optional(),
  triangle_count: z.enum(['minimal', 'low', 'medium', 'high', 'x_high', 'auto']).describe('Image, text, and CAD: legacy triangle preset; fixed values become strict targets when decimation is enabled.').optional(),
  mesh_density: z.enum(['low', 'medium', 'high']).describe('Image, text, and CAD: density used when triangle_count is auto.').optional(),
  apply_textures: z.boolean().describe('CAD only: generate textures from the reference image.').optional(),
  regenerate_parts: z.boolean().describe('CAD only: split the supplied mesh into parts again instead of keeping the parts it already has.').optional(),
  keep_existing_textures: z.boolean().describe('CAD only: keep the textures the mesh already has. Incompatible with apply_textures=true.').optional(),
  keep_existing_shape: z.boolean().describe('CAD only: keep the shape and parts the mesh already has. Incompatible with regenerate_parts=true.').optional(),
  physics_validation_only: z.boolean().describe('CAD only: keep both the existing shape and the existing textures and run only collision, physics and validation. Incompatible with regenerate_parts=true and with apply_textures=true.').optional(),
  units: z.enum(['m', 'cm', 'mm', 'inch', 'feet']).describe('Text and direct-mesh CAD: source units; convert them once rather than guessing scale.').optional(),
  meters_per_unit: z.number().positive().finite().describe('Direct-mesh CAD only: exact meters represented by one source unit; alternative to named units.').optional(),
  up_direction: z.enum(['x', 'y', 'z']).describe('Text and non-USD CAD: source up axis.').optional(),
  texture_size: z.union([z.literal(2048), z.literal(4096), z.literal(8192)]).describe('Image, text, and CAD: texture size; 2048, 4096, or 8192.').optional(),
  decimation_mode: z.enum(['auto', 'strict']).describe('Image, text, and CAD: auto is quality-driven; strict requires exactly one explicit target.').optional(),
  decimation_target_faces: z.number().int().min(4).max(10000000).describe('Image, text, and CAD strict mode: maximum 4-10,000,000 faces; exclusive with ratio.').optional(),
  decimation_target_ratio: z.number().min(0.001).max(0.999).describe('Image, text, and CAD strict mode: retain 0.001-0.999 of source faces; mutually exclusive with face target.').optional()
}).strict();

const DIRECT_MESH_EXTENSIONS = new Set(['.obj', '.glb', '.gltf', '.stl', '.ply', '.fbx']);
const AXIS_ONLY_CAD_EXTENSIONS = new Set(['.step', '.stp', '.iges', '.igs']);
const SOURCE_AUTHORED_CAD_EXTENSIONS = new Set(['.usd', '.usda', '.usdc', '.usdz']);

export function validateCreate(input) {
  if (input && typeof input === 'object' && String(input.shape_model).toLowerCase() === 'mad_max') {
    throw new Error('mad_max is a generation route reported on finished assets (generationAgent), not a shape_model. To request it, send shape_model=parametric with effort=mad_max.');
  }
  const p = createSchema.parse(input);
  const views = Object.entries(p.views || {}).filter(([, file]) => file);
  if (p.source === 'text' && (p.image_path || p.image_paths || views.length || p.mesh_path || p.datasheet_path)) throw new Error('Text generation does not accept input files.');
  if (p.source !== 'cad' && p.apply_textures !== undefined) throw new Error('apply_textures is accepted only for CAD input.');
  // The reuse flags decide what NOT to rebuild from a mesh the user supplied,
  // so they mean nothing where there is no supplied mesh.
  const cadOnlyReuse = ['regenerate_parts', 'keep_existing_textures', 'keep_existing_shape', 'physics_validation_only'];
  if (p.source !== 'cad') {
    const offered = cadOnlyReuse.filter((field) => p[field] !== undefined);
    if (offered.length) throw new Error(`${offered.join(' and ')} ${offered.length > 1 ? 'are' : 'is'} accepted only for CAD input.`);
  }
  // Keeping the existing shape and rebuilding its parts are opposite requests.
  if (p.regenerate_parts === true && p.keep_existing_shape === true) throw new Error('keep_existing_shape and regenerate_parts=true ask for opposite things. Choose one.');
  if (p.regenerate_parts === true && p.physics_validation_only === true) throw new Error('physics_validation_only keeps the existing shape, so it cannot be combined with regenerate_parts=true.');
  // Both of these turn texture generation off, so asking for textures too is contradictory.
  if (p.apply_textures === true && p.keep_existing_textures === true) throw new Error('keep_existing_textures turns texture generation off, so it cannot be combined with apply_textures=true.');
  if (p.apply_textures === true && p.physics_validation_only === true) throw new Error('physics_validation_only keeps the existing textures, so it cannot be combined with apply_textures=true.');
  // The API silently coerces a solver the body type cannot use. An agent that
  // asked for one and quietly got another has no way to notice, so refuse the
  // pair instead and name the value that body type accepts.
  if (p.body_type === 'soft_bodies' && p.newton_solver && p.newton_solver !== 'vbd') throw new Error('Soft bodies accept only newton_solver=vbd.');
  if (p.body_type === 'rigid_bodies' && p.newton_solver === 'vbd') throw new Error('vbd is the soft-body solver. Rigid bodies accept newton_solver=mujoco or style3D.');
  const imageInputs = Number(Boolean(p.image_path)) + Number(Boolean(p.image_paths)) + Number(views.length > 0);
  if (p.source === 'image' && imageInputs !== 1) throw new Error('Image generation requires image_path, image_paths, or named views.');
  if (p.source === 'image' && views.length && views.length < 2) throw new Error('Multiview requires at least two views of the same object.');
  if (p.source === 'image' && p.image_paths && p.shape_model !== 'parametric') throw new Error('image_paths is supported only with shape_model=parametric.');
  if (p.source !== 'image' && p.reconstruct !== undefined) throw new Error('reconstruct is accepted only for image input.');
  if (p.reconstruct !== undefined && ['medium', 'mad_max'].includes(p.effort)) throw new Error('The legacy reconstruct option is not accepted with medium or mad_max effort.');
  if (p.source === 'image' && ['auto', 'diffusion'].includes(p.shape_model) && views.length > 4) throw new Error('auto and diffusion accept a single image or up to four named views.');
  if (p.source === 'image' && (p.mesh_path || p.datasheet_path)) throw new Error('mesh_path and datasheet_path are only accepted for CAD.');
  if (p.source === 'cad' && (!p.mesh_path || p.image_paths || views.length)) throw new Error('CAD requires mesh_path; image_path is optional, and image_paths and named views are not accepted.');
  if (p.source === 'cad' && (p.mesh_quality || p.shape_model || p.effort)) throw new Error('mesh_quality, shape_model, and effort are not used for CAD input.');
  if (p.effort && p.shape_model !== 'parametric') throw new Error('effort applies to shape_model=parametric only.');
  if (p.source !== 'cad' && p.meters_per_unit !== undefined) throw new Error('meters_per_unit is accepted only for direct-mesh CAD input.');
  if (p.source === 'image' && (p.units || p.up_direction)) throw new Error('units and up_direction are not accepted for image input; include requested dimensions and orientation in the description.');
  if (p.source === 'cad' && !p.image_path && p.apply_textures === true) throw new Error('apply_textures=true requires a CAD reference image_path.');
  if (p.source === 'cad') {
    const extension = path.extname(p.mesh_path).toLowerCase();
    // A direct mesh without a reference image can stay untextured, but an
    // explicit keep-existing promise still needs authored appearance evidence.
    // Only GLB can carry embedded texture bytes that the API will inspect.
    if (DIRECT_MESH_EXTENSIONS.has(extension) && extension !== '.glb') {
      const keeping = (p.image_path && p.apply_textures === false) || p.keep_existing_textures === true || p.physics_validation_only === true;
      if (keeping) throw new Error('This direct mesh cannot preserve an authored appearance from a single upload. Use a GLB with embedded textures, supply USD/STEP/IGES, or let textures be generated.');
    }
    if (DIRECT_MESH_EXTENSIONS.has(extension)) {
      if ((!p.units && p.meters_per_unit === undefined) || !p.up_direction) throw new Error('OBJ, GLB, GLTF, STL, PLY, and FBX inputs require up_direction and either units or meters_per_unit.');
      if (p.units && p.meters_per_unit !== undefined) {
        const namedScale = { m: 1, cm: 0.01, mm: 0.001, inch: 0.0254, feet: 0.3048 }[p.units];
        if (namedScale !== p.meters_per_unit) throw new Error('units and meters_per_unit conflict; choose one source scale.');
      }
    } else if (AXIS_ONLY_CAD_EXTENSIONS.has(extension)) {
      if (!p.up_direction) throw new Error('STEP and IGES inputs require up_direction.');
      if (p.units) throw new Error('STEP and IGES inputs carry canonical scale through conversion; omit units and provide up_direction only.');
      if (p.meters_per_unit !== undefined) throw new Error('STEP and IGES inputs carry canonical scale; omit meters_per_unit.');
    } else if (SOURCE_AUTHORED_CAD_EXTENSIONS.has(extension)) {
      if (p.units || p.up_direction || p.meters_per_unit !== undefined) throw new Error('USD inputs use authored stage units and up-axis metadata; omit units, meters_per_unit, and up_direction.');
    } else {
      throw new Error('Unsupported CAD format. Use OBJ, GLB, GLTF, STL, PLY, FBX, STEP, STP, IGES, IGS, USD, USDA, USDC, or USDZ.');
    }
  }
  const targets = Number(p.decimation_target_faces !== undefined) + Number(p.decimation_target_ratio !== undefined);
  if ((p.decimation_mode === 'strict' && targets !== 1) || (p.decimation_mode !== 'strict' && targets)) throw new Error('Strict decimation requires exactly one target; targets are not accepted in other modes.');
  return p;
}

export function statusValue(record) {
  return typeof record?.status === 'string' ? record.status : record?.status?.status;
}

/**
 * Public generation route published on asset reads. The API reports how a
 * finished asset was built as `generationAgent`: `diffusion`, `parametric`,
 * or `mad_max`. It is a read-side label. It is not a `shape_model` value:
 * `shape_model` accepts `auto`, `diffusion`, or `parametric`, and a Mad Max
 * build is requested with `shape_model: parametric` plus `effort: mad_max`.
 */
export const PUBLIC_GENERATION_ROUTES = Object.freeze(['diffusion', 'parametric', 'mad_max']);
export function generationRoute(record) {
  const value = record?.generationAgent ?? record?.generation_agent;
  return typeof value === 'string' && PUBLIC_GENERATION_ROUTES.includes(value) ? value : null;
}
export function createOptionsForRoute(route) {
  if (route === 'mad_max') return { shape_model: 'parametric', effort: 'mad_max' };
  if (route === 'parametric' || route === 'diffusion') return { shape_model: route };
  return {};
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
        if (kind === 'image' && !['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('Reference images must be PNG, JPEG, or WebP.');
        if (kind === 'pdf' && ext !== '.pdf') throw new Error('Datasheets must be PDF.');
        const info = await stat(absolute);
        if (!info.isFile() || info.size > 256 * 1024 ** 2) throw new Error('Input must be a regular file of at most 256 MiB.');
        const type = ext === '.png' ? 'image/png' : ['.jpg', '.jpeg'].includes(ext) ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.pdf' ? 'application/pdf' : 'application/octet-stream';
        body.append(field, new Blob([await readFile(absolute)], { type }), path.basename(absolute));
      };
      if (source === 'image') {
        if (image_path) await addFile('file', image_path, 'image');
        else if (image_paths) for (const filename of image_paths) await addFile('file', filename, 'image');
        else for (const [view, file] of Object.entries(views)) if (file) await addFile(view, file, 'image');
      } else {
        await addFile('mesh', mesh_path, 'mesh');
        if (image_path) await addFile('image', image_path, 'image');
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
    const route = generationRoute(record);
    if (route) {
      result.generation_route = route;
      result.generation_route_means = route === 'mad_max'
        ? 'Built by the Mad Max research and authoring route. To request the same route on a new asset use shape_model=parametric with effort=mad_max; mad_max is not a shape_model value.'
        : `Built with the ${route} shape model.`;
    }
    if (status === 'READY') result.ready_means = 'Outputs are available; inspect validation evidence and test in your target simulator.';
    if (status === 'PROCESSING_FAILED') result.failure_guidance = {
      message: 'Processing failed. Preserve this asset ID and inspect the dashboard or available validation evidence.',
      failed_stage: record.failedStageKey || record.failed_stage || record.stage || null,
      refund: 'Charges for failed stages are refunded.',
      reprocessing: 'Reprocessing charges only for the remaining stages. Confirm before starting it.',
      next_steps: ['Open the asset in the Palatial dashboard.', 'Ask the user before requesting a partial or unvalidated export, because export uses credits.', 'Contact support with this asset ID if the failure is unclear.']
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

  async download(assetId, outputDir, { allowFailedExport = false } = {}) {
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
    if (current.status === 'PROCESSING_FAILED' && !allowFailedExport) throw new Error('Asset processing failed. A partial or unvalidated export may exist, but requesting it uses export credits. Ask the user first, then retry with allow_failed_export=true.');
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
      const receipt = { asset_id: assetId, file: destination, sha256: hash.digest('hex'), bytes, downloaded_at: new Date().toISOString(), api_origin: this.base.origin, source_status: current.status, ...(current.status === 'PROCESSING_FAILED' ? { export_classification: 'partial_or_unvalidated' } : {}), validation: 'not_inspected', simulator_acceptance: 'not_tested' };
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

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { VERSION } from './version.js';

export const HANDOFF_SCHEMA = 'palatial.isaac.handoff/v1';
export const HANDOFF_FILENAME = 'palatial-handoff.json';
export const HANDOFF_DIRNAME = '.palatial';
export const DEFAULT_HANDOFF_DISPLAY = '~/.palatial/palatial-handoff.json';

export function homeDirectory(env = process.env) {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  if (!home) throw new Error('Cannot resolve home directory for the Isaac handoff file.');
  return home;
}

export function wellKnownHandoffPath(env = process.env) {
  return path.join(homeDirectory(env), HANDOFF_DIRNAME, HANDOFF_FILENAME);
}

export function defaultHandoffPath(env = process.env) {
  return env.PALATIAL_HANDOFF_PATH?.trim() || wellKnownHandoffPath(env);
}

const assetIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'Invalid asset ID.');
const engineSchema = z.enum(['isaac_sim', 'mujoco', 'newton']);

export const handoffSchema = z.object({
  schema: z.literal(HANDOFF_SCHEMA),
  asset_id: assetIdSchema,
  status: z.string().min(1).max(80),
  import_ready: z.boolean(),
  dashboard_url: z.string().url(),
  name: z.string().min(1).max(50).nullable(),
  source: z.enum(['text', 'image', 'cad']).nullable(),
  generation_type: z.enum(['texttosim', 'imagetosim', 'cadtosim']).nullable(),
  engine: z.array(engineSchema).min(1).max(3),
  workspace_id: z.string().min(1).max(128).nullable(),
  export: z.object({
    owner: z.literal('plugin'),
    mcp_should_download: z.literal(false)
  }).strict(),
  written_at: z.string().min(1),
  client: z.object({
    name: z.literal('@palatial/agent-tools'),
    version: z.string().min(1)
  }).strict()
}).strict();

export function resolveHandoffPath(outputPath, env = process.env) {
  const raw = (outputPath || defaultHandoffPath(env)).trim();
  if (!raw) throw new Error('Handoff path cannot be empty.');
  const resolved = path.resolve(raw);
  if (path.extname(resolved).toLowerCase() !== '.json') throw new Error('Handoff path must be a .json file.');
  return resolved;
}

export function viewerUrl(assetId, origin = 'https://dashboard.palatial.cloud') {
  assetIdSchema.parse(assetId);
  return `${String(origin).replace(/\/$/, '')}/viewer/${assetId}`;
}

export function inferGenerationType(details) {
  const type = String(details?.type || details?.generation_type || details?.generationType || '').toLowerCase();
  if (type.includes('cad')) return 'cadtosim';
  if (type.includes('text')) return 'texttosim';
  if (type.includes('image')) return 'imagetosim';
  return null;
}

export function inferSource(generationType) {
  return { texttosim: 'text', imagetosim: 'image', cadtosim: 'cad' }[generationType] || null;
}

export function detailsFields(details) {
  if (!details || typeof details !== 'object') return {};
  const parameters = details.parameters && typeof details.parameters === 'object' ? details.parameters : {};
  let engine = parameters.engine;
  if (typeof engine === 'string') engine = [engine];
  const generation_type = inferGenerationType(details);
  const workspace = details.workspaceId || details.workspace_id || (typeof details.workspace === 'string' ? details.workspace : details.workspace?.id);
  return {
    name: typeof details.name === 'string' && details.name.trim() ? details.name.trim().slice(0, 50) : null,
    workspace_id: typeof workspace === 'string' && workspace.trim() ? workspace.trim().slice(0, 128) : null,
    engine: Array.isArray(engine) ? engine.filter(item => engineSchema.safeParse(item).success) : undefined,
    generation_type,
    source: inferSource(generation_type)
  };
}

export function isaacPluginGuidance(assetId, origin, { ready = false } = {}) {
  return {
    viewer_url: viewerUrl(assetId, origin),
    write_handoff: ready
      ? 'This asset is READY for the Palatial Isaac Sim plugin. Call palatial_write_isaac_handoff and do not palatial_download_asset; the plugin spends the export credit.'
      : 'If this asset is for the Palatial Isaac Sim plugin, poll with palatial_get_asset, then palatial_write_isaac_handoff. Do not palatial_download_asset; the plugin spends the export credit.'
  };
}

export function buildHandoff({
  asset_id,
  status,
  api_origin,
  name = null,
  source = null,
  generation_type = null,
  engine,
  workspace_id = null,
  version = VERSION,
  written_at
} = {}) {
  return handoffSchema.parse({
    schema: HANDOFF_SCHEMA,
    asset_id,
    status: status || 'UNKNOWN',
    import_ready: status === 'READY',
    dashboard_url: viewerUrl(asset_id, api_origin),
    name,
    source,
    generation_type,
    engine: engine?.length ? engine : ['isaac_sim'],
    workspace_id,
    export: { owner: 'plugin', mcp_should_download: false },
    written_at: written_at || new Date().toISOString(),
    client: { name: '@palatial/agent-tools', version }
  });
}

export async function writeHandoffFile(payload, outputPath, env = process.env) {
  const document = handoffSchema.parse(payload);
  const file = resolveHandoffPath(outputPath, env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(document, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return file;
}

export async function readHandoffFile(outputPath, env = process.env) {
  return handoffSchema.parse(JSON.parse(await readFile(resolveHandoffPath(outputPath, env), 'utf8')));
}

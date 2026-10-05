import { z } from 'zod';

const DIFFUSION_FIELDS = ['mesh_quality', 'collision_quality', 'triangle_count', 'mesh_density', 'decimation', 'decimation_mode', 'decimation_target_faces', 'decimation_target_ratio', 'texture_size', 'optimize_textures', 'texture_max_resolution', 'run_simulation', 'body_type', 'newton_solver', 'repair_mesh', 'replace_glass', 'auto_scale'];
const LOW_FIELDS = ['collision_quality', 'run_simulation', 'optimize_textures', 'replace_glass', 'newton_solver'];
const FLAT_FIELDS = [...DIFFUSION_FIELDS, 'shape_model', 'texture_model', 'quad_topo', 'enable_parts_segmentation', 'create_articulation', 'units', 'up_direction', 'reconstruct'];

// Keep the field types shared with legacy/CAD requests. The route controls
// which of these settings is meaningful, rather than silently dropping it.
export function modeFields(flat) {
  return {
    mode: z.enum(['diffusion', 'parametric', 'mad_max']).describe('Text/image: prefer an explicit mode. parametric uses effort low (default) or mad_max; mode mad_max is shorthand. CAD has no mode. Build settings go inside parameters.').optional(),
    parameters: z.object({
      ...Object.fromEntries(DIFFUSION_FIELDS.map(field => [field, flat[field]])),
      structure: z.enum(['single_object', 'static_parts', 'articulated_parts']).describe('Diffusion only: one solid object, separate rigid parts (default), or parts with joints.').optional(),
      articulation: z.boolean().describe('Parametric Low only: create joints; defaults to false.').optional(),
      face_budget: z.number().int().min(2000).max(200000).describe('Parametric Low only: authored face budget, 2,000-200,000; defaults to 100,000.').optional()
    }).strict().describe('Route-specific build settings. Diffusion accepts structure, mesh, texture, collision and physics settings. Parametric Low accepts articulation, face_budget, collision_quality, run_simulation, optimize_textures, replace_glass and a rigid newton_solver. Mad Max and every video request require an empty object or omission.').optional()
  };
}

export function createRoute(p) {
  return { model: p.mode === 'mad_max' ? 'parametric' : p.mode || p.shape_model || 'auto', effort: p.mode === 'mad_max' ? 'mad_max' : p.effort || 'low' };
}

export function validateMode(p, ctx) {
  const refuse = (code, message, path = []) => ctx.addIssue({ code: 'custom', message: `${code}: ${message}`, path });
  if (!p.mode) {
    if (p.parameters !== undefined) refuse('CREATE_MODE_REQUIRED', 'parameters requires mode.', ['parameters']);
    return;
  }
  if (p.source === 'cad') refuse('CREATE_MODE_FIELD_CONFLICT', 'CAD accepts flat settings and has no mode.', ['mode']);
  const conflict = FLAT_FIELDS.filter(field => p[field] !== undefined);
  if (conflict.length) refuse('CREATE_MODE_FIELD_CONFLICT', `With mode, move or remove top-level build settings: ${conflict.join(', ')}.`);
  if ((p.mode === 'diffusion' && p.effort) || (p.mode === 'mad_max' && p.effort && p.effort !== 'mad_max')) refuse('CREATE_EFFORT_INVALID', 'effort applies only to parametric; mode=mad_max accepts only effort=mad_max.', ['effort']);
  const { model, effort } = createRoute(p);
  const researches = Boolean(p.video_path) || model === 'parametric' && effort === 'mad_max';
  if (p.product_research !== undefined && !researches) refuse('CREATE_PRODUCT_RESEARCH_UNSUPPORTED', 'product_research requires Mad Max or a video.', ['product_research']);
  const allowed = p.video_path || model === 'parametric' && effort === 'mad_max' ? [] : model === 'diffusion' ? ['structure', ...DIFFUSION_FIELDS] : ['articulation', 'face_budget', ...LOW_FIELDS];
  const unsupported = Object.keys(p.parameters || {}).filter(field => !allowed.includes(field));
  if (unsupported.length) refuse('CREATE_PARAMETERS_INVALID', `${unsupported.join(', ')} is unsupported for this route. ${allowed.length ? `Supported: ${allowed.join(', ')}.` : 'Mad Max and video builds take no build parameters.'}`, ['parameters']);
  if (model === 'parametric' && p.parameters?.newton_solver === 'vbd') refuse('CREATE_PARAMETERS_INVALID', 'Parametric Low is rigid and accepts newton_solver=mujoco or style3D.', ['parameters', 'newton_solver']);
}

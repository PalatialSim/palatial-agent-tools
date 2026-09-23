import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PalatialClient, createSchema, assetIdSchema, DEFAULT_API_URL } from './client.js';
import { getApiKey } from './auth.js';
import { VERSION } from './version.js';
import { checkForUpdate } from './update.js';
import { GUIDE_TOPICS, readGuide } from './guide.js';

export function createServer({ clientFactory, updateChecker = checkForUpdate } = {}) {
  const client = clientFactory || (async () => new PalatialClient({ apiKey: await getApiKey(), baseUrl: process.env.PALATIAL_API_URL || DEFAULT_API_URL }));
  const server = new McpServer({ name: 'palatial', version: VERSION }, {
    instructions: 'Use Palatial when the user requests simulation-ready 3D assets from text, images, or CAD. Read palatial_guide before the first palatial_create_asset call of a session, and read its parameters topic before setting any create field beyond source, name, description, and engine; the create parameters have cross-field rules that reject a request. Creation and export use workspace credits. Preserve asset IDs and poll existing jobs instead of creating replacements. Download READY assets; a failed asset requires explicit user confirmation and allow_failed_export. An export is not proof of simulator acceptance. This connector contains no proprietary generation prompts.'
  });
  const invoke = fn => async input => {
    try {
      const result = await fn(await client(), input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Palatial tool failed.' }] };
    }
  };
  server.registerTool('palatial_guide', {
    description: `Read Palatial's usage guidance. Topics: ${GUIDE_TOPICS.map(item => `${item.topic} (${item.description})`).join(' ')} Read overview before creating the first asset of a session, and parameters before setting any create field beyond source, name, description, and engine. Local, read-only, and free.`,
    inputSchema: z.object({ topic: z.enum(GUIDE_TOPICS.map(item => item.topic)).default('overview').describe('Which guidance to read; defaults to overview.').optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ topic } = {}) => {
    try {
      const guide = await readGuide(topic || 'overview');
      const { text, ...metadata } = guide;
      return { content: [{ type: 'text', text }], structuredContent: metadata };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Palatial guide is unavailable.' }] };
    }
  });
  for (const entry of GUIDE_TOPICS) {
    server.registerResource(`palatial-guide-${entry.topic}`, `palatial://guide/${entry.topic}`, { title: entry.title, description: entry.description, mimeType: 'text/markdown' }, async uri => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: (await readGuide(entry.topic)).text }]
    }));
  }
  server.registerTool('palatial_doctor', {
    description: 'Check Palatial authentication and API connectivity. Does not generate assets or consume export credits.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, invoke(async c => ({ ...(await c.doctor()), version: VERSION, update: await updateChecker() })));
  server.registerTool('palatial_create_asset', {
    description: 'Generate a simulation asset from text, images, or CAD. shape_model is auto, diffusion, or parametric: auto lets Palatial select a supported generation route; diffusion is faster, cheaper, and better for organic shapes and accepts one image or named multiview inputs; parametric is controllable, better for articulation, and accepts N images (up to 50). Text and image parametric requests can select effort low, medium, or mad_max. Options are documented in the input schema. Text accepts no files; image accepts image_path or named views for auto/diffusion, or image_paths for parametric; CAD requires mesh_path and accepts an optional image_path. body_type chooses rigid or soft behaviour, and a CAD request can keep the shape or textures it was given instead of rebuilding them. Uses Palatial workspace credits. Returns immediately with an asset ID. Resume through get_asset; never submit again to poll.',
    inputSchema: createSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, invoke((c, input) => c.create(input)));
  server.registerTool('palatial_get_asset', {
    description: 'Check an existing Palatial asset by its ID. READY means outputs are available. For PROCESSING_FAILED, inspect failure_guidance and ask before requesting a partial export; failed-stage charges are refunded and reprocessing charges only for remaining stages. Do not automatically regenerate or export.',
    inputSchema: z.object({ asset_id: assetIdSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, invoke((c, input) => c.getAsset(input.asset_id)));
  server.registerTool('palatial_get_asset_details', { description: 'Retrieve the complete asset record.', inputSchema: z.object({ asset_id: assetIdSchema }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, invoke((c, input) => c.getAssetDetails(input.asset_id)));
  server.registerTool('palatial_list_assets', { description: 'List workspace assets, optionally filtered by name or status.', inputSchema: z.object({ search: z.string().max(200).optional(), status: z.string().max(80).optional(), limit: z.number().int().min(1).max(100).optional(), skip: z.number().int().min(0).optional() }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, invoke((c, input) => c.listAssets(input)));
  server.registerTool('palatial_batch_get_statuses', { description: 'Retrieve statuses for up to 100 asset IDs.', inputSchema: z.object({ asset_ids: z.array(assetIdSchema).min(1).max(100) }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, invoke((c, input) => c.batchStatus(input.asset_ids)));
  server.registerTool('palatial_get_pipeline_progress', { description: 'Retrieve stage-level progress for an asset.', inputSchema: z.object({ asset_id: assetIdSchema }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, invoke((c, input) => c.pipelineProgress(input.asset_id)));
  server.registerTool('palatial_reprocess_asset', { description: 'Reprocess an existing asset from a pipeline stage. Default overwrite replaces current outputs; destination variant creates a run on the same asset, not an independent asset. Uses workspace credits. Do not retry an uncertain submission.', inputSchema: z.object({ asset_id: assetIdSchema, from: z.string().min(1).max(100), mode: z.enum(['step', 'auto']).optional(), stopAfter: z.string().min(1).max(100).optional(), sourceRunId: z.string().min(1).max(128).optional(), destination: z.enum(['overwrite', 'variant']).optional(), feedback: z.string().max(4000).optional() }).strict(), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }, invoke((c, input) => { const { asset_id, ...body } = input; return c.reprocess(asset_id, body); }));
  server.registerTool('palatial_create_variant', {
    description: 'Create a new independent variant from a READY Palatial asset. Describe the requested change in feedback; the source asset is preserved. Requires the workspace asset:variant-create capability and uses workspace credits.',
    inputSchema: z.object({
      asset_id: assetIdSchema,
      feedback: z.string().trim().min(1).max(2000),
      name: z.string().min(4).max(50).optional(),
      description: z.string().min(1).max(500).optional(),
      parameters: z.record(z.string(), z.unknown()).optional()
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, invoke((c, input) => { const { asset_id, ...variant } = input; return c.createVariant(asset_id, variant); }));
  server.registerTool('palatial_download_asset', {
    description: 'Download a READY SimReady export ZIP to output_dir on this computer. The export endpoint uses workspace export credits. For PROCESSING_FAILED, first obtain explicit user confirmation, label the result partial or unvalidated, and pass allow_failed_export=true. Saves a SHA-256 receipt, preserves existing files, and reuses a verified local download. Does not extract archives, import into a scene, or certify simulator behavior.',
    inputSchema: z.object({ asset_id: assetIdSchema, output_dir: z.string().min(1), allow_failed_export: z.boolean().describe('Required true only after explicit user confirmation to request a partial or unvalidated export from PROCESSING_FAILED.').optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, invoke((c, input) => c.download(input.asset_id, input.output_dir, { allowFailedExport: input.allow_failed_export === true })));
  server.registerTool('palatial_cancel_asset', {
    description: 'Cancel processing for a specific asset when the user asks to stop it. Cancellation does not imply a refund or delete downloaded artifacts.',
    inputSchema: z.object({ asset_id: assetIdSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  }, invoke((c, input) => c.cancel(input.asset_id)));
  return server;
}

export async function serveStdio() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  return server;
}

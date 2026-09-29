import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PalatialClient, PalatialApiError, createSchema, assetIdSchema, DEFAULT_API_URL } from './client.js';
import { getApiKey } from './auth.js';
import { VERSION } from './version.js';
import { checkForUpdate } from './update.js';
import { GUIDE_TOPICS, readGuide } from './guide.js';

export function createServer({ clientFactory, updateChecker = checkForUpdate } = {}) {
  const client = clientFactory || (async () => new PalatialClient({ apiKey: await getApiKey(), baseUrl: process.env.PALATIAL_API_URL || DEFAULT_API_URL }));
  const server = new McpServer({ name: 'palatial', version: VERSION }, {
    instructions: 'Use Palatial when the user requests simulation-ready 3D assets from text, images, or CAD. Read palatial_guide before the first palatial_create_asset call of a session, and read its parameters topic before setting any create field beyond source, name, description, and engine; the create parameters have cross-field rules that reject a request. New-generation admission uses route minimums (Diffusion 20, Parametric Low 40, Mad Max 80, CAD to Sim 4 tokens); a positive balance alone is sufficient only for continuation or reprocessing when the server permits it. Charges settle only as stages complete; the estimated total is not prepaid. Low recommended balance warnings are advisory. At zero or negative balance, an already-running stage may finish and the next stage waits. A normal PROCESSING_PAUSED checkpoint (billing.paused=false, run.awaitingContinue=true) continues automatically in about a minute while the balance is above 0; a credit pause (billing.paused=true, pauseReason=insufficient_credits) needs a posted top-up before the same asset resumes. Show billing_guidance and preserve asset IDs; never retry generation, create a replacement, or start checkout automatically. Export itself is free; the server decides whether a materialized export key is available. A failed asset requires explicit user confirmation and allow_failed_export. An export is not proof of simulator acceptance. This connector contains no proprietary generation prompts.'
  });
  const invoke = (fn, { arrayKey = 'data' } = {}) => async input => {
    try {
      const result = await fn(await client(), input);
      // MCP structuredContent must be a record. Keep the raw result in the
      // text channel for compatibility, and wrap array-valued API responses
      // for clients that validate the protocol result schema.
      const structuredContent = Array.isArray(result) ? { [arrayKey]: result } : result;
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent };
    } catch (error) {
      if (error instanceof PalatialApiError) {
        const result = error.toJSON();
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      }
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
    description: 'Check Palatial authentication and API connectivity. Read-only; does not generate assets or consume tokens.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, invoke(async c => ({ ...(await c.doctor()), version: VERSION, update: await updateChecker() })));
  server.registerTool('palatial_create_asset', {
    description: 'Generate a simulation asset from text, images, or CAD. shape_model is auto, diffusion, or parametric: auto lets Palatial select a supported generation route; diffusion is faster, cheaper, and better for organic shapes and accepts one image or named multiview inputs; parametric is controllable, better for articulation, and accepts N images (up to 50). Text and image parametric requests can select effort low or mad_max. An image mad_max request can set product_research to specs_only (no web images) or off (no web lookup) to build only from its own images. Options are documented in the input schema. Text accepts no files; image accepts image_path or named views for auto/diffusion, or image_paths for parametric; CAD requires mesh_path and accepts an optional image_path. body_type chooses rigid or soft behaviour, and a CAD request can keep the shape or textures it was given instead of rebuilding them. New generations need the route minimum: diffusion 20, parametric low 40, mad_max 80, or CAD to Sim 4 tokens. A start-gate 403 returns tokens.required, tokens.balance, and tokens.shortfall; nothing is created, so add tokens and submit once. Charges settle as stages complete. Returns immediately with an asset ID and available billing metadata. Resume through get_asset; never submit again to poll.',
    inputSchema: createSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, invoke((c, input) => c.create(input)));
  server.registerTool('palatial_get_asset', {
    description: 'Check an existing Palatial asset by its ID. READY means outputs are available. A normal PROCESSING_PAUSED checkpoint between stages (billing.paused=false, run.awaitingContinue=true) continues automatically in about a minute while the balance is above 0; keep polling the same asset and do not reprocess or create. For a credit pause, report billing_guidance: a posted top-up must make the shared net balance positive, then processing resumes on the same asset. Running stages can finish at a nonpositive balance. For PROCESSING_FAILED, inspect failure_guidance and ask before requesting a partial export; only successfully completed stages are charged. Do not automatically regenerate or export.',
    inputSchema: z.object({ asset_id: assetIdSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, invoke((c, input) => c.getAsset(input.asset_id)));
  server.registerTool('palatial_get_asset_details', { description: 'Retrieve the complete asset record.', inputSchema: z.object({ asset_id: assetIdSchema }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, invoke((c, input) => c.getAssetDetails(input.asset_id)));
  server.registerTool('palatial_list_assets', { description: 'List workspace assets, optionally filtered by name or status.', inputSchema: z.object({ search: z.string().max(200).optional(), status: z.string().max(80).optional(), limit: z.number().int().min(1).max(100).optional(), skip: z.number().int().min(0).optional() }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, invoke((c, input) => c.listAssets(input), { arrayKey: 'data' }));
  server.registerTool('palatial_batch_get_statuses', { description: 'Retrieve statuses for up to 100 asset IDs.', inputSchema: z.object({ asset_ids: z.array(assetIdSchema).min(1).max(100) }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, invoke((c, input) => c.batchStatus(input.asset_ids), { arrayKey: 'statuses' }));
  server.registerTool('palatial_get_pipeline_progress', { description: 'Retrieve stage-level progress for an asset.', inputSchema: z.object({ asset_id: assetIdSchema }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, invoke((c, input) => c.pipelineProgress(input.asset_id)));
  server.registerTool('palatial_reprocess_asset', { description: 'Reprocess an existing asset from a pipeline stage. Default overwrite replaces current outputs; destination variant creates a run on the same asset, not an independent asset. A researching job (effort mad_max, or a create with a video) that failed before it reached the pipeline takes no from: the call retries its failed research or model build at the same price as the Dashboard retry, and says so when nothing can be retried. Uses per-stage completion billing. A normal between-stage checkpoint continues automatically in about a minute while the balance is above 0; keep polling. Credit-paused jobs resume automatically after a sufficient posted top-up; do not reprocess them to resume. Do not retry an uncertain submission.', inputSchema: z.object({ asset_id: assetIdSchema, from: z.string().min(1).max(100).optional(), mode: z.enum(['step', 'auto']).optional(), stopAfter: z.string().min(1).max(100).optional(), sourceRunId: z.string().min(1).max(128).optional(), destination: z.enum(['overwrite', 'variant']).optional(), feedback: z.string().max(4000).optional() }).strict(), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }, invoke((c, input) => { const { asset_id, ...body } = input; return c.reprocess(asset_id, body); }));
  server.registerTool('palatial_create_variant', {
    description: 'Create a new independent variant from a READY Palatial asset. Describe the requested change in feedback; the source asset is preserved. Requires the workspace asset:variant-create capability and the server admission balance for the route; charges tokens as stages complete.',
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
    description: 'Download an available SimReady export ZIP to output_dir on this computer. Export itself does not consume tokens. A first export needs a positive shared net balance; a later paused run is downloadable only when the server has a materialized export key. For PROCESSING_FAILED, first obtain explicit user confirmation, label the result partial or unvalidated, and pass allow_failed_export=true. Saves a SHA-256 receipt, preserves existing files, and reuses a verified READY download. Does not extract archives, import into a scene, or certify simulator behavior.',
    inputSchema: z.object({ asset_id: assetIdSchema, output_dir: z.string().min(1), allow_failed_export: z.boolean().describe('Required true only after explicit user confirmation to request a partial or unvalidated export from PROCESSING_FAILED.').optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, invoke((c, input) => c.download(input.asset_id, input.output_dir, { allowFailedExport: input.allow_failed_export === true })));
  server.registerTool('palatial_cancel_asset', {
    description: 'Cancel processing for a specific asset when the user asks to stop it. This also stops a researching job that is still researching or waiting for its build to start, so its build never starts. Cancellation does not imply a refund or delete downloaded artifacts.',
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

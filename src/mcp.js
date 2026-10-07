import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PalatialClient, PalatialApiError, mcpCreateSchema, mcpCreateInput, reprocessSchema, assetIdSchema, DEFAULT_API_URL } from './client.js';
import { getApiKey } from './auth.js';
import { VERSION } from './version.js';
import { checkForUpdate } from './update.js';
import { GUIDE_TOPICS, readGuide } from './guide.js';
import { checkDocs, DOCS_ORIGIN, API_DOCS_URL } from './docs.js';

export function createServer({ clientFactory, updateChecker = checkForUpdate, docsChecker = checkDocs, startupDocs = { status: 'not_checked', changed: null } } = {}) {
  let docsStatus = startupDocs;
  const docsInstructions = `Live reference: ${API_DOCS_URL}. Startup documentation check: ${startupDocs.status}; ${startupDocs.changed_pages?.length || 0} changed pages. Call palatial_check_docs to inspect startup changes and refresh the live site. Read changed pages before using affected options, and report mismatches with the installed schema. For new text/image creates, prefer mode=diffusion or mode=parametric with effort=low/mad_max and route-specific parameters; Mad Max and every video build take no build parameters. `;
  const client = clientFactory || (async () => new PalatialClient({ apiKey: await getApiKey(), baseUrl: process.env.PALATIAL_API_URL || DEFAULT_API_URL }));
  const server = new McpServer({ name: 'palatial', version: VERSION }, {
    instructions: docsInstructions + 'Use Palatial when the user requests simulation-ready 3D assets from text, images, or CAD. Read palatial_guide before the first palatial_create_asset call of a session, and read its parameters topic before setting any create field beyond source, name, description, and engine; the create parameters have cross-field rules that reject a request. New-generation admission uses route minimums (Diffusion 20, Parametric Low 20, Mad Max 80, CAD to Sim 4 tokens); a positive balance alone is sufficient only for continuation or reprocessing when the server permits it. Charges settle only as stages complete; the estimated total is not prepaid. Low recommended balance warnings are advisory. At zero or negative balance, an already-running stage may finish and the next stage waits. A normal PROCESSING_PAUSED checkpoint (billing.paused=false, run.awaitingContinue=true) continues automatically in about a minute while the balance is above 0; a credit pause (billing.paused=true, pauseReason=insufficient_credits) needs a posted top-up before the same asset resumes. Show billing_guidance and preserve asset IDs; never retry generation, create a replacement, or start checkout automatically. Export itself is free; the server decides whether a materialized export key is available. A failed asset requires explicit user confirmation and allow_failed_export. An export is not proof of simulator acceptance. This connector contains no proprietary generation prompts.'
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
  }, invoke(async c => ({ ...(await c.doctor()), version: VERSION, update: await updateChecker(), docs: docsStatus })));
  server.registerTool('palatial_check_docs', {
    description: `Check ${DOCS_ORIGIN} directly for documentation changes. Re-fetches the sitemap and articles, compares persistent content hashes, and returns changed page links and added/removed excerpts plus the startup check. No Palatial credentials, generation, or charges. The check does not change the client schema.`,
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async () => {
    docsStatus = await docsChecker();
    const result = { ...docsStatus, startup_check: startupDocs };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });
  server.registerTool('palatial_create_asset', {
    description: 'Generate a simulation asset from text, photos, video, or CAD. For text/image use mode=diffusion, or mode=parametric with effort=low (default) or mad_max; mode=mad_max is shorthand. Put build settings in parameters. Diffusion controls structure, mesh density, textures and physics. Parametric Low authors rigid parts and accepts articulation, face_budget (2,000-200,000), collision_quality, run_simulation, optimize_textures and a rigid newton_solver. Mad Max and every video build require empty parameters. Diffusion takes one image_path or 2-4 named views; Parametric Low takes up to 50 photos on image_path/image_paths/views. Video accepts MP4/MOV up to 300 MiB and 60 seconds, alone or with photos on any route. Mad Max takes one engine and up to 8 photos (7 with a scanned GLB reference_mesh_path, also supported for text). Mad Max and video builds accept product_research on/specs_only/off; narrowed research needs photos or video. The MCP builds rigid assets, omits shape_model, texture_model, body_type, auto_scale and replace_glass, and offers collision_quality=auto/low/medium/high/sdf. auto leaves the API collision override unset (currently medium on Diffusion/Low); Mad Max picks proxies itself. Text/image calls require mode. CAD requires mesh_path, optional image_path, flat settings and no mode. New generation needs the route minimum: Diffusion 20, Parametric Low 20, Mad Max 80, CAD 4 tokens. A start-gate rejection creates nothing; charges settle as stages complete. Returns an asset ID immediately. Poll that ID, never recreate it to check progress.',
    inputSchema: mcpCreateSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, invoke((c, input) => c.create(mcpCreateInput(input))));
  server.registerTool('palatial_get_asset', {
    description: 'Check an existing Palatial asset by its ID. INIT also reads its bound research/build job; generation_job can report a failure or question while the asset remains INIT. Keep native job, asset and Queue status distinct. READY means outputs are available. A normal PROCESSING_PAUSED checkpoint between stages (billing.paused=false, run.awaitingContinue=true) continues automatically in about a minute while the balance is above 0; keep polling the same asset and do not reprocess or create. For a credit pause, report billing_guidance: a posted top-up must make the shared net balance positive, then processing resumes on the same asset. Running stages can finish at a nonpositive balance. For PROCESSING_FAILED, inspect failure_guidance and ask before requesting a partial export; only successfully completed stages are charged. Do not automatically regenerate or export.',
    inputSchema: z.object({ asset_id: assetIdSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, invoke((c, input) => c.getAsset(input.asset_id)));
  server.registerTool('palatial_get_asset_details', { description: 'Retrieve the complete asset record and, when bound, its research/build job as generation_job. Native job status can differ from asset and Queue status; report failures, questions or automation blocks without retrying automatically.', inputSchema: z.object({ asset_id: assetIdSchema }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, invoke((c, input) => c.getAssetDetails(input.asset_id)));
  server.registerTool('palatial_list_assets', { description: 'List workspace assets, optionally filtered by name or status.', inputSchema: z.object({ search: z.string().max(200).optional(), status: z.string().max(80).optional(), limit: z.number().int().min(1).max(100).optional(), skip: z.number().int().min(0).optional() }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, invoke((c, input) => c.listAssets(input), { arrayKey: 'data' }));
  server.registerTool('palatial_batch_get_statuses', { description: 'Retrieve statuses for up to 100 asset IDs.', inputSchema: z.object({ asset_ids: z.array(assetIdSchema).min(1).max(100) }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, invoke((c, input) => c.batchStatus(input.asset_ids), { arrayKey: 'statuses' }));
  server.registerTool('palatial_get_pipeline_progress', { description: 'Retrieve stage-level progress for an asset.', inputSchema: z.object({ asset_id: assetIdSchema }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, invoke((c, input) => c.pipelineProgress(input.asset_id)));
  server.registerTool('palatial_reprocess_asset', { description: 'Reprocess an existing asset from a pipeline stage. Overwrites this asset; use palatial_create_variant for an independent version. Supply feedback with from to describe the repair and sourceRunId to select the retained source. For a researching job (effort mad_max, or a create with a video), omit from to retry its failed model build, delivery or completion the same way as the Dashboard retry, with no fixed price: it needs at least 80 tokens to start, each completed step is charged, and it pauses when tokens run out and resumes after a top-up; the call says so when nothing can be retried. A from always reprocesses that pipeline stage. Uses per-stage completion billing. A normal between-stage checkpoint continues automatically in about a minute while the balance is above 0; keep polling. Credit-paused jobs resume automatically after a sufficient posted top-up; do not reprocess them to resume. Do not retry an uncertain submission.', inputSchema: reprocessSchema.safeExtend({ asset_id: assetIdSchema }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }, invoke((c, input) => { const { asset_id, ...body } = input; return c.reprocess(asset_id, body); }));
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

export async function serveStdio({ docsChecker = checkDocs } = {}) {
  const startupDocs = await docsChecker();
  const server = createServer({ docsChecker, startupDocs });
  await server.connect(new StdioServerTransport());
  return server;
}

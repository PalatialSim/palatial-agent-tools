import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PalatialClient, PalatialApiError, mcpCreateSchema, mcpCreateInput, reprocessSchema, variantBatchSchema, assetIdSchema, DEFAULT_API_URL, mcpAgentTurnSchema, mcpAgentTurnInput } from './client.js';
import { agentSourceUploadSchema } from './agent-sources.js';
import { createSceneSchema, sceneIdSchema, listScenesSchema, answerSceneSchema, recoverSceneSchema, retrySceneStartSchema, downloadSceneSchema } from './scenes.js';
import { autoCreateSchema } from './auto-create.js';
import { getApiKey } from './auth.js';
import { VERSION } from './version.js';
import { checkForUpdate } from './update.js';
import { GUIDE_TOPICS, readGuide } from './guide.js';
import { checkDocs, DOCS_ORIGIN, API_DOCS_URL } from './docs.js';

export function createServer({ clientFactory, updateChecker = checkForUpdate, docsChecker = checkDocs, startupDocs = { status: 'not_checked', changed: null } } = {}) {
  let docsStatus = startupDocs;
  const docsInstructions = `Live reference: ${API_DOCS_URL}. Startup documentation check: ${startupDocs.status}; ${startupDocs.changed_pages?.length || 0} changed pages. Call palatial_check_docs to inspect startup changes and refresh the live site. Read changed pages before using affected options, and report mismatches with the installed schema. On Dev only, use palatial_agent as the primary entry for user intent, existing-project edits, answers, reference selections and explicit confirmations. The server owns planning and saved project state. Poll palatial_get_agent_turn using the returned turn id; do not start another interaction to poll. Keep request_id and identical inputs for replay after uncertainty. Omitted execution keeps interactive approval. Use execution.mode=automatic only when the caller explicitly authorizes unattended execution of this asset task; the server owns all choices, quote checks and confirmations. Never manufacture client confirmation calls. Low-level compatibility tools remain available. Use palatial_create_asset with mode=auto for an explicitly requested low-level create; dryRun previews the choice without submitting or charging. For explicit text/image creates, use palatial_create_asset with mode=diffusion or mode=parametric and effort=low/mad_max; Mad Max and every video build take no build parameters. `;
  const client = clientFactory || (async () => new PalatialClient({ apiKey: await getApiKey(), baseUrl: process.env.PALATIAL_API_URL || DEFAULT_API_URL, mcpAgentTurnSchema, mcpAgentTurnInput }));
  const server = new McpServer({ name: 'palatial', version: VERSION }, {
    instructions: docsInstructions + 'Use Palatial when the user requests simulation-ready 3D assets from text, images, or CAD, or scenes from videos, photos or floor plans. Read palatial_guide topic=scenes before creating a scene; scene charges require explicit confirm_spend authorization and a stable request_id. Read palatial_guide before the first palatial_create_asset call of a session, and read its parameters topic before setting any create field beyond source, name, description, and engine; the create parameters have cross-field rules that reject a request. New-generation admission uses route minimums (Diffusion 20, Parametric Low 40, Mad Max 80, CAD to Sim 4 tokens); a positive balance alone is sufficient only for continuation or reprocessing when the server permits it. Charges settle only as stages complete; the estimated total is not prepaid. Low recommended balance warnings are advisory. At zero or negative balance, an already-running stage may finish and the next stage waits. A normal PROCESSING_PAUSED checkpoint (billing.paused=false, run.awaitingContinue=true) continues automatically in about a minute while the balance is above 0; a credit pause (billing.paused=true, pauseReason=insufficient_credits) needs a posted top-up before the same asset resumes. Show billing_guidance and preserve asset IDs; never retry generation, create a replacement, or start checkout automatically. Export itself is free; the server decides whether a materialized export key is available. A failed asset requires explicit user confirmation and allow_failed_export. An export is not proof of simulator acceptance. This connector contains no proprietary generation prompts.'
  });
  // Keep deprecated tools callable for clients with cached names, while fresh
  // discovery advertises the primary workflow. Wrap only the SDK's public list
  // handler registration; native tools/call validation remains untouched.
  const deprecatedSceneTools = new Set(['palatial_list_scenes', 'palatial_recover_scene', 'palatial_retry_scene_start']);
  const registerRequestHandler = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = (schema, handler) => registerRequestHandler(schema,
    schema === ListToolsRequestSchema ? async (...args) => {
      const result = await handler(...args);
      return { ...result, tools: result.tools.filter(tool => !deprecatedSceneTools.has(tool.name)) };
    } : handler);
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
  server.server.setRequestHandler = registerRequestHandler;
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
  server.registerTool('palatial_agent', {
    description: 'Dev-preview-only Palatial entry, unavailable on Production; use the Dev API origin and key, with no automatic fallback. The main release must wait for the owning rollout. Requires asset:create, plus asset:write for an existing asset: send exactly one message, answer, selection or confirmation, with optional existing asset_id and conversation_id. The server plans against authoritative project state and returns a turn receipt; poll palatial_get_agent_turn using its id. With execution omitted, forward returned question, references and confirmation faithfully. With explicit execution.mode=automatic, the native Agent resolves supported choices and host confirmations itself within max_tokens when supplied; inspect execution.state and code for an unknowable fact, authorization or budget blocker. Automation is scoped to this request and asset task, never future Dashboard turns. Scope is Palatial asset work; unrelated requests are refused. Reference options include authenticated API hrefs. Regeneration proposals expose choices.variant/overwrite.quote: send the user-approved destination and its quoteId; create proposals expose quote. quote_id accepts up to 8192 characters. Answer questions and select references with their exact server IDs and revisions. In interactive mode, send confirmation only after the user explicitly approves that exact paid proposal; an ordinary message is not automatic authorization. Preserve request_id and identical inputs after an uncertain response; do not replay with a new ID. A requested stop is not cancellation: wait for the terminal turn result.stop, after native planning releases its lifecycle lease. AGENT_LEGACY_CONVERSATION and AGENT_UNAVAILABLE are actionable 409 refusals; never fall back silently. No client keyword routing or automatic generation retries. Attachments accompany a nonblank message only; they cannot accompany answers, selections or confirmations. They are explicit metadata or inline bytes; this tool reads no local files.',
    inputSchema: mcpAgentTurnSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  }, invoke((c, input) => c.startAgentTurn(mcpAgentTurnInput(input))));
  server.registerTool('palatial_upload_agent_source', {
    description: 'Dev-preview-only: upload one explicitly named local image, CAD/3D file or MP4/MOV video to an existing unpaid Agent project through native verified multipart storage. No generation or spending. Returns attachment metadata; pass it unchanged in palatial_agent attachments with a message. Uses only this file, refuses symlinks, and never sends the API key to object storage. Create an interactive project first and wait for its turn to settle; then upload and send the automatic intent with that asset_id. Does not retry upload or generation after uncertainty.',
    inputSchema: agentSourceUploadSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, invoke((c, input) => c.uploadAgentSource(input)));
  server.registerTool('palatial_get_agent_turn', {
    description: 'Dev-preview-only: read a Palatial Agent turn receipt by its returned id (requires the Dev origin and key, and asset:read in the current key workspace). This route is unavailable on Production; do not fall back automatically. Reports running, completed, failed or cancelled with reply, question, references, confirmation, execution, media, downloads, result or error when present. Automatic execution.state is active, completed, blocked or superseded; completed means the authorized action was accepted, not that its generation finished. Poll the same id while running. A completed turn is one finished interaction, not proof that generation finished or that every media type exists. A stop request is only requested until the native stop executes and result.stop is returned on the terminal turn; do not claim cancellation early. Reads do not answer questions, approve spending, or start work.',
    inputSchema: z.object({ turn_id: z.string().min(1).max(192).regex(/^[A-Za-z0-9._:-]+$/) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, invoke((c, input) => c.getAgentTurn(input.turn_id)));
  server.registerTool('palatial_create_asset', {
    description: 'Generate a simulation asset from text, photos, video, or CAD. Use mode=auto to let the server choose all generation settings from description/local inputs/source_urls and optional engine/quality goals. Auto supports text, image, cad and files sources; name and description can be omitted with media. Auto dryRun=true returns selection without creating or charging; request_id is stable idempotency identity for submission, generated and saved once when omitted. Auto takes no effort, build parameters, purpose overrides, named views, video or shape guides; use explicit modes for those controls. For text/image use mode=diffusion, or mode=parametric with effort=low (default) or mad_max; mode=mad_max is shorthand. Put build settings in parameters. Diffusion controls structure, mesh density, textures and physics. Parametric Low authors rigid parts and accepts articulation, face_budget (2,000-200,000), collision_quality, run_simulation, optimize_textures and a rigid newton_solver. Mad Max and every video build require empty parameters. Diffusion takes one image_path or 2-4 named views; Parametric Low takes up to 50 photos on image_path/image_paths/views. Video accepts MP4/MOV up to 300 MiB and 60 seconds, alone or with photos on any route. Mad Max takes one engine and up to 8 photos (7 with a scanned GLB reference_mesh_path, also supported for text). Mad Max and video builds accept product_research on/specs_only/off; narrowed research needs photos or video. The MCP builds rigid assets, omits shape_model, texture_model, body_type, auto_scale and replace_glass, and offers collision_quality=auto/low/medium/high/sdf. auto leaves the API collision override unset (currently medium on Diffusion/Low); Mad Max picks proxies itself. Text/image calls require mode. Explicit CAD requires mesh_path, optional image_path and flat settings without mode; automatic CAD uses mode=auto with source metadata. source=files takes photos, 3D files and PDFs together in files; give each 3D file a purpose (exact_geometry, shape_reference for a Mad Max GLB guide, or unused) unless it is a lone 3D file, and ask the user when BUILD_INPUT_PURPOSE_REQUIRED comes back. New generation needs the route minimum: Diffusion 20, Parametric Low 40, Mad Max 80, CAD 4 tokens. A start-gate rejection creates nothing; charges settle as stages complete. Returns an asset ID immediately. Poll that ID, never recreate it to check progress.',
    inputSchema: mcpCreateSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, invoke((c, input) => c.create(mcpCreateInput(input))));
  server.registerTool('palatial_create_auto', {
    description: 'Compatibility shortcut for palatial_create_asset with mode=auto, using the same POST assets/create contract. Let Palatial choose the generation mode and all required settings from text, photos or CAD/3D files. Supply description, file_paths or source_urls and optional engine/quality goals; do not choose mode or build parameters. CAD files may need source_up_axis and meters_per_unit describing their authored frame. Returns selection.mode, effort, settings and reason. dryRun=true selects only and creates nothing or consumes no tokens. Otherwise creates and submits an asset through the ordinary validation, billing and retry path. Supply a stable request_id; if omitted, the client generates one and writes a recovery receipt before sending it as Idempotency-Key. Identical replays reuse the asset and changed inputs conflict. Preserve request_id after uncertainty; never retry with a new ID. Poll the returned asset_id with palatial_get_asset.',
    inputSchema: autoCreateSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, invoke((c, input) => c.createAuto(input)));
  server.registerTool('palatial_create_scene', {
    description: 'Create and start a scene from local videos, photos or floor plans and instructions, without an Agent conversation or confirmation card. Read palatial_guide topic=scenes first. Requires explicit user spending authorization in confirm_spend=true and a stable UUID request_id. Uses one create-and-start request for HTTPS URLs or named local files. Large local files use the returned signed upload flow; completion starts automatically. Set auto_continue=true to continue checkpoints and continuation questions automatically. An identical replay after start returns the existing scene; changed inputs conflict. Preserve request_id and scene_id after uncertainty; never retry with a new UUID. Poll palatial_get_scene for progress, object states, director/object cost and questions. mock_mad_max is Dev-only fixture object modeling; director charges still apply.',
    inputSchema: createSceneSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, invoke((c, input) => c.createScene(input)));
  server.registerTool('palatial_get_scene', {
    description: 'Read scene status, outcome, per-object states, director and object costs, token charges, pending input, available actions and accepted download version. Unknown or incomplete costs are not zero. A needs_input question must be answered with its exact input.expected_head. Reads never resume or regenerate a scene.',
    inputSchema: z.object({ scene_id: sceneIdSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, invoke((c, input) => c.getScene(input.scene_id)));
  server.registerTool('palatial_answer_scene', {
    description: 'Answer a needs_input scene question with instruction and the exact expected_head from its current input. A stale answer conflicts; reread before answering. Continuing may incur the already-authorized scene charges. Do not regenerate the scene to answer.',
    inputSchema: answerSceneSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, invoke((c, input) => c.answerScene(input)));
  server.registerTool('palatial_cancel_scene', {
    description: 'Stop the scene director and its object builds. Idempotent; repeated calls use the same scene. Inspect cancellation for partial failures or unconfirmed object operations and report them; a stop request does not prove every object was canceled. Completed work remains charged.',
    inputSchema: z.object({ scene_id: sceneIdSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  }, invoke((c, input) => c.cancelScene(input.scene_id)));
  server.registerTool('palatial_list_scenes', {
    description: 'Deprecated compatibility tool. New callers track the scene ID returned by create using palatial_get_scene.',
    inputSchema: listScenesSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, invoke((c, input) => c.listScenes(input)));
  server.registerTool('palatial_recover_scene', {
    description: 'Deprecated compatibility tool. Scene recovery belongs to the service. Retains exact checkpoint validation for existing clients.',
    inputSchema: recoverSceneSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, invoke((c, input) => c.recoverScene(input)));
  server.registerTool('palatial_retry_scene_start', {
    description: 'Deprecated compatibility tool. Start recovery belongs to the service. Existing clients still require spending authorization and server proof that no native execution occurred.',
    inputSchema: retrySceneStartSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, invoke((c, input) => c.retrySceneStart(input)));
  server.registerTool('palatial_download_scene', {
    description: 'Download the accepted scene ZIP, optionally selecting an exact download.version to a local output_dir. Preserves existing files and writes a SHA-256 receipt. Bounded by the client download limit, 2 GiB by default. Downloads do not establish simulator acceptance and do not generate a new export.',
    inputSchema: downloadSceneSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, invoke((c, input) => c.downloadScene(input)));
  server.registerTool('palatial_get_asset', {
    description: 'Check an existing Palatial asset by its ID. INIT also reads its bound research/build job; generation_job can report a failure or question while the asset remains INIT. Keep native job, asset and Queue status distinct. READY means generation is complete, not that every representation exists. Inspect details.media for mesh, texture and export state, code, retryable and available href. Texture is a textured GLB, not an image; some routes deliver only an authored USD export. Poll pending MEDIA_NOT_READY; do not poll unavailable MEDIA_NOT_SUPPORTED or MEDIA_GENERATION_FAILED, or missing MEDIA_ARTIFACT_MISSING. Unknown MEDIA_STORAGE_UNAVAILABLE is a retryable storage-check failure; wait and poll. A normal PROCESSING_PAUSED checkpoint between stages (billing.paused=false, run.awaitingContinue=true) continues automatically in about a minute while the balance is above 0; keep polling the same asset and do not reprocess or create. For a credit pause, report billing_guidance: a posted top-up must make the shared net balance positive, then processing resumes on the same asset. Running stages can finish at a nonpositive balance. For PROCESSING_FAILED, inspect failure_guidance and ask before requesting a partial export; only successfully completed stages are charged. Do not automatically regenerate or export.',
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
      description: z.string().min(1).max(2000, 'Description is too long (max 2000 characters)').optional(),
      parameters: z.record(z.string(), z.unknown()).optional()
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, invoke((c, input) => { const { asset_id, ...variant } = input; return c.createVariant(asset_id, variant); }));
  server.registerTool('palatial_create_variant_batch', {
    description: 'Create N independent variants of the same eligible source through one server-owned batch. Submit feedback, optional count/parameters and a stable request_id sent as Idempotency-Key; the server plans distinct requirements, prices and starts the batch in one request. Explicit count wins; omit it to let the server model infer the number from feedback. Ambiguous feedback returns VARIANT_BATCH_COUNT_REQUIRED: ask how many and submit with an explicit count. Never guess or default a missing count in the client. Requires user spending authorization. Optional dryRun=true previews requirements, total/per-item token estimates and an opaque quoteId without creating or charging; supplying that quoteId later submits the frozen plan. A separate quote call is optional. The server limits batch size (default 8), queues excess concurrent work, and bills children independently as stages complete. Partial failures do not cancel siblings. Preserve the request_id and exact payload after uncertainty: identical replay reuses the batch; changed inputs conflict. Track progress with palatial_get_variant_batch, never by creating another batch.',
    inputSchema: variantBatchSchema.safeExtend({ asset_id: assetIdSchema }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, invoke((c, input) => { const { asset_id, ...batch } = input; return c.createVariantBatch(asset_id, batch); }));
  server.registerTool('palatial_get_variant_batch', {
    description: 'Read one Variant batch: each independent child asset ID, queued/running/terminal state, requirement, error and Viewer URL. Report partial failures accurately; do not recreate children or the batch to check progress.',
    inputSchema: z.object({ asset_id: assetIdSchema, batch_id: assetIdSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, invoke((c, input) => c.getVariantBatch(input.asset_id, input.batch_id)));
  server.registerTool('palatial_download_asset', {
    description: 'Download an available SimReady export ZIP to output_dir on this computer. Check details.media.export from palatial_get_asset first: pending MEDIA_NOT_READY requires polling the same asset, unavailable is not made available by retrying, and missing MEDIA_ARTIFACT_MISSING needs support. Export itself does not consume tokens. A first export needs a positive shared net balance; a later paused run is downloadable only when the server has a materialized export key. For PROCESSING_FAILED, first obtain explicit user confirmation, label the result partial or unvalidated, and pass allow_failed_export=true. Saves a SHA-256 receipt, preserves existing files, and reuses a verified READY download. Does not extract archives, import into a scene, or certify simulator behavior.',
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

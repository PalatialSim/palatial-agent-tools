import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PalatialClient, PalatialApiError, DEFAULT_API_URL, mcpAgentTurnSchema, mcpAgentTurnInput, assetIdSchema } from './client.js';
import { createSceneSchema, sceneIdSchema, sceneDigestSchema, sceneObjectIdSchema, downloadSceneSchema } from './scenes.js';
import { z } from 'zod';
import { getApiKey } from './auth.js';
import { VERSION } from './version.js';

export function createServer({ clientFactory } = {}) {
  const client = clientFactory || (async () => new PalatialClient({ apiKey: await getApiKey(), baseUrl: process.env.PALATIAL_API_URL || DEFAULT_API_URL }));
  const server = new McpServer({ name: 'palatial', version: VERSION }, {
    instructions: 'Use palatial_agent for Palatial asset intent: creation, configuration, modification, recovery, status and downloads. The native server Agent reads existing project data and always executes unattended, including supported route, preference, reference and dimension choices. Unrelated tasks are refused. Submit message and optional request_id; omitting request_id creates a new request on every call, while identical explicit IDs and inputs replay the same work. Poll the returned id with turn_id alone using the same tool. Never invent answers, confirmations, execution policies, token ceilings or a client-side planner. Preserve request identity after uncertainty; do not resubmit generation to poll. Native permissions, validation, billing, idempotency, cancellation and credit pauses remain authoritative. A credit pause needs a top-up and continues on the same asset. Product Research makes a best attempt on identity, candidates, dimensions and references and records uncertain decisions with evidence in assumptions; uncertainty alone never requires caller answers. Only essential missing sources that research/defaults cannot replace, unsupported scope and hard owning-service refusals block. Responses preserve statusUrl, actual assetStatus, native billing and assumptions. insufficient_tokens/insufficient_credits pauses automation; admission rechecks each minute and native billing resumes the same asset after sufficient top-up. An admitted action is not finished generation or proof of simulation validation. This package previews this contract on the Dev origin and Dev API key until Backend promotion. Three direct asset lifecycle tools call their public routes without the Agent: palatial_archive_asset, palatial_unarchive_asset and palatial_retry_export. Use them only when the user asks for that exact action, and report a refusal code such as PLAN_ARCHIVE_NOT_INCLUDED as returned. Scene generation (Dev preview) uses five tools: palatial_create_scene, palatial_get_scene, palatial_message_scene, palatial_stop_scene and palatial_download_scene. Read next_message from palatial_get_scene before messaging: a message to a running scene is relayed to its director, a waiting question takes it as the answer, and continuing a settled scene starts new paid work and needs confirm_spend=true, which only the user can authorize.'
  });
  const run = async action => {
    try {
      const result = await action();
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      if (error instanceof PalatialApiError) {
        const result = error.toJSON();
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      }
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Palatial request failed.' }] };
    }
  };
  server.registerTool('palatial_agent', {
    description: 'One native unattended Palatial asset endpoint (Dev preview). Submit message with optional request_id and asset_id/conversation_id/attachments/files. To change an existing asset, pass its asset_id with the message; the Agent decides from the message and project whether to update that asset in place or create a new Variant. Without request_id each call is new work; supply the same explicit ID and identical input for replay. Local images, MP4/MOV videos, CAD and documents accompany intent in one call, with at most 1 GiB of files total. MP4/MOV videos must be at most 300 MiB (314572800 bytes), the current Mad Max processing limit; larger videos are refused before transfer. Dev raw HTTP bodies are limited to 100 MiB including metadata and framing; larger supported files use internal resumable transport. The client streams files and saves their digest manifest; after response loss it checks the same request identity without resending file bytes. The server understands intent and existing project data, makes supported choices and executes through shared owning services without caller question/selection/confirmation calls. Poll with turn_id alone; use the returned receipt and structured blockers rather than starting another request. No execution or max_tokens parameter. Product Research makes best-attempt choices and records uncertainty as assumptions[{decision,evidence}], never caller questions. Genuine blockers include AGENT_OUT_OF_SCOPE, AGENT_SOURCE_MISSING and native permission/source-byte refusals. Insufficient tokens or credits pause the same asset, with periodic native admission rechecks and top-up recovery. Report statusUrl, actual assetStatus, billing, assumptions and generation/media/validation state; a handled request does not prove generation finished. Raw URL attachments are rejected. A full transfer is repeated at most once, only when the server confirms missing bytes; generation is never retried with a new identity.',
    inputSchema: mcpAgentTurnSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, input => run(async () => {
    const parsed = mcpAgentTurnInput(input);
    const c = await client();
    return parsed.turnId !== undefined ? c.getAgentTurn(parsed.turnId) : parsed.files?.length ? c.startAgentWithFiles(parsed) : c.startAgentTurn(parsed);
  }));
  const assetInput = { asset_id: assetIdSchema.describe('ID of an asset in the API key workspace.') };
  server.registerTool('palatial_archive_asset', {
    description: 'Archive one asset (DELETE assets/{id}/archive). Completes in the request and returns { success, status: "ARCHIVED" }. Needs asset:write and a workspace plan that includes archiving; otherwise 403 PLAN_ARCHIVE_NOT_INCLUDED, or WORKSPACE_SUSPENDED for a suspended workspace. 400 when the asset is already archived; 409 VARIANT_ARCHIVE_REQUIRED for a Variant family member, ASSET_SHARED_LIFECYCLE_CONFLICT while the asset is shared to other workspaces or an Organization Library, or HEAVY_JOB_IN_FLIGHT when another operation owns the asset. Archiving keeps tokens already charged.',
    inputSchema: assetInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, ({ asset_id }) => run(async () => (await client()).archiveAsset(asset_id)));
  server.registerTool('palatial_unarchive_asset', {
    description: 'Restore one archived asset (POST assets/{id}/unarchive). Completes in the request and returns { success, status: "READY" }. Needs asset:write and a workspace plan that includes archiving; otherwise 403 PLAN_ARCHIVE_NOT_INCLUDED, or WORKSPACE_SUSPENDED. 400 when the asset is not archived; 409 VARIANT_RESTORE_REQUIRED for a Variant family member or HEAVY_JOB_IN_FLIGHT; 400 Max asset limit reached when restoring would exceed the organization asset limit.',
    inputSchema: assetInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, ({ asset_id }) => run(async () => (await client()).unarchiveAsset(asset_id)));
  server.registerTool('palatial_retry_export', {
    description: 'Retry a failed export (POST assets/{id}/retry-export). Only for an asset whose export.status is PROCESSING_FAILED; returns { success, export: { status: "READY" } }, after which the export ZIP downloads from media/export. Needs asset:export. 400 when the asset is not READY, has no completed export source, or its export has not failed; 403 insufficient_tokens when a first export needs a positive balance. It never regenerates the asset and does not charge tokens.',
    inputSchema: assetInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, ({ asset_id }) => run(async () => (await client()).retryExport(asset_id)));
  const sceneInput = { scene_id: sceneIdSchema.describe('Scene ID returned by palatial_create_scene (the scene asset ID).') };
  server.registerTool('palatial_create_scene', {
    description: 'Create and start a scene from local photos, videos or floor plans (source_paths) or public HTTPS URLs (sources), plus instructions in description (POST workspaces/{workspace}/scene-generations/start). Starting a scene is paid work: obtain the user\'s authorization for director and object charges, then pass confirm_spend=true. Use a stable UUID request_id: an identical replay returns the same scene and changed inputs conflict; never retry with a new UUID after an uncertain outcome. Set auto_continue=true to let checkpoints continue with the original instructions. Poll palatial_get_scene with the returned scene_id.',
    inputSchema: createSceneSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, input => run(async () => (await client()).createScene(input)));
  server.registerTool('palatial_get_scene', {
    description: 'Read a scene (GET scene-generations/{id}): status, progress, objects, costs, the pending question and the accepted download version. next_message says what palatial_message_scene would do now: action relay | answer | resume | continue | retry_start | none, requires_text, requires_confirm_spend, expected_head, regenerable_objects, reason and price_basis. Unknown or unsettled costs are not zero. Reading never changes or charges a scene.',
    inputSchema: z.object(sceneInput).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, ({ scene_id }) => run(async () => (await client()).getScene(scene_id)));
  server.registerTool('palatial_message_scene', {
    description: 'Send one message to a scene (POST scene-generations/{id}/messages). The server decides the effect from the scene state, shown beforehand as next_message.action in palatial_get_scene, in this order. retry_start: a refused start is retried with its original request; text is not applied; new paid work, requires confirm_spend=true; result start_retried. answer: the scene waits on its question; text is the answer, within the original authorization; result answered. resume: the scene is parked at a checkpoint that takes no answer; it continues and text is passed to its director; result resumed. relay: the scene is running; text is relayed to its director, and the message itself is free; result relayed, or queued until the director can take it. continue: the scene ended (delivered, best checkpoint, stopped, held in review) and can be continued; the whole scene continues as new paid work (built objects are reused, new work is billed at actual cost) and requires confirm_spend=true; text is required when next_message.requires_text is true; regenerate_objects applies only here and so always needs confirm_spend. Ask the user before setting confirm_spend. none: 409 scene_not_messageable with a reason, or 403 insufficient_tokens (nothing is kept or resumed; top up and send again). Without confirm_spend a paid message returns 409 confirm_spend_required with next_message and does nothing; a stale expected_head returns 409 scene_head_moved with the current expected_head; omit expected_head when next_message.expected_head is null. A change request on a delivered scene continues the whole scene. A message never stops a scene; use palatial_stop_scene. The receipt has message.action, instruction_applied, guidance_status, price_basis and at. Keep request_id: the same id and body replay the receipt, a refusal records nothing so a corrected call may reuse it, and after 503 scene_message_unconfirmed send the same id and body again; a new request_id, including an omitted one, is a new message.',
    inputSchema: z.object({
      ...sceneInput,
      text: z.string().trim().min(1).max(4000).describe('Message text, up to 4000 characters. Required when next_message.requires_text is true.').optional(),
      request_id: z.string().uuid().describe('Stable UUID for this message; generated when omitted and returned on the receipt or error. Reuse it with the same body to replay.').optional(),
      confirm_spend: z.literal(true).describe('The user\'s explicit authorization for new paid work. Required when next_message.requires_confirm_spend is true.').optional(),
      expected_head: sceneDigestSchema.describe('Optional next_message.expected_head; refused with scene_head_moved if the scene has moved on. Omit when next_message.expected_head is null.').optional(),
      regenerate_objects: z.array(sceneObjectIdSchema).min(1).max(1000).describe('Failed or dropped object IDs from next_message.regenerable_objects to rebuild; only when next_message.action is continue, together with confirm_spend=true.').optional()
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, ({ scene_id, text, request_id, confirm_spend, expected_head, regenerate_objects }) => run(async () => (await client()).messageScene(scene_id, {
    text, requestId: request_id, confirmSpend: confirm_spend, expectedHead: expected_head, regenerateObjects: regenerate_objects
  })));
  server.registerTool('palatial_stop_scene', {
    description: 'Stop a scene\'s director and its object builds (POST scene-generations/{id}/stop). Idempotent and free; completed work stays charged. Inspect cancellation in the result for partial failures; a stop request does not prove every object stopped. Continuing a stopped scene later is new paid work through palatial_message_scene with confirm_spend=true.',
    inputSchema: z.object(sceneInput).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  }, ({ scene_id }) => run(async () => (await client()).cancelScene(scene_id)));
  server.registerTool('palatial_download_scene', {
    description: 'Download the accepted scene ZIP to output_dir (GET scene-generations/{id}/download), optionally pinned to an exact download.version. Free. Verifies ETag, Content-Length and SHA-256, preserves existing files and writes a receipt. A download does not prove simulator acceptance.',
    inputSchema: downloadSceneSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, input => run(async () => (await client()).downloadScene(input)));
  return server;
}
export async function serveStdio() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  return server;
}

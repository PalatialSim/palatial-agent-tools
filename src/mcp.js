import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PalatialClient, PalatialApiError, DEFAULT_API_URL, mcpAgentTurnSchema, mcpAgentTurnInput, assetIdSchema } from './client.js';
import { getApiKey } from './auth.js';
import { VERSION } from './version.js';

export function createServer({ clientFactory } = {}) {
  const client = clientFactory || (async () => new PalatialClient({ apiKey: await getApiKey(), baseUrl: process.env.PALATIAL_API_URL || DEFAULT_API_URL }));
  const server = new McpServer({ name: 'palatial', version: VERSION }, {
    instructions: 'Use palatial_agent for Palatial asset intent: creation, configuration, modification, recovery, status and downloads. The native server Agent reads existing project data and always executes unattended, including supported route, preference, reference and dimension choices. Unrelated tasks are refused. Submit message and optional request_id; omitting request_id creates a new request on every call, while identical explicit IDs and inputs replay the same work. Poll the returned id with turn_id alone using the same tool. Never invent answers, confirmations, execution policies, token ceilings or a client-side planner. Preserve request identity after uncertainty; do not resubmit generation to poll. Native permissions, validation, billing, idempotency, cancellation and credit pauses remain authoritative. A credit pause needs a top-up and continues on the same asset. Product Research makes a best attempt on identity, candidates, dimensions and references and records uncertain decisions with evidence in assumptions; uncertainty alone never requires caller answers. Only essential missing sources that research/defaults cannot replace, unsupported scope and hard owning-service refusals block. Responses preserve statusUrl, actual assetStatus, native billing and assumptions. insufficient_tokens/insufficient_credits pauses automation; admission rechecks each minute and native billing resumes the same asset after sufficient top-up. An admitted action is not finished generation or proof of simulation validation. This package previews this contract on the Dev origin and Dev API key until Backend promotion. Three direct asset lifecycle tools call their public routes without the Agent: palatial_archive_asset, palatial_unarchive_asset and palatial_retry_export. Use them only when the user asks for that exact action, and report a refusal code such as PLAN_ARCHIVE_NOT_INCLUDED as returned.'
  });
  const run = async action => {
    try {
      const result = await action(await client());
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
  }, input => run(c => {
    const parsed = mcpAgentTurnInput(input);
    return parsed.turnId !== undefined ? c.getAgentTurn(parsed.turnId) : parsed.files?.length ? c.startAgentWithFiles(parsed) : c.startAgentTurn(parsed);
  }));
  const assetInput = { asset_id: assetIdSchema.describe('ID of an asset in the API key workspace.') };
  server.registerTool('palatial_archive_asset', {
    description: 'Archive one asset (DELETE assets/{id}/archive). Completes in the request and returns { success, status: "ARCHIVED" }. Needs asset:write and a workspace plan that includes archiving; otherwise 403 PLAN_ARCHIVE_NOT_INCLUDED, or WORKSPACE_SUSPENDED for a suspended workspace. 400 when the asset is already archived; 409 VARIANT_ARCHIVE_REQUIRED for a Variant family member, ASSET_SHARED_LIFECYCLE_CONFLICT while the asset is shared to other workspaces or an Organization Library, or HEAVY_JOB_IN_FLIGHT when another operation owns the asset. Archiving keeps tokens already charged.',
    inputSchema: assetInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, ({ asset_id }) => run(c => c.archiveAsset(asset_id)));
  server.registerTool('palatial_unarchive_asset', {
    description: 'Restore one archived asset (POST assets/{id}/unarchive). Completes in the request and returns { success, status: "READY" }. Needs asset:write and a workspace plan that includes archiving; otherwise 403 PLAN_ARCHIVE_NOT_INCLUDED, or WORKSPACE_SUSPENDED. 400 when the asset is not archived; 409 VARIANT_RESTORE_REQUIRED for a Variant family member or HEAVY_JOB_IN_FLIGHT; 400 Max asset limit reached when restoring would exceed the organization asset limit.',
    inputSchema: assetInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, ({ asset_id }) => run(c => c.unarchiveAsset(asset_id)));
  server.registerTool('palatial_retry_export', {
    description: 'Retry a failed export (POST assets/{id}/retry-export). Only for an asset whose export.status is PROCESSING_FAILED; returns { success, export: { status: "READY" } }, after which the export ZIP downloads from media/export. Needs asset:export. 400 when the asset is not READY, has no completed export source, or its export has not failed; 403 insufficient_tokens when a first export needs a positive balance. It never regenerates the asset and does not charge tokens.',
    inputSchema: assetInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, ({ asset_id }) => run(c => c.retryExport(asset_id)));
  return server;
}
export async function serveStdio() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  return server;
}

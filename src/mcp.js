import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PalatialClient, PalatialApiError, DEFAULT_API_URL, mcpAgentTurnSchema, mcpAgentTurnInput } from './client.js';
import { getApiKey } from './auth.js';
import { VERSION } from './version.js';

export function createServer({ clientFactory } = {}) {
  const client = clientFactory || (async () => new PalatialClient({ apiKey: await getApiKey(), baseUrl: process.env.PALATIAL_API_URL || DEFAULT_API_URL }));
  const server = new McpServer({ name: 'palatial', version: VERSION }, {
    instructions: 'Use palatial_agent for Palatial asset intent: creation, configuration, modification, recovery, status and downloads. The native server Agent reads existing project data and always executes unattended, including supported route, preference, reference and dimension choices. Unrelated tasks are refused. Submit message and optional request_id; omitting request_id creates a new request on every call, while identical explicit IDs and inputs replay the same work. Poll the returned id with turn_id alone using the same tool. Never invent answers, confirmations, execution policies, token ceilings or a client-side planner. Preserve request identity after uncertainty; do not resubmit generation to poll. Native permissions, validation, billing, idempotency, cancellation and credit pauses remain authoritative. A credit pause needs a top-up and continues on the same asset. Product Research makes a best attempt on identity, candidates, dimensions and references and records uncertain decisions with evidence in assumptions; uncertainty alone never requires caller answers. Only essential missing sources that research/defaults cannot replace, unsupported scope and hard owning-service refusals block. Responses preserve statusUrl, actual assetStatus, native billing and assumptions. insufficient_tokens/insufficient_credits pauses automation; admission rechecks each minute and native billing resumes the same asset after sufficient top-up. An admitted action is not finished generation or proof of simulation validation. This package previews this contract on the Dev origin and Dev API key until Backend promotion.'
  });
  server.registerTool('palatial_agent', {
    description: 'One native unattended Palatial asset endpoint (Dev preview). Submit message with optional request_id and asset_id/conversation_id/attachments/files. To change an existing asset, pass its asset_id with the message; the Agent decides from the message and project whether to update that asset in place or create a new Variant. Without request_id each call is new work; supply the same explicit ID and identical input for replay. Local images, MP4/MOV videos, CAD and documents accompany intent in one call, with at most 1 GiB of files total. MP4/MOV videos must be at most 300 MiB (314572800 bytes), the current Mad Max processing limit; larger videos are refused before transfer. Dev raw HTTP bodies are limited to 100 MiB including metadata and framing; larger supported files use internal resumable transport. The client streams files and saves their digest manifest; after response loss it checks the same request identity without resending file bytes. The server understands intent and existing project data, makes supported choices and executes through shared owning services without caller question/selection/confirmation calls. Poll with turn_id alone; use the returned receipt and structured blockers rather than starting another request. No execution or max_tokens parameter. Product Research makes best-attempt choices and records uncertainty as assumptions[{decision,evidence}], never caller questions. Genuine blockers include AGENT_OUT_OF_SCOPE, AGENT_SOURCE_MISSING and native permission/source-byte refusals. Insufficient tokens or credits pause the same asset, with periodic native admission rechecks and top-up recovery. Report statusUrl, actual assetStatus, billing, assumptions and generation/media/validation state; a handled request does not prove generation finished. Raw URL attachments are rejected. A full transfer is repeated at most once, only when the server confirms missing bytes; generation is never retried with a new identity.',
    inputSchema: mcpAgentTurnSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async input => {
    try {
      const parsed = mcpAgentTurnInput(input);
      const c = await client();
      const result = parsed.turnId !== undefined ? await c.getAgentTurn(parsed.turnId) : parsed.files?.length ? await c.startAgentWithFiles(parsed) : await c.startAgentTurn(parsed);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      if (error instanceof PalatialApiError) {
        const result = error.toJSON();
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      }
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Palatial request failed.' }] };
    }
  });
  return server;
}
export async function serveStdio() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  return server;
}

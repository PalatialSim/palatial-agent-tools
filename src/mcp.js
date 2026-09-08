import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PalatialClient, createSchema, assetIdSchema, DEFAULT_API_URL } from './client.js';
import { getApiKey } from './auth.js';

export function createServer({ clientFactory } = {}) {
  const client = clientFactory || (async () => new PalatialClient({ apiKey: await getApiKey(), baseUrl: process.env.PALATIAL_API_URL || DEFAULT_API_URL }));
  const server = new McpServer({ name: 'palatial', version: '0.1.0' }, {
    instructions: 'Use Palatial when the user requests simulation-ready 3D assets from text, images, or CAD. Determine the simulator and inputs. Creation and export use workspace credits. Preserve asset IDs and poll existing jobs instead of creating replacements. Download only when READY. An available export is not proof of simulator acceptance. This connector contains no proprietary generation prompts.'
  });
  const invoke = fn => async input => {
    try {
      const result = await fn(await client(), input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Palatial tool failed.' }] };
    }
  };
  server.registerTool('palatial_doctor', {
    description: 'Check Palatial authentication and API connectivity. Does not generate assets or consume export credits.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, invoke(c => c.doctor()));
  server.registerTool('palatial_create_asset', {
    description: 'Generate a simulation asset from text, a local image, multiple named images of one object, or local CAD plus a reference image. Uses Palatial workspace credits. Returns immediately with an asset ID. Supply only user-selected file paths. Resume through get_asset; never repeat create just to check progress.',
    inputSchema: createSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, invoke((c, input) => c.create(input)));
  server.registerTool('palatial_get_asset', {
    description: 'Check an existing Palatial asset by its ID. READY means its outputs are available. Failure, cancellation, or pause require explicit handling; do not automatically regenerate.',
    inputSchema: z.object({ asset_id: assetIdSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, invoke((c, input) => c.getAsset(input.asset_id)));
  server.registerTool('palatial_download_asset', {
    description: 'Download a READY SimReady export ZIP to output_dir on this computer. The export endpoint uses workspace export credits. Saves a SHA-256 receipt, preserves existing files, and reuses a verified local download. Does not extract archives, import into a scene, or certify simulator behavior.',
    inputSchema: z.object({ asset_id: assetIdSchema, output_dir: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, invoke((c, input) => c.download(input.asset_id, input.output_dir)));
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

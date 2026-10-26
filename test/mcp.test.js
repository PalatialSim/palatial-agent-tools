import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../src/mcp.js';
import { PalatialClient, PalatialApiError } from '../src/client.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function connect(t, clientFactory) {
  const server = createServer({ clientFactory });
  const client = new Client({ name: 'unified-intent-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('MCP advertises and registers exactly one native intent tool', async t => {
  const client = await connect(t, async () => ({}));
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name), ['palatial_agent']);
  assert.ok(tools[0].inputSchema.properties.request_id);
  assert.equal(tools[0].inputSchema.required?.includes('request_id') ?? false, false);
  assert.equal(tools[0].annotations.idempotentHint, false);
  assert.ok(tools[0].inputSchema.properties.turn_id);
  for (const field of ['execution', 'max_tokens', 'answer', 'selection', 'confirmation']) assert.equal(tools[0].inputSchema.properties[field], undefined);
  assert.equal((await client.callTool({ name: 'palatial_create_asset', arguments: {} })).isError, true);
  assert.equal((await client.callTool({ name: 'palatial_doctor', arguments: {} })).isError, true);
  assert.match(client.getInstructions(), /always executes unattended/);
});

test('single MCP tool submits native intent then polls the same id without planning or mutation', async t => {
  const calls = [];
  const native = new PalatialClient({ apiKey: 'fixture-key', baseUrl: 'https://dashboard.dev.palatial.cloud/api/v1/external/', fetchImpl: async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    return Response.json(init.method === 'POST' ? { id: 'request-receipt', status: 'running' } : { id: 'request-receipt', result: { accepted: true }, media: { texture: { state: 'pending' } } }, { status: init.method === 'POST' ? 202 : 200 });
  } });
  const client = await connect(t, async () => native);
  const input = { request_id: 'request-1', asset_id: 'asset-1', conversation_id: 'conversation-1', message: 'Build the cabinet in the source.', attachments: [{ id: 'cabinet.mp4', name: 'cabinet.mp4', kind: 'video', mime_type: 'video/mp4', bytes_in_asset: true }] };
  const receipt = await client.callTool({ name: 'palatial_agent', arguments: input });
  assert.equal(receipt.isError, undefined);
  const poll = await client.callTool({ name: 'palatial_agent', arguments: { turn_id: receipt.structuredContent.id } });
  assert.equal(poll.structuredContent.result.accepted, true);
  assert.equal(calls[0].url, 'https://dashboard.dev.palatial.cloud/api/v1/external/agent');
  assert.deepEqual(calls[0].body, { requestId: 'request-1', assetId: 'asset-1', conversationId: 'conversation-1', message: input.message, attachments: [{ id: 'cabinet.mp4', name: 'cabinet.mp4', kind: 'video', mimeType: 'video/mp4', bytesInAsset: true }] });
  assert.deepEqual(calls[1], { url: 'https://dashboard.dev.palatial.cloud/api/v1/external/agent/request-receipt', method: 'GET', body: undefined });
});

test('MCP rejects mixed polling, manual checkpoints and caller execution policies before transport', async t => {
  let calls = 0;
  const client = await connect(t, async () => ({ startAgentTurn: async () => { calls++; }, getAgentTurn: async () => { calls++; } }));
  for (const input of [{}, { request_id: 'r' }, { turn_id: 't', message: 'Build' }, { turn_id: 't', request_id: 'r' }, { request_id: 'r', message: 'Build', execution: { mode: 'automatic' } }, { request_id: 'r', message: 'Build', max_tokens: 40 }, { request_id: 'r', answer: {} }, { request_id: 'r', selection: {} }, { request_id: 'r', confirmation: {} }, { request_id: 'r', message: 'Build', attachments: [{ file_path: '/private/file' }] }]) {
    assert.equal((await client.callTool({ name: 'palatial_agent', arguments: input })).isError, true);
  }
  assert.equal(calls, 0);
});

test('MCP preserves structured owning-service blockers without retrying or fallback', async t => {
  let calls = 0;
  const client = await connect(t, async () => ({ startAgentTurn: async () => {
    calls++; throw new PalatialApiError('Required source unavailable', { http_status: 409, code: 'AGENT_INPUT_REQUIRED', retryable: false });
  } }));
  const result = await client.callTool({ name: 'palatial_agent', arguments: { request_id: 'r', message: 'Build it.' } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, 'AGENT_INPUT_REQUIRED');
  assert.equal(calls, 1);
});

test('packaged stdio discovery exposes only the unified tool without login or startup network', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'palatial-one-tool-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const client = new Client({ name: 'stdio-contract', version: '1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bin/palatial-agent.js', import.meta.url)), 'mcp'], env: { PATH: process.env.PATH, XDG_CONFIG_HOME: dir, PALATIAL_API_KEY: '' }, stderr: 'pipe' }));
  t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['palatial_agent']);
  const result = await client.callTool({ name: 'palatial_agent', arguments: { turn_id: 'receipt-1' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not authenticated/);
});

test('sole MCP tool sends a small local photo in one intent POST and replays the same request', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'palatial-inline-photo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'bin.png');
  const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await writeFile(filename, photo);
  const calls = [];
  const native = new PalatialClient({ apiKey: 'fixture-key', baseUrl: 'https://dashboard.dev.palatial.cloud/api/v1/external/', receiptDir: path.join(directory, 'receipts'), fetchImpl: async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
    assert.equal(new URL(url).pathname, '/api/v1/external/agent');
    return Response.json({ id: 'photo-1', replayed: calls.length > 1 }, { status: 202 });
  } });
  const client = await connect(t, async () => native);
  const args = { request_id: 'small-photo', message: 'Create the bin in this photo.', files: [filename] };
  const result = await client.callTool({ name: 'palatial_agent', arguments: args });
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.assetId, undefined);
  assert.deepEqual(calls[0].body.attachments, [{ name: 'bin.png', kind: 'image', inlineData: { mimeType: 'image/png', data: photo.toString('base64') } }]);
  const replay = await client.callTool({ name: 'palatial_agent', arguments: args });
  assert.equal(replay.structuredContent.replayed, true);
  assert.deepEqual(calls[1].body, calls[0].body);
});

test('sole MCP tool reserves and uploads local files before native intent, then replays exact stored metadata after response loss', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'palatial-intent-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'cabinet.mp4');
  await writeFile(filename, Buffer.from('0000ftyp0000video-evidence'));
  const calls = [];
  const assetId = '333333333333333333333333';
  const attachment = { id: 'cabinet.mp4', name: 'cabinet.mp4', kind: 'video', mimeType: 'video/mp4', bytesInAsset: true };
  let loseResponse = true;
  const native = new PalatialClient({ apiKey: 'fixture-key', baseUrl: 'https://dashboard.dev.palatial.cloud/api/v1/external/', receiptDir: path.join(directory, 'receipts'), fetchImpl: async (url, init) => {
    const route = new URL(url).pathname;
    calls.push({ route, method: init.method, headers: init.headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    if (route.endsWith('/agent/sources')) return Response.json({ assetId });
    if (route.endsWith('/sources/init')) return Response.json({ key: `uploads/projects/${assetId}/uploads/cabinet.mp4`, uploadId: 'upload-1', completionToken: 'token-1' });
    if (route.endsWith('/sources/sign-parts')) return Response.json({ signedUrls: [`https://${'a'.repeat(32)}.r2.cloudflarestorage.com/bucket/file?private=signature`] });
    if (route === '/bucket/file') return new Response('', { headers: { etag: 'part-etag' } });
    if (route.endsWith('/sources/complete')) return Response.json({ attachment });
    if (route.endsWith('/external/agent')) {
      if (loseResponse) { loseResponse = false; throw new Error('response lost after native admission'); }
      return Response.json({ id: 'receipt-1', assetId, replayed: true }, { status: 202 });
    }
    throw new Error('Unexpected route');
  } });
  const client = await connect(t, async () => native);
  const args = { request_id: 'video-1', message: 'Build the cabinet shown in my video.', files: [filename] };
  const first = await client.callTool({ name: 'palatial_agent', arguments: args });
  assert.equal(first.isError, true);
  const replay = await client.callTool({ name: 'palatial_agent', arguments: args });
  assert.equal(replay.isError, undefined);
  assert.equal(replay.structuredContent.replayed, true);
  assert.equal(calls.filter(call => call.route.endsWith('/agent/sources')).length, 1);
  assert.equal(calls.filter(call => call.route.endsWith('/sources/init')).length, 1);
  const posts = calls.filter(call => call.route.endsWith('/external/agent'));
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].body, posts[1].body);
  assert.deepEqual(posts[0].body, { requestId: 'video-1', message: args.message, assetId, attachments: [attachment] });
  assert.equal(calls.find(call => call.route === '/bucket/file').headers, undefined);
  await writeFile(filename, Buffer.from('changed-source'));
  const changed = await client.callTool({ name: 'palatial_agent', arguments: args });
  assert.equal(changed.isError, true);
  assert.match(changed.content[0].text, /different intent or source bytes/);
  assert.equal(calls.filter(call => call.route.endsWith('/external/agent')).length, 2);
});

test('message-only MCP calls omit request identity and remain new requests, while explicit IDs stay unchanged', async t => {
  const posts = [];
  const native = new PalatialClient({ apiKey: 'fixture-key', baseUrl: 'https://dashboard.dev.palatial.cloud/api/v1/external/', fetchImpl: async (_url, init) => {
    posts.push(JSON.parse(init.body));
    return Response.json({ id: `receipt-${posts.length}`, status: 'running' }, { status: 202 });
  } });
  const client = await connect(t, async () => native);
  const args = Object.freeze({ message: 'Inspect this project.' });
  const first = await client.callTool({ name: 'palatial_agent', arguments: args });
  const second = await client.callTool({ name: 'palatial_agent', arguments: args });
  assert.equal(first.isError, undefined);
  assert.equal(second.isError, undefined);
  assert.notEqual(first.structuredContent.id, second.structuredContent.id);
  assert.deepEqual(posts, [{ message: args.message }, { message: args.message }]);
  assert.equal(Object.hasOwn(args, 'request_id'), false);
  const explicit = { ...args, request_id: 'preserve-this-id' };
  await client.callTool({ name: 'palatial_agent', arguments: explicit });
  await client.callTool({ name: 'palatial_agent', arguments: explicit });
  assert.deepEqual(posts.slice(2), [0, 1].map(() => ({ requestId: explicit.request_id, message: args.message })));
  for (const request_id of ['', null, '../escape', 'x'.repeat(129)]) assert.equal((await client.callTool({ name: 'palatial_agent', arguments: { message: args.message, request_id } })).isError, true);
  assert.equal(posts.length, 4);
});

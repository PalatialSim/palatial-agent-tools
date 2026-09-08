import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../src/mcp.js';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('real MCP protocol lists tools and calls the shared client without a model', async t => {
  const server = createServer({ clientFactory: async () => ({ doctor: async () => ({ authenticated: true }), getAsset: async id => ({ asset_id: id, status: 'READY' }) }) });
  const client = new Client({ name: 'contract-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const list = await client.listTools();
  assert.equal(list.tools.length, 5);
  assert.equal(list.tools.find(x => x.name === 'palatial_download_asset').annotations.readOnlyHint, false);
  const result = await client.callTool({ name: 'palatial_get_asset', arguments: { asset_id: 'asset-test' } });
  assert.equal(result.structuredContent.asset_id, 'asset-test');
  const invalid = await client.callTool({ name: 'palatial_get_asset', arguments: { asset_id: '../bad' } });
  assert.equal(invalid.isError, true);
});

test('packaged CLI speaks stdio MCP and lists tools without authentication', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'palatial-stdio-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../bin/palatial-agent.js', import.meta.url)), 'mcp'],
    env: { PATH: process.env.PATH, XDG_CONFIG_HOME: dir, PALATIAL_API_KEY: '' },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'stdio-test', version: '1.0' });
  await client.connect(transport);
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, 5);
  const result = await client.callTool({ name: 'palatial_doctor', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not authenticated/);
});

test('setup produces shell-free commands for both actual terminal clients', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/palatial-agent.js', import.meta.url)), 'setup', '--client', 'both', '--dry-run'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const commands = JSON.parse(result.stdout);
  assert.equal(commands[0].command, 'codex');
  assert.deepEqual(commands[0].args.slice(0, 4), ['mcp', 'add', 'palatial', '--']);
  assert.equal(commands[1].command, 'claude');
  assert.ok(commands[1].args.includes('stdio'));
  assert.equal(commands[1].args.at(-1), 'mcp');
  assert.ok(!result.stdout.includes('PALATIAL_API_KEY'));
});

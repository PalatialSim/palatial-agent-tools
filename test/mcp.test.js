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
import { runSetup } from '../src/setup.js';

test('real MCP protocol lists tools and calls the shared client without a model', async t => {
  const server = createServer({ clientFactory: async () => ({ doctor: async () => ({ authenticated: true }), getAsset: async id => ({ asset_id: id, status: 'READY' }) }) });
  const client = new Client({ name: 'contract-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const list = await client.listTools();
  assert.equal(list.tools.length, 12);
  assert.equal(list.tools.find(x => x.name === 'palatial_download_asset').annotations.readOnlyHint, false);
  const result = await client.callTool({ name: 'palatial_get_asset', arguments: { asset_id: 'asset-test' } });
  assert.equal(result.structuredContent.asset_id, 'asset-test');
  const invalid = await client.callTool({ name: 'palatial_get_asset', arguments: { asset_id: '../bad' } });
  assert.equal(invalid.isError, true);
});

test('create tool explains API options in its MCP schema', async t => {
  const server = createServer({ clientFactory: async () => ({}) });
  const client = new Client({ name: 'schema-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const tool = (await client.listTools()).tools.find(item => item.name === 'palatial_create_asset');
  assert.match(tool.inputSchema.properties.engine.description, /isaac_sim/);
  assert.match(tool.inputSchema.properties.create_articulation.description, /joints/);
  assert.match(tool.inputSchema.properties.units.description, /direct-mesh CAD/);
  assert.match(tool.inputSchema.properties.shape_model.description, /parametric/);
  assert.match(tool.inputSchema.properties.shape_model.description, /auto lets Palatial select/);
  assert.doesNotMatch(tool.inputSchema.properties.shape_model.description, /Tencent|provider|vendor/i);
  assert.match(tool.inputSchema.properties.shape_model.description, /faster, cheaper/);
  assert.match(tool.inputSchema.properties.shape_model.description, /better for articulation/);
  assert.deepEqual(tool.inputSchema.properties.shape_model.enum, ['auto', 'diffusion', 'parametric']);
  assert.deepEqual(tool.inputSchema.properties.effort.enum, ['low', 'medium', 'mad_max']);
  assert.match(tool.inputSchema.properties.image_path.description, /optional PNG\/JPEG\/WebP reference/);
  assert.match(tool.inputSchema.properties.reconstruct.description, /multiview reconstruction/);
  assert.match(tool.inputSchema.properties.meters_per_unit.description, /Direct-mesh CAD/);
  assert.equal(tool.inputSchema.properties.agentic_articulation, undefined);
  assert.match(tool.inputSchema.properties.decimation_target_ratio.description, /mutually exclusive/);
});

test('guidance reaches any client as a tool, and as resources where they are supported', async t => {
  const server = createServer({ clientFactory: async () => ({}) });
  const client = new Client({ name: 'guide-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });

  const tool = (await client.listTools()).tools.find(item => item.name === 'palatial_guide');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.match(tool.description, /parameters/);
  assert.deepEqual(tool.inputSchema.properties.topic.enum, ['overview', 'parameters', 'recipes', 'troubleshooting']);

  // Guidance must arrive without arguments: a model that ignores the topic
  // still has to land on the workflow rather than on an error.
  const overview = await client.callTool({ name: 'palatial_guide', arguments: {} });
  assert.notEqual(overview.isError, true);
  assert.equal(overview.structuredContent.topic, 'overview');
  assert.equal(overview.structuredContent.text, undefined, 'The guide prose must not be duplicated in structuredContent.');
  assert.match(overview.content[0].text, /palatial_create_asset/);

  const parameters = await client.callTool({ name: 'palatial_guide', arguments: { topic: 'parameters' } });
  assert.match(parameters.content[0].text, /decimation_target_faces/);
  assert.match(parameters.content[0].text, /exactly one of/);

  const unknown = await client.callTool({ name: 'palatial_guide', arguments: { topic: 'nonsense' } });
  assert.equal(unknown.isError, true);

  const resources = (await client.listResources()).resources;
  assert.deepEqual(resources.map(item => item.uri).sort(), ['palatial://guide/overview', 'palatial://guide/parameters', 'palatial://guide/recipes', 'palatial://guide/troubleshooting']);
  const read = await client.readResource({ uri: 'palatial://guide/troubleshooting' });
  assert.equal(read.contents[0].mimeType, 'text/markdown');
  assert.match(read.contents[0].text, /PROCESSING_FAILED/);
});

test('the server tells a client to read the guidance before its first create', async t => {
  const server = createServer({ clientFactory: async () => ({}) });
  const client = new Client({ name: 'instructions-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  assert.match(client.getInstructions(), /palatial_guide/);
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
  assert.equal((await client.listTools()).tools.length, 12);
  const result = await client.callTool({ name: 'palatial_doctor', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not authenticated/);
});

test('a Codex-only setup writes no Claude Code skill', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/palatial-agent.js', import.meta.url)), 'setup', '--client', 'codex', '--dry-run'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.commands.length, 1);
  assert.equal(plan.claude_code_skill, undefined);
});

test('setup produces shell-free commands for both actual terminal clients', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'palatial-setup-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/palatial-agent.js', import.meta.url)), 'setup', '--client', 'both', '--dry-run'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: path.join(root, 'claude') }
  });
  assert.equal(result.status, 0, result.stderr);
  const { commands, claude_code_skill } = JSON.parse(result.stdout);
  assert.equal(commands[0].command, 'codex');
  assert.deepEqual(commands[0].args.slice(0, 4), ['mcp', 'add', 'palatial', '--']);
  assert.equal(commands[1].command, 'claude');
  assert.ok(commands[1].args.includes('stdio'));
  assert.equal(commands[1].args.at(-1), 'mcp');
  assert.ok(!result.stdout.includes('PALATIAL_API_KEY'));
  // A dry run reports the skill it would write and writes nothing.
  assert.equal(claude_code_skill.installed, false);
  assert.ok(claude_code_skill.path.endsWith(path.join('skills', 'palatial')));
  assert.ok(claude_code_skill.files.includes('SKILL.md'));
});

test('setup reports failure when registration succeeds but the Claude skill is not installed', async () => {
  const setup = await runSetup({
    client: 'claude-code',
    executable: '/package/bin/palatial-agent.js',
    runner: () => ({ status: 0, stdout: '', stderr: '' }),
    skillInstaller: async () => ({ installed: false, action: 'skipped', reason: 'unowned directory' })
  });
  assert.equal(setup.output.results[0].registered, true);
  assert.equal(setup.output.claude_code_skill.action, 'skipped');
  assert.equal(setup.failed, true);
});

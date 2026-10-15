import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { VERSION } from '../src/version.js';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this smoke through npm run test:package so npm_execpath is available.');
const runNpm = (args, options) => execFileSync(process.execPath, [npmCli, ...args], options);
const root = await mkdtemp(path.join(tmpdir(), 'palatial-package-smoke-'));
try {
  const pack = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', root], { encoding: 'utf8' }));
  assert.equal(pack.length, 1);
  assert.equal(pack[0].version, VERSION);
  assert.equal(pack[0].filename, `palatial-agent-tools-${VERSION}.tgz`);
  const tarball = path.join(root, pack[0].filename);
  const install = path.join(root, 'install');
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', install, tarball], { stdio: 'pipe' });

  const packageRoot = path.join(install, 'node_modules', '@palatial', 'agent-tools');
  const cli = path.join(packageRoot, 'bin', 'palatial-agent.js');
  assert.equal(JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')).version, VERSION);
  const cliVersion = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(cliVersion.status, 0, cliVersion.stderr);
  assert.equal(cliVersion.stdout.trim(), VERSION);
  const guide = spawnSync(process.execPath, [cli, 'guide', '--topic', 'parameters'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(guide.status, 0, guide.stderr);
  assert.match(guide.stdout, /CAD source-frame rules/);
  assert.match(await readFile(path.join(packageRoot, 'skills', 'palatial', 'SKILL.md'), 'utf8'), /Palatial asset generation/);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp'],
    env: { PATH: process.env.PATH, PALATIAL_API_KEY: '', PALATIAL_DOCS_CHECK: '0', XDG_CONFIG_HOME: root },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'current-package-smoke', version: '1.0' });
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion().version, VERSION);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 21);
    const primaryCreate = tools.find(tool => tool.name === 'palatial_create_asset');
    assert.ok(primaryCreate.inputSchema.properties.mode.enum.includes('auto'));
    for (const field of ['quality', 'dryRun', 'request_id', 'source_urls', 'source_up_axis']) assert.ok(primaryCreate.inputSchema.properties[field]);
    const overview = await client.callTool({ name: 'palatial_guide', arguments: { topic: 'overview' } });
    assert.match(overview.content[0].text, /palatial_create_asset.*mode: auto/s);
    const result = await client.callTool({ name: 'palatial_guide', arguments: { topic: 'parameters' } });
    assert.match(result.content[0].text, /collision_quality/);
    const resource = await client.readResource({ uri: 'palatial://guide/parameters' });
    assert.match(resource.contents[0].text, /shape_model/);
    const scenes = await client.callTool({ name: 'palatial_guide', arguments: { topic: 'scenes' } });
    assert.match(scenes.content[0].text, /palatial_create_scene/);
    assert.match(scenes.content[0].text, /confirm_spend/);
  } finally {
    await client.close();
  }
  console.log(`Current package smoke passed: ${path.basename(tarball)}`);
} finally {
  await rm(root, { recursive: true, force: true });
}

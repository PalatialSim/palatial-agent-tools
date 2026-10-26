import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
    assert.deepEqual(tools.map(tool => tool.name), ['palatial_agent']);
    assert.match(tools[0].description, /300 MiB.*314572800 bytes.*Mad Max/);
    assert.match(tools[0].inputSchema.properties.files.description, /300 MiB.*100 MiB/);
    assert.ok(tools[0].inputSchema.properties.request_id);
    assert.equal(tools[0].inputSchema.required?.includes('request_id') ?? false, false);
    assert.ok(tools[0].inputSchema.properties.turn_id);
    assert.equal(tools[0].inputSchema.properties.execution, undefined);
    const result = await client.callTool({ name: 'palatial_agent', arguments: { turn_id: 'receipt-1' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not authenticated/);
  } finally {
    await client.close();
  }
  const { PalatialClient } = await import(pathToFileURL(path.join(packageRoot, 'src', 'client.js')));
  const oversized = path.join(root, 'too-large.mp4');
  const handle = await open(oversized, 'w');
  await handle.truncate(300 * 1024 ** 2 + 1);
  await handle.close();
  let requests = 0;
  const native = new PalatialClient({ apiKey: 'fixture', fetchImpl: () => { requests++; throw new Error('No request expected.'); }, receiptDir: path.join(root, 'receipts') });
  await assert.rejects(native.startAgentWithFiles({ message: 'Use this clip.', files: [oversized] }), error => error.code === 'AGENT_VIDEO_TOO_LARGE' && /300 MiB.*Mad Max/.test(error.message));
  assert.equal(requests, 0);
  console.log(`Current package smoke passed: ${path.basename(tarball)}`);
} finally {
  await rm(root, { recursive: true, force: true });
}

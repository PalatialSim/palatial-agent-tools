#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PalatialClient, DEFAULT_API_URL } from '../src/client.js';
import { getApiKey, saveApiKey, deleteApiKey } from '../src/auth.js';
import { serveStdio } from '../src/mcp.js';

const HELP = `Palatial Agent Tools 0.1.0 (Node.js 22+)

palatial-agent login                      Enter your workspace API key privately
palatial-agent logout                     Delete the locally saved API key
palatial-agent doctor                     Read-only authentication/network check
palatial-agent setup --client codex       Register the MCP server in Codex CLI
palatial-agent setup --client claude-code Register the MCP server in Claude Code
palatial-agent setup --client both        Register it in both terminals
palatial-agent setup --client both --dry-run  Show commands without changing settings
palatial-agent mcp                        Run the stdio MCP server
palatial-agent create --request asset.json   Submit a generation request (uses credits)
palatial-agent status --asset-id ID       Check an existing asset
palatial-agent download --asset-id ID --output-dir ./assets  Export ZIP (uses credits)
palatial-agent cancel --asset-id ID       Cancel an existing asset

All command results are JSON. API keys are read from PALATIAL_API_KEY or the
local credentials file; never include keys in chat, command arguments, or git.
Creation returns an asset ID. Retain that ID and poll status; do not resubmit.
The package contains API transport only. Generation runs on Palatial servers.
`;

function readSecret() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run login in an interactive terminal. For automation, provide PALATIAL_API_KEY through your secret manager.');
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdout.write('Palatial workspace API key (input hidden): ');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onData = buffer => {
      for (const char of buffer.toString('utf8')) {
        if (char === '\u0003') { finish(); reject(new Error('Login canceled.')); return; }
        if (char === '\r' || char === '\n') { finish(); resolve(value); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    client: { type: 'string' }, 'dry-run': { type: 'boolean' }, request: { type: 'string' },
    'asset-id': { type: 'string' }, 'output-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }
  } });
  const command = positionals[0];
  if (values.version) { console.log('0.1.0'); return; }
  if (values.help || !command) { console.log(HELP); return; }
  if (positionals.length > 1) throw new Error('Unexpected positional arguments. Run palatial-agent --help.');
  if (command === 'mcp') { await serveStdio(); return; }
  if (command === 'setup') {
    if (!['codex', 'claude-code', 'both'].includes(values.client)) throw new Error('Choose --client codex, claude-code, or both.');
    const executable = realpathSync(fileURLToPath(import.meta.url));
    const commands = [];
    if (values.client !== 'claude-code') commands.push({ client: 'codex', command: 'codex', args: ['mcp', 'add', 'palatial', '--', process.execPath, executable, 'mcp'] });
    if (values.client !== 'codex') commands.push({ client: 'claude-code', command: 'claude', args: ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'palatial', '--', process.execPath, executable, 'mcp'] });
    if (values['dry-run']) return commands;
    const results = commands.map(item => {
      const result = spawnSync(item.command, item.args, { encoding: 'utf8', shell: false, timeout: 30000 });
      return { client: item.client, registered: result.status === 0, message: result.error?.message || result.stderr?.trim() || result.stdout?.trim() };
    });
    if (results.some(item => !item.registered)) process.exitCode = 1;
    return { results, next: 'Start a fresh coding-agent session, list Palatial tools, then run palatial_doctor. Restart after moving the installation or changing Node.js.' };
  }
  if (command === 'login') {
    const apiKey = await readSecret();
    const client = new PalatialClient({ apiKey, baseUrl: process.env.PALATIAL_API_URL || DEFAULT_API_URL });
    await client.doctor();
    await saveApiKey(apiKey);
    return { authenticated: true, message: 'Workspace key saved locally with restricted file permissions. PALATIAL_API_KEY, if set, takes precedence.' };
  }
  if (command === 'logout') {
    await deleteApiKey();
    return { saved_key_deleted: true, message: 'Also unset PALATIAL_API_KEY if configured. Deleting the local copy does not revoke the key in Palatial.' };
  }
  if (!['doctor', 'create', 'status', 'download', 'cancel'].includes(command)) throw new Error('Unknown command. Run palatial-agent --help.');
  const client = new PalatialClient({ apiKey: await getApiKey(), baseUrl: process.env.PALATIAL_API_URL || DEFAULT_API_URL });
  if (command === 'doctor') return client.doctor();
  if (command === 'create') {
    if (!values.request) throw new Error('Provide --request pointing to a JSON file.');
    return client.create(JSON.parse(await readFile(values.request, 'utf8')));
  }
  if (!values['asset-id']) throw new Error('Provide --asset-id.');
  if (command === 'status') return client.getAsset(values['asset-id']);
  if (command === 'cancel') return client.cancel(values['asset-id']);
  if (!values['output-dir']) throw new Error('Provide --output-dir.');
  return client.download(values['asset-id'], values['output-dir']);
}

try {
  const result = await main();
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Command failed.' }));
  process.exitCode = 1;
}

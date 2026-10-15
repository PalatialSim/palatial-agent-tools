import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import crossSpawn from 'cross-spawn';
import fs from 'node:fs';
const defaultFileExists = candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } };
export function windowsSetupInvocation(command, args) {
  if (/\.(?:com|exe)$/i.test(command)) return { command, args, options: {} };
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('The Windows command processor is unavailable.');
  const shell = path.join(systemRoot, 'System32', 'cmd.exe');
  if (!defaultFileExists(shell)) throw new Error('The Windows command processor is unavailable.');
  // Use the pinned parser's Windows quoting, then replace its ambient shell lookup.
  const parsed = crossSpawn._parse(command, args, {});
  return { command: shell, args: parsed.args, options: parsed.options };
}


import { spawnSync } from 'node:child_process';
import { installClaudeSkill } from './guide.js';

function inside(child, parent) {
  const left = process.platform === 'win32' ? child.toLowerCase() : child;
  const right = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const root = right.endsWith(path.sep) ? right : right + path.sep;
  return left === right || left.startsWith(root);
}

// Resolve a CLI by walking PATH. Skip the current directory and any candidate
// whose real path is inside it, then return only an absolute path.
export function resolveSetupCommand(name, { env = process.env, cwd = process.cwd(), platform = process.platform } = {}) {
  const pathKey = platform === 'win32' ? Object.keys(env).find(key => key.toLowerCase() === 'path') : 'PATH';
  const entries = (env[pathKey] || '').split(path.delimiter);
  const cwdReal = realpathSync.native(cwd);
  const names = [];
  const add = candidate => { if (!names.some(item => item.toLowerCase() === candidate.toLowerCase())) names.push(candidate); };
  add(name);
  if (platform === 'win32') for (const ext of (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')) if (ext) add(name + ext);
  for (const entry of entries) {
    if (!entry || !path.isAbsolute(entry)) continue;
    let dirReal;
    try { dirReal = realpathSync.native(entry); }
    catch { continue; }
    if (inside(dirReal, cwdReal)) continue;
    for (const candidateName of names) {
      const candidate = path.join(entry, candidateName);
      let real;
      try {
        const info = lstatSync(candidate);
        if (!info.isFile() && !info.isSymbolicLink()) continue;
        real = realpathSync.native(candidate);
        if (!statSync(real).isFile()) continue;
      } catch { continue; }
      if (inside(real, cwdReal)) continue;
      return real;
    }
  }
  throw new Error(`Could not find ${name} on PATH outside the current directory.`);
}

export async function runSetup({ client, executable, dryRun = false, runner = spawnSync, skillInstaller = installClaudeSkill, env = process.env, cwd = process.cwd() } = {}) {
  if (!['codex', 'claude-code', 'both'].includes(client)) throw new Error('Choose --client codex, claude-code, or both.');
  const commands = [];
  if (client !== 'claude-code') commands.push({ client: 'codex', command: 'codex', args: ['mcp', 'add', 'palatial', '--', process.execPath, executable, 'mcp'] });
  if (client !== 'codex') commands.push({ client: 'claude-code', command: 'claude', args: ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'palatial', '--', process.execPath, executable, 'mcp'] });
  const wantsSkill = client !== 'codex';
  if (dryRun) return { failed: false, output: { commands, ...(wantsSkill ? { claude_code_skill: await skillInstaller({ dryRun: true }) } : {}) } };

  const results = [];
  for (const item of commands) {
    let command;
    try { command = resolveSetupCommand(item.command, { env, cwd }); }
    catch (error) {
      results.push({ client: item.client, registered: false, message: error.message });
      continue;
    }
    const invocation = process.platform === 'win32' ? windowsSetupInvocation(command, item.args) : { command, args: item.args, options: {} };
    const result = runner(invocation.command, invocation.args, { encoding: 'utf8', shell: false, timeout: 30000, ...invocation.options });
    results.push({ client: item.client, registered: result.status === 0, message: result.error?.message || result.stderr?.trim() || result.stdout?.trim() });
  }
  const skill = wantsSkill ? await skillInstaller().catch(error => ({ installed: false, action: 'failed', reason: error.message })) : undefined;
  return {
    failed: results.some(item => !item.registered) || Boolean(skill && !skill.installed),
    output: { results, ...(skill ? { claude_code_skill: skill } : {}), next: 'Start a fresh coding-agent session, list Palatial tools, then run palatial_doctor. Restart after moving the installation or changing Node.js.' }
  };
}

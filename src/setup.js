import { spawnSync } from 'node:child_process';
import fs, { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import crossSpawn from 'cross-spawn';
import { installClaudeSkill } from './guide.js';

const defaultFileExists = candidate => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

const defaultRealPath = candidate => fs.realpathSync.native(candidate);

const sameOrInside = (candidate, root) => {
  if (!candidate || !root) return false;
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * Windows resolves a bare command name in the current directory before PATH.
 * Walk PATH, skip the working directory, and return an absolute executable.
 */
export function resolveWindowsExecutable(command, {
  pathEnv = process.env.PATH || '',
  cwd = process.cwd(),
  pathExt = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
  fileExists = defaultFileExists,
  realPath = defaultRealPath,
} = {}) {
  let cwdReal = cwd;
  try {
    cwdReal = realPath(cwd);
  } catch {
    cwdReal = path.resolve(cwd);
  }
  const names = new Set();
  for (const extension of pathExt.split(';')) {
    const suffix = extension.trim();
    if (/^\.(?:com|exe|bat|cmd)$/i.test(suffix)) names.add(command + suffix);
  }
  for (const entry of pathEnv.split(';')) {
    const directory = entry.trim();
    if (!directory || !path.isAbsolute(directory)) continue;
    const resolvedDirectory = path.resolve(directory);
    let directoryReal = resolvedDirectory;
    try {
      directoryReal = realPath(resolvedDirectory);
    } catch {
      directoryReal = resolvedDirectory;
    }
    if (path.relative(cwdReal, directoryReal) === '') continue;
    if (sameOrInside(directoryReal, cwdReal) && !sameOrInside(resolvedDirectory, cwd)) continue;
    for (const name of names) {
      const candidate = path.join(resolvedDirectory, name);
      if (!fileExists(candidate)) continue;
      let resolved = candidate;
      try {
        resolved = realPath(candidate);
      } catch {
        continue;
      }
      if (path.relative(cwdReal, path.dirname(resolved)) === '') continue;
      if (sameOrInside(resolved, cwdReal) && !sameOrInside(candidate, cwd)) continue;
      return resolved;
    }
  }
  throw new Error(`${command} was not found on PATH`);
}

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

  const results = commands.map(item => {
    let command;
    let args = item.args;
    let options = {};
    try {
      if (process.platform === 'win32') {
        const key = Object.keys(env).find(key => key.toLowerCase() === 'path');
        const invocation = windowsSetupInvocation(resolveWindowsExecutable(item.command, { pathEnv: env[key] || '', pathExt: env.PATHEXT, cwd }), item.args);
        command = invocation.command;
        args = invocation.args;
        options = invocation.options;
      } else command = resolveSetupCommand(item.command, { env, cwd });
      } catch (error) {
        return { client: item.client, registered: false, message: error.message };
      }
    const result = runner(command, args, { encoding: 'utf8', shell: false, timeout: 30000, ...options });
    return { client: item.client, registered: result.status === 0, message: result.error?.message || result.stderr?.trim() || result.stdout?.trim() };
  });
  const skill = wantsSkill ? await skillInstaller().catch(error => ({ installed: false, action: 'failed', reason: error.message })) : undefined;
  return {
    failed: results.some(item => !item.registered) || Boolean(skill && !skill.installed),
    output: { results, ...(skill ? { claude_code_skill: skill } : {}), next: 'Start a fresh coding-agent session, list Palatial tools, then run palatial_doctor. Restart after moving the installation or changing Node.js.' }
  };
}

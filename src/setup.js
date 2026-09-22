import { spawnSync } from 'node:child_process';
import { installClaudeSkill } from './guide.js';

export async function runSetup({ client, executable, dryRun = false, runner = spawnSync, skillInstaller = installClaudeSkill } = {}) {
  if (!['codex', 'claude-code', 'both'].includes(client)) throw new Error('Choose --client codex, claude-code, or both.');
  const commands = [];
  if (client !== 'claude-code') commands.push({ client: 'codex', command: 'codex', args: ['mcp', 'add', 'palatial', '--', process.execPath, executable, 'mcp'] });
  if (client !== 'codex') commands.push({ client: 'claude-code', command: 'claude', args: ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'palatial', '--', process.execPath, executable, 'mcp'] });
  const wantsSkill = client !== 'codex';
  if (dryRun) return { failed: false, output: { commands, ...(wantsSkill ? { claude_code_skill: await skillInstaller({ dryRun: true }) } : {}) } };

  const results = commands.map(item => {
    const result = runner(item.command, item.args, { encoding: 'utf8', shell: false, timeout: 30000 });
    return { client: item.client, registered: result.status === 0, message: result.error?.message || result.stderr?.trim() || result.stdout?.trim() };
  });
  const skill = wantsSkill ? await skillInstaller().catch(error => ({ installed: false, action: 'failed', reason: error.message })) : undefined;
  return {
    failed: results.some(item => !item.registered) || Boolean(skill && !skill.installed),
    output: { results, ...(skill ? { claude_code_skill: skill } : {}), next: 'Start a fresh coding-agent session, list Palatial tools, then run palatial_doctor. Restart after moving the installation or changing Node.js.' }
  };
}

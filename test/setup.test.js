import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { resolveWindowsExecutable, runSetup } from '../src/setup.js';

test('non-Windows setup still spawns codex and claude by name', { skip: process.platform === 'win32' }, async () => {
  const seen = [];
  const setup = await runSetup({
    client: 'both',
    executable: '/package/bin/palatial-agent.js',
    runner: (command, args) => {
      seen.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    },
    skillInstaller: async () => ({ installed: true, action: 'installed' }),
  });
  assert.equal(process.platform === 'win32', false);
  assert.deepEqual(seen.map(item => item.command), ['codex', 'claude']);
  assert.equal(setup.failed, false);
});

test('Windows setup uses an absolute PATH executable and ignores the working directory', () => {
  const cwd = path.resolve('/project');
  const planted = path.join(cwd, 'codex.EXE');
  const real = path.resolve('/tools/codex.EXE');
  const files = new Set([planted, real, path.join(cwd, 'via-link.EXE')]);
  const resolved = resolveWindowsExecutable('codex', {
    cwd,
    pathEnv: `${cwd};.;/tools`,
    pathExt: '.EXE',
    fileExists: candidate => files.has(candidate),
    realPath: candidate => candidate === path.resolve('/tools/alias.EXE') ? planted : candidate,
  });
  assert.equal(resolved, real);
});

test('Windows setup refuses a PATH entry whose real file is inside the working directory', () => {
  const cwd = path.resolve('/project');
  const planted = path.join(cwd, 'claude.EXE');
  assert.throws(
    () => resolveWindowsExecutable('claude', {
      cwd,
      pathEnv: '/tools',
      pathExt: '.EXE',
      fileExists: candidate => candidate === path.resolve('/tools/claude.EXE'),
      realPath: candidate => candidate === path.resolve('/tools/claude.EXE') ? planted : candidate,
    }),
    /claude was not found on PATH/,
  );
});

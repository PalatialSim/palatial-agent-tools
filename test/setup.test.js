import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { resolveWindowsExecutable, runSetup } from '../src/setup.js';

test('non-Windows setup resolves codex and claude to absolute executables', { skip: process.platform === 'win32' }, async t => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(path.join(tmpdir(), 'safe-setup-'));
  const bin = path.join(root, 'bin');
  const cwd = path.join(root, 'cwd');
  await mkdir(bin); await mkdir(cwd);
  await writeFile(path.join(bin, 'codex'), 'fixture');
  await writeFile(path.join(bin, 'claude'), 'fixture');
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen = [];
  const setup = await runSetup({
    client: 'both', env: { PATH: bin }, cwd,
    executable: '/package/bin/palatial-agent.js',
    runner: (command, args) => {
      seen.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    },
    skillInstaller: async () => ({ installed: true, action: 'installed' }),
  });
  assert.equal(process.platform === 'win32', false);
  assert.equal(seen.length, 2);
  for (const item of seen) assert.equal(path.isAbsolute(item.command), true);
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

test('Windows lookup ignores POSIX shims and relative PATH entries', () => {
  const cwd = path.resolve('/project');
  const executable = path.resolve('/tools/codex.CMD');
  assert.equal(resolveWindowsExecutable('codex', {
    cwd, pathEnv: `relative;.;${path.resolve('/tools')}`, pathExt: '.CMD',
    fileExists: candidate => [path.resolve('/tools/codex'), executable].includes(candidate),
    realPath: candidate => candidate,
  }), executable);
});

test('Windows lookup permits explicit user installation directories beneath cwd', () => {
  const cwd = path.resolve('/home');
  const executable = path.join(cwd, 'AppData', 'npm', 'codex.CMD');
  assert.equal(resolveWindowsExecutable('codex', {
    cwd, pathEnv: path.dirname(executable), pathExt: '.CMD',
    fileExists: candidate => candidate === executable, realPath: candidate => candidate,
  }), executable);
});

test('Windows setup runs a PATH batch shim with literal arguments through the system shell', { skip: process.platform !== 'win32' }, async t => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const { windowsSetupInvocation } = await import('../src/setup.js');
  const root = await mkdtemp(path.join(tmpdir(), 'palatial setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'node_modules', '.bin');
  await mkdir(bin, { recursive: true });
  const script = path.join(root, 'print.cjs');
  await writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const shim = path.join(bin, 'codex.cmd');
  await writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  await writeFile(path.join(root, 'cmd.exe'), 'untrusted cwd program');
  const args = ['mcp', 'a b', 'a&b', 'quote"value', 'x%PATH%y'];
  const invocation = windowsSetupInvocation(shim, args);
  assert.equal(invocation.command, path.join(process.env.SystemRoot, 'System32', 'cmd.exe'));
  const result = spawnSync(invocation.command, invocation.args, { ...invocation.options, cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout.trim()), args);
});

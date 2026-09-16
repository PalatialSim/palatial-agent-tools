import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, access } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { VERSION } from './version.js';

const ROOT = 'https://github.com/PalatialSim/palatial-agent-tools';
const RELEASES = 'https://api.github.com/repos/PalatialSim/palatial-agent-tools/releases/latest';
const TTL = 86400000;
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function isNewer(latest, current) {
  if (!stable.test(latest) || !stable.test(current)) throw new Error('Expected a stable semantic version.');
  const a = latest.split('.').map(BigInt), b = current.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
const defaultCache = () => path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'palatial-agent', 'update.json');

export async function checkForUpdate({ force = false, fetchImpl = fetch, cacheFile = defaultCache(), current = VERSION, now = Date.now(), disabled = process.env.PALATIAL_UPDATE_CHECK === '0' } = {}) {
  if (disabled) return { available: null, current, status: 'disabled' };
  const present = latest => ({ current, latest, available: isNewer(latest, current), status: 'checked', update_command: 'palatial-agent update --apply', restart_required: isNewer(latest, current) });
  if (!force) {
    try {
      const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
      const age = now - cached.checked_at;
      if (Number.isFinite(age) && age >= 0 && age < (cached.latest ? TTL : 600000)) {
        if (cached.latest) return { ...present(cached.latest), cached: true };
        return { available: null, current, status: 'unavailable', cached: true };
      }
    } catch { /* Invalid or missing cache: check the release service. */ }
  }
  let latest;
  try {
    const response = await fetchImpl(RELEASES, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `palatial-agent/${current}` }, redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('Release lookup failed.');
    const release = await response.json();
    if (release.draft || release.prerelease || typeof release.tag_name !== 'string' || !/^v/.test(release.tag_name)) throw new Error('Invalid release.');
    latest = release.tag_name.slice(1);
    isNewer(latest, current);
  } catch { latest = null; }
  const temporary = `${cacheFile}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ checked_at: now, latest }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, cacheFile);
  } catch { /* Cache failures must not hide a successful release check. */ }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
  return latest ? present(latest) : { available: null, current, status: 'unavailable' };
}

async function download(url, maxBytes, fetchImpl) {
  // No Palatial key or GitHub token is sent to public release storage.
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) throw new Error('Release asset download failed.');
  if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('Release download requires HTTPS.');
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxBytes) throw new Error('Release asset exceeds size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function installPackage(file) {
  // Use Node directly for npm on Windows, where npm.cmd cannot be execFile'd.
  const nodeDir = path.dirname(process.execPath);
  const candidates = [path.join(nodeDir, 'node_modules/npm/bin/npm-cli.js'), path.join(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const cli of candidates) {
    try { await access(cli); } catch { continue; }
    return promisify(execFile)(process.execPath, [cli, 'install', '--global', '--ignore-scripts', file], { timeout: 120000 });
  }
  if (process.platform === 'win32') throw new Error('Cannot locate npm. Install the release manually with npm.');
  return promisify(execFile)('npm', ['install', '--global', '--ignore-scripts', file], { timeout: 120000 });
}

export async function applyUpdate({ latest, current = VERSION, fetchImpl = fetch, installer = installPackage } = {}) {
  if (!isNewer(latest, current)) return { current, latest, updated: false, restart_required: false };
  const name = `palatial-agent-tools-${latest}.tgz`;
  const base = `${ROOT}/releases/download/v${latest}/`;
  const sums = (await download(`${base}${name}.sha256`, 4096, fetchImpl)).toString('utf8');
  const line = sums.trim().split(/\r?\n/).find(entry => entry.match(/^[a-f0-9]{64}  /) && entry.slice(66) === name);
  if (!line) throw new Error('Release checksum is missing or malformed.');
  const bytes = await download(`${base}${name}`, 32 * 1024 * 1024, fetchImpl);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  if (checksum !== line.slice(0, 64)) throw new Error('Release checksum mismatch; nothing was installed.');
  const directory = await mkdtemp(path.join(tmpdir(), 'palatial-update-'));
  try {
    const file = path.join(directory, name);
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    await installer(file);
  } finally { await rm(directory, { recursive: true, force: true }); }
  return { current, latest, updated: true, sha256: checksum, restart_required: true, message: 'Restart your MCP client. If setup points to a different installation, rerun setup from the updated global package.' };
}

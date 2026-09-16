import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { VERSION } from './version.js';

const RELEASES_URL = 'https://api.github.com/repos/PalatialSim/palatial-agent-tools/releases/latest';
const TTL_MS = 24 * 60 * 60 * 1000;
const cachePath = () => path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'palatial-agent', 'update.json');

export async function checkForUpdate({ force = false, fetchImpl = fetch } = {}) {
  const file = cachePath();
  if (!force) {
    try { const cached = JSON.parse(await readFile(file, 'utf8')); if (Date.now() - cached.checked_at < TTL_MS) return cached.result; } catch {}
  }
  try {
    const response = await fetchImpl(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `palatial-agent/${VERSION}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const release = await response.json();
    const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
    const latest = tag.replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(latest)) throw new Error('invalid release version');
    const result = { available: latest !== VERSION, current: VERSION, latest, update_command: 'palatial-agent update --apply', restart_required: true };
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify({ checked_at: Date.now(), result }) + '\n', { mode: 0o600 });
    return result;
  } catch { return { available: false, current: VERSION, check_failed: true }; }
}

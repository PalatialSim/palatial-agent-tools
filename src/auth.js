import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, unlink, rename } from 'node:fs/promises';

export function credentialPath(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'palatial-agent', 'credentials.json');
}

export async function getApiKey(env = process.env) {
  if (env.PALATIAL_API_KEY?.trim()) return env.PALATIAL_API_KEY.trim();
  try {
    const data = JSON.parse(await readFile(credentialPath(env), 'utf8'));
    if (typeof data.apiKey === 'string' && data.apiKey.trim()) return data.apiKey.trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read Palatial credentials. Run palatial-agent login again.');
  }
  throw new Error('Palatial is not authenticated. Run palatial-agent login in your terminal, or set PALATIAL_API_KEY in the environment that starts your coding agent. Do not paste your key into chat.');
}

export async function saveApiKey(apiKey, env = process.env) {
  if (!apiKey?.trim()) throw new Error('API key cannot be empty.');
  const file = credentialPath(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  // Replace atomically rather than following an existing file symlink or
  // leaving a partially written credential behind after interruption.
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ apiKey: apiKey.trim() }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function deleteApiKey(env = process.env) {
  await unlink(credentialPath(env)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

import { homedir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';

// One copy of the guidance ships in the package. The Claude Code skill and the
// MCP guide tool and resources all read these files, so the two delivery paths
// can never describe the API differently.
export const SKILL_NAME = 'palatial';
const OWNER = '@palatial/agent-tools';
const OWNER_FILE = '.palatial-agent-tools.json';
const SKILL_ROOT = new URL('../skills/palatial/', import.meta.url);

export const GUIDE_TOPICS = [
  { topic: 'overview', file: 'SKILL.md', title: 'Palatial asset generation', description: 'Workflow, credit rules, and how to choose a source and shape model.' },
  { topic: 'parameters', file: 'references/parameters.md', title: 'palatial_create_asset parameters', description: 'Every create parameter, its default, the sources that accept it, and the rules that reject a request.' },
  { topic: 'recipes', file: 'references/recipes.md', title: 'Worked requests', description: 'A complete create request for text, single image, multiview, parametric, and CAD.' },
  { topic: 'troubleshooting', file: 'references/troubleshooting.md', title: 'When something goes wrong', description: 'Failed, canceled, and paused jobs, partial exports, variant versus reprocess, and auth errors.' }
];

/** Skill frontmatter is metadata for Claude Code; an MCP reader wants the prose. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
function withoutFrontmatter(text) {
  const match = text.match(FRONTMATTER);
  return match ? text.slice(match[0].length).trimStart() : text;
}

export function guideTopic(topic) {
  const entry = GUIDE_TOPICS.find(item => item.topic === topic);
  if (!entry) throw new Error(`Unknown guide topic. Choose one of: ${GUIDE_TOPICS.map(item => item.topic).join(', ')}.`);
  return entry;
}

export async function readGuide(topic = 'overview') {
  const entry = guideTopic(topic);
  const text = withoutFrontmatter(await readFile(new URL(entry.file, SKILL_ROOT), 'utf8'));
  return { topic: entry.topic, title: entry.title, text, other_topics: GUIDE_TOPICS.filter(item => item.topic !== entry.topic).map(item => ({ topic: item.topic, description: item.description })) };
}

export function claudeSkillDirectory(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'skills', SKILL_NAME);
}

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function listInstalledFiles(directory, relative = '') {
  const found = [];
  const current = relative ? path.join(directory, ...relative.split('/')) : directory;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Managed path is a symlink: ${name}.`);
    if (entry.isDirectory()) found.push(...await listInstalledFiles(directory, name));
    else if (entry.isFile()) found.push(name);
    else throw new Error(`Managed path is not a regular file: ${name}.`);
  }
  return found;
}

function safeManagedPath(directory, file) {
  if (typeof file !== 'string' || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('Ownership marker contains an invalid managed path.');
  const destination = path.resolve(directory, file);
  if (!destination.startsWith(`${path.resolve(directory)}${path.sep}`)) throw new Error('Ownership marker contains an invalid managed path.');
  return destination;
}

async function inspectOwnedSkill(directory) {
  let directoryInfo;
  try { directoryInfo = await lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) return { exists: true, owned: false, reason: 'The skill path is not a regular directory.' };
  let marker;
  try {
    const markerInfo = await lstat(path.join(directory, OWNER_FILE));
    if (markerInfo.isSymbolicLink() || !markerInfo.isFile()) throw new Error('invalid marker');
    marker = JSON.parse(await readFile(path.join(directory, OWNER_FILE), 'utf8'));
  } catch {
    return { exists: true, owned: false, reason: 'The existing directory has no valid Palatial ownership marker.' };
  }
  if (marker.owner !== OWNER || marker.schema_version !== 1 || !marker.files || Array.isArray(marker.files) || typeof marker.files !== 'object') {
    return { exists: true, owned: false, reason: 'The existing directory has no valid Palatial ownership marker.' };
  }
  let installedFiles;
  try { installedFiles = await listInstalledFiles(directory); }
  catch (error) { return { exists: true, owned: false, reason: error.message }; }
  const previouslyManaged = new Set(Object.keys(marker.files));
  if (installedFiles.some(file => file !== OWNER_FILE && !previouslyManaged.has(file))) return { exists: true, owned: false, reason: 'The existing skill contains files this package does not own.' };
  for (const [file, expectedHash] of Object.entries(marker.files)) {
    let destination;
    try { destination = safeManagedPath(directory, file); }
    catch (error) { return { exists: true, owned: false, reason: error.message }; }
    let info;
    try { info = await lstat(destination); }
    catch { return { exists: true, owned: false, reason: `Managed file is missing: ${file}.` }; }
    if (info.isSymbolicLink() || !info.isFile()) return { exists: true, owned: false, reason: `Managed path is not a regular file: ${file}.` };
    if (typeof expectedHash !== 'string' || expectedHash !== sha256(await readFile(destination))) return { exists: true, owned: false, reason: `Managed file was modified after installation: ${file}.` };
  }
  return { exists: true, owned: true };
}

/**
 * Claude Code loads skills from disk, so setup copies the packaged files into
 * the user's skill directory. A directory that is not ours is left alone: the
 * user may have written their own Palatial skill, and silently replacing it
 * would destroy work this client never created.
 */
export async function installClaudeSkill({ env = process.env, dryRun = false } = {}) {
  const directory = claudeSkillDirectory(env);
  const files = GUIDE_TOPICS.map(entry => entry.file);
  const inspection = await inspectOwnedSkill(directory);
  if (inspection.exists && !inspection.owned) return { installed: false, action: 'skipped', path: directory, reason: `${inspection.reason} Remove or rename it, then rerun setup.` };
  const action = inspection.exists ? 'refreshed' : 'created';
  if (dryRun) return { installed: false, action: `would be ${action}`, path: directory, files };

  const parent = path.dirname(directory);
  await mkdir(parent, { recursive: true });
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error('Claude skill parent must be a regular directory, not a symlink.');
  const staging = await mkdtemp(path.join(parent, '.palatial-stage-'));
  const backup = path.join(parent, `.palatial-backup-${randomUUID()}`);
  let backedUp = false;
  try {
    const hashes = {};
    for (const file of files) {
      const content = await readFile(new URL(file, SKILL_ROOT));
      hashes[file] = sha256(content);
      const destination = path.join(staging, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content, { flag: 'wx', mode: 0o600 });
    }
    await writeFile(path.join(staging, OWNER_FILE), JSON.stringify({ owner: OWNER, schema_version: 1, files: hashes }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (inspection.exists) { await rename(directory, backup); backedUp = true; }
    try { await rename(staging, directory); }
    catch (error) {
      if (backedUp) { await rename(backup, directory); backedUp = false; }
      throw error;
    }
    if (backedUp) { await rm(backup, { recursive: true }); backedUp = false; }
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (backedUp) await rename(backup, directory).catch(() => {});
  }
  return { installed: true, action, path: directory, files };
}

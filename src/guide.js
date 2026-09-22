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

async function inspectOwnedSkill(directory, files) {
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
  if (marker.owner !== OWNER || marker.schema_version !== 1 || typeof marker.files !== 'object') {
    return { exists: true, owned: false, reason: 'The existing directory has no valid Palatial ownership marker.' };
  }
  const expectedRoot = new Set(['SKILL.md', 'references', OWNER_FILE]);
  const expectedReferences = new Set(files.filter(file => file.startsWith('references/')).map(file => path.basename(file)));
  const rootEntries = await readdir(directory);
  let referencesInfo;
  try { referencesInfo = await lstat(path.join(directory, 'references')); }
  catch { return { exists: true, owned: false, reason: 'Managed references directory is missing.' }; }
  if (referencesInfo.isSymbolicLink() || !referencesInfo.isDirectory()) return { exists: true, owned: false, reason: 'Managed references path is not a regular directory.' };
  const referenceEntries = await readdir(path.join(directory, 'references')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  if (rootEntries.some(entry => !expectedRoot.has(entry)) || referenceEntries.some(entry => !expectedReferences.has(entry))) {
    return { exists: true, owned: false, reason: 'The existing skill contains files this package does not own.' };
  }
  for (const file of files) {
    const destination = path.join(directory, file);
    let info;
    try { info = await lstat(destination); }
    catch { return { exists: true, owned: false, reason: `Managed file is missing: ${file}.` }; }
    if (info.isSymbolicLink() || !info.isFile()) return { exists: true, owned: false, reason: `Managed path is not a regular file: ${file}.` };
    if (marker.files[file] !== sha256(await readFile(destination))) return { exists: true, owned: false, reason: `Managed file was modified after installation: ${file}.` };
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
  const configRoot = env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  const files = GUIDE_TOPICS.map(entry => entry.file);
  const inspection = await inspectOwnedSkill(directory, files);
  if (inspection.exists && !inspection.owned) return { installed: false, action: 'skipped', path: directory, reason: `${inspection.reason} Remove or rename it, then rerun setup.` };
  const action = inspection.exists ? 'refreshed' : 'created';
  try {
    const configInfo = await lstat(configRoot);
    if (configInfo.isSymbolicLink() || !configInfo.isDirectory()) throw new Error('Claude config path must be a regular directory, not a symlink.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
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

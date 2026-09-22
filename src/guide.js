import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

// One copy of the guidance ships in the package. The Claude Code skill and the
// MCP guide tool and resources all read these files, so the two delivery paths
// can never describe the API differently.
export const SKILL_NAME = 'palatial';
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

/**
 * Claude Code loads skills from disk, so setup copies the packaged files into
 * the user's skill directory. A directory that is not ours is left alone: the
 * user may have written their own Palatial skill, and silently replacing it
 * would destroy work this client never created.
 */
export async function installClaudeSkill({ env = process.env, dryRun = false } = {}) {
  const directory = claudeSkillDirectory(env);
  const files = GUIDE_TOPICS.map(entry => entry.file);
  let existing;
  try { existing = await readFile(path.join(directory, 'SKILL.md'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Only the frontmatter block decides ownership. A `name:` line further down
  // the document is prose, and matching it would let setup delete someone's work.
  const declaredName = existing?.match(FRONTMATTER)?.[1].match(/^name:[ \t]*(\S+)[ \t]*$/m)?.[1];
  if (existing !== undefined && declaredName !== SKILL_NAME) {
    return { installed: false, action: 'skipped', path: directory, reason: 'A different skill already exists at this path. Remove or rename it, then rerun setup.' };
  }
  const action = existing === undefined ? 'created' : 'refreshed';
  if (dryRun) return { installed: false, action: `would be ${action}`, path: directory, files };
  for (const file of files) {
    const destination = path.join(directory, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(new URL(file, SKILL_ROOT), 'utf8'));
  }
  return { installed: true, action, path: directory, files };
}

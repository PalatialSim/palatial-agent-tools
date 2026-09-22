import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSchema } from '../src/client.js';
import { GUIDE_TOPICS, readGuide, claudeSkillDirectory, installClaudeSkill } from '../src/guide.js';

const guideFile = file => readFile(new URL(`../skills/palatial/${file}`, import.meta.url), 'utf8');

/** Every create field and closed value the schema accepts, for documentation checks. */
function schemaSurface(schema, keys = new Set(), values = new Set()) {
  const walk = node => {
    const def = node?.def;
    if (!def) return;
    if (def.type === 'object') for (const [key, child] of Object.entries(def.shape)) { keys.add(key); walk(child); }
    else if (def.type === 'enum') for (const value of Object.values(def.entries)) values.add(String(value));
    else if (def.type === 'literal') for (const value of def.values) values.add(String(value));
    else if (def.type === 'union') for (const option of def.options) walk(option);
    else if (def.type === 'array') walk(def.element);
    else if (def.innerType) walk(def.innerType);
  };
  walk(schema);
  return { keys, values };
}

test('the parameter reference documents every create field the schema accepts', async () => {
  const text = await guideFile('references/parameters.md');
  const { keys } = schemaSurface(createSchema);
  const missing = [...keys].filter(key => !text.includes(`\`${key}\``));
  assert.deepEqual(missing, [], `Undocumented create parameters: ${missing.join(', ')}`);
});

test('the parameter reference documents every closed value the schema accepts', async () => {
  const text = await guideFile('references/parameters.md');
  const { values } = schemaSurface(createSchema);
  // Numeric limits are written with thousands separators in prose.
  const documented = text.replaceAll(',', '');
  const missing = [...values].filter(value => !documented.includes(value));
  assert.deepEqual(missing, [], `Undocumented parameter values: ${missing.join(', ')}`);
});

test('the skill declares the frontmatter Claude Code loads it by', async () => {
  const text = await guideFile('SKILL.md');
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(frontmatter, 'SKILL.md must start with YAML frontmatter.');
  assert.match(frontmatter[1], /^name: palatial$/m);
  const description = frontmatter[1].match(/^description: (.+)$/m);
  assert.ok(description, 'Frontmatter must carry a description so the skill can be routed.');
  assert.ok(description[1].length > 80, 'The description decides when the skill triggers; keep it specific.');
});

test('every guide topic resolves, and the overview drops its frontmatter', async () => {
  for (const entry of GUIDE_TOPICS) {
    const guide = await readGuide(entry.topic);
    assert.equal(guide.title, entry.title);
    assert.ok(guide.text.length > 400, `${entry.topic} guidance is unexpectedly short.`);
    assert.equal(guide.other_topics.length, GUIDE_TOPICS.length - 1);
  }
  const overview = await readGuide();
  assert.equal(overview.topic, 'overview');
  assert.ok(!overview.text.startsWith('---'), 'Frontmatter is client metadata, not guidance.');
  assert.match(overview.text, /palatial_create_asset/);
});

test('an unknown topic names the topics that exist', async () => {
  await assert.rejects(readGuide('everything'), error => {
    assert.match(error.message, /parameters/);
    assert.match(error.message, /troubleshooting/);
    return true;
  });
});

test('setup installs the skill where Claude Code reads it, and refreshes its own copy', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'palatial-skill-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { CLAUDE_CONFIG_DIR: home };
  const directory = claudeSkillDirectory(env);
  assert.equal(directory, path.join(home, 'skills', 'palatial'));

  const planned = await installClaudeSkill({ env, dryRun: true });
  assert.equal(planned.installed, false);
  assert.match(planned.action, /created/);
  await assert.rejects(stat(path.join(directory, 'SKILL.md')), { code: 'ENOENT' }, 'A dry run must not write.');

  const created = await installClaudeSkill({ env });
  assert.equal(created.installed, true);
  assert.equal(created.action, 'created');
  for (const file of created.files) assert.equal(await readFile(path.join(directory, file), 'utf8'), await guideFile(file));

  await writeFile(path.join(directory, 'SKILL.md'), '---\nname: palatial\n---\nstale\n');
  const refreshed = await installClaudeSkill({ env });
  assert.equal(refreshed.action, 'refreshed');
  assert.equal(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), await guideFile('SKILL.md'));
});

test('setup never overwrites a skill this client did not write', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'palatial-skill-foreign-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { CLAUDE_CONFIG_DIR: home };
  const directory = claudeSkillDirectory(env);
  const mine = '---\nname: my-own-palatial-skill\ndescription: hand written\n---\nkeep me\n';
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), mine);

  const result = await installClaudeSkill({ env });
  assert.equal(result.installed, false);
  assert.equal(result.action, 'skipped');
  assert.match(result.reason, /Remove or rename/);
  assert.equal(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), mine);
});

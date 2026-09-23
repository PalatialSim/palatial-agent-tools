import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, mkdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createSchema } from '../src/client.js';
import { GUIDE_TOPICS, readGuide, claudeSkillDirectory, installClaudeSkill } from '../src/guide.js';

const guideFile = file => readFile(new URL(`../skills/palatial/${file}`, import.meta.url), 'utf8');

function parameterRows(text) {
  const rows = new Map();
  for (const line of text.split('\n')) {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    const field = cells[0]?.match(/^`([^`]+)`$/)?.[1];
    if (field) {
      assert.ok(!rows.has(field), `Duplicate parameter row: ${field}`);
      rows.set(field, cells);
    }
  }
  return rows;
}

function closedValues(node) {
  const def = node?.def;
  if (!def) return [];
  if (def.type === 'optional' || def.type === 'default') return closedValues(def.innerType);
  if (def.type === 'array') return closedValues(def.element);
  if (def.type === 'enum') return Object.values(def.entries).map(String);
  if (def.type === 'literal') return def.values.map(String);
  if (def.type === 'union') return def.options.flatMap(closedValues);
  if (def.type === 'object') return Object.keys(def.shape);
  return [];
}

test('the parameter reference structurally matches every create field and closed value', async () => {
  const text = await guideFile('references/parameters.md');
  const rows = parameterRows(text);
  const shape = createSchema.def.shape;
  assert.deepEqual([...rows.keys()].sort(), Object.keys(shape).sort());
  for (const [field, schema] of Object.entries(shape)) {
    const expected = closedValues(schema).sort();
    if (!expected.length) continue;
    const documented = [...rows.get(field)[1].matchAll(/`([^`]+)`/g)].map(match => match[1]).filter(value => expected.includes(value)).sort();
    assert.deepEqual(documented, expected, `${field} closed values drifted from the schema`);
  }
});

test('the parameter reference pins source applicability and effective defaults', async () => {
  const rows = parameterRows(await guideFile('references/parameters.md'));
  const expected = {
    source: ['required', 'all'], name: ['required', 'all'], description: ['required', 'all'],
    engine: ['`["isaac_sim"]`', 'all'], workspace: ["the API key's workspace", 'all'],
    image_path: ['none', '`image`, `cad`'], image_paths: ['none', '`image`'], views: ['none', '`image`'], reconstruct: ['`true` for multiview', '`image`'], mesh_path: ['none', '`cad`'], datasheet_path: ['none', '`cad`'],
    create_articulation: ['`false`', 'all'], enable_parts_segmentation: ['`true`', 'all'], run_simulation: ['`true`', 'all'],
    collision_quality: ['`medium` for ordinary rigid assets', 'all'], mesh_quality: ['`high`; `medium` when parts segmentation is off and articulation is not requested', '`text`, `image`'],
    shape_model: ['`auto`', '`text`, `image`'], effort: ['`low` when parametric', '`text`, `image`'], texture_model: ['`auto`', 'all'], apply_textures: ['`true` with a CAD reference image, `false` without one', '`cad`'],
    repair_mesh: ['`true`', 'all'], replace_glass: ['`false`', 'all'], auto_scale: ['`true`', 'all'],
    body_type: ['`rigid_bodies`', 'all'], newton_solver: ['`vbd` for soft bodies, `mujoco` for rigid', 'all'],
    regenerate_parts: ['`false`', '`cad`'], keep_existing_textures: ['`false`', '`cad`'],
    keep_existing_shape: ['`false`', '`cad`'], physics_validation_only: ['`false`', '`cad`'],
    texture_size: ['`4096`', 'all'], optimize_textures: ['`true`', 'all'], texture_max_resolution: ['`4096`', 'all'],
    decimation: ['see above', 'all'], decimation_mode: ['see above', 'all'], decimation_target_faces: ['none', 'all'], decimation_target_ratio: ['none', 'all'],
    triangle_count: ['`auto`', 'all'], mesh_density: ['`medium`', 'all'],
    units: ['`m` for text; format-dependent for CAD', '`text`, `cad`'], meters_per_unit: ['none', '`cad`'], up_direction: ['`y` for text; format-dependent for CAD', '`text`, `cad`']
  };
  assert.deepEqual(Object.fromEntries([...rows].map(([field, cells]) => [field, [cells[2], cells[3]]])), expected);
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

  const refreshed = await installClaudeSkill({ env });
  assert.equal(refreshed.action, 'refreshed');
  assert.equal(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), await guideFile('SKILL.md'));
  assert.equal(JSON.parse(await readFile(path.join(directory, '.palatial-agent-tools.json'), 'utf8')).owner, '@palatial/agent-tools');
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

test('setup does not infer ownership from a matching name or partial directory', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'palatial-skill-unowned-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { CLAUDE_CONFIG_DIR: home };
  const directory = claudeSkillDirectory(env);
  await mkdir(path.join(directory, 'references'), { recursive: true });
  const mine = '---\nname: palatial\ndescription: user-authored\n---\nkeep me\n';
  await writeFile(path.join(directory, 'SKILL.md'), mine);
  await writeFile(path.join(directory, 'references', 'parameters.md'), 'keep this too\n');
  const result = await installClaudeSkill({ env });
  assert.equal(result.installed, false);
  assert.match(result.reason, /ownership marker/);
  assert.equal(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), mine);
  assert.equal(await readFile(path.join(directory, 'references', 'parameters.md'), 'utf8'), 'keep this too\n');
});

test('setup refuses modified managed files and symlink targets', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'palatial-skill-protected-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { CLAUDE_CONFIG_DIR: home };
  const directory = claudeSkillDirectory(env);
  await installClaudeSkill({ env });
  await writeFile(path.join(directory, 'SKILL.md'), 'locally edited\n');
  const modified = await installClaudeSkill({ env });
  assert.equal(modified.installed, false);
  assert.match(modified.reason, /modified after installation/);
  assert.equal(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), 'locally edited\n');

  const symlinkHome = await mkdtemp(path.join(tmpdir(), 'palatial-skill-symlink-'));
  t.after(() => rm(symlinkHome, { recursive: true, force: true }));
  const outside = path.join(symlinkHome, 'outside.md');
  const symlinkDirectory = claudeSkillDirectory({ CLAUDE_CONFIG_DIR: symlinkHome });
  await mkdir(symlinkDirectory, { recursive: true });
  await writeFile(outside, 'outside\n');
  await symlink(outside, path.join(symlinkDirectory, 'SKILL.md'));
  const linked = await installClaudeSkill({ env: { CLAUDE_CONFIG_DIR: symlinkHome } });
  assert.equal(linked.installed, false);
  assert.equal(await readFile(outside, 'utf8'), 'outside\n');
});

test('setup refreshes an owned skill across package file additions and removals', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'palatial-skill-upgrade-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { CLAUDE_CONFIG_DIR: home };
  const directory = claudeSkillDirectory(env);
  await installClaudeSkill({ env });
  const markerPath = path.join(directory, '.palatial-agent-tools.json');

  const smaller = JSON.parse(await readFile(markerPath, 'utf8'));
  delete smaller.files['references/recipes.md'];
  await rm(path.join(directory, 'references', 'recipes.md'));
  await writeFile(markerPath, JSON.stringify(smaller));
  assert.equal((await installClaudeSkill({ env })).action, 'refreshed');
  assert.equal(await readFile(path.join(directory, 'references', 'recipes.md'), 'utf8'), await guideFile('references/recipes.md'));

  const retired = path.join(directory, 'references', 'retired.md');
  const retiredContent = 'old package-owned file\n';
  await writeFile(retired, retiredContent);
  const larger = JSON.parse(await readFile(markerPath, 'utf8'));
  larger.files['references/retired.md'] = createHash('sha256').update(retiredContent).digest('hex');
  await writeFile(markerPath, JSON.stringify(larger));
  assert.equal((await installClaudeSkill({ env })).action, 'refreshed');
  await assert.rejects(stat(retired), { code: 'ENOENT' });
});

test('setup accepts a symlinked config root but still refuses unowned extra files', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'palatial-skill-linked-root-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const actual = path.join(home, 'actual');
  const linked = path.join(home, 'linked');
  await mkdir(actual);
  await symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const env = { CLAUDE_CONFIG_DIR: linked };
  assert.equal((await installClaudeSkill({ env })).installed, true);
  const directory = claudeSkillDirectory(env);
  await writeFile(path.join(directory, 'notes.md'), 'user file\n');
  const result = await installClaudeSkill({ env });
  assert.equal(result.installed, false);
  assert.match(result.reason, /does not own/);
  assert.equal(await readFile(path.join(directory, 'notes.md'), 'utf8'), 'user file\n');
});

const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../bin/palatial-agent.js', import.meta.url)), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });

test('the CLI prints the guidance as readable Markdown, with no key and no API call', async () => {
  const overview = cli('guide');
  assert.equal(overview.status, 0, overview.stderr);
  assert.ok(overview.stdout.startsWith('# Palatial asset generation'), 'A person reads this; it must not arrive as an escaped JSON string.');
  assert.ok(overview.stdout.endsWith('\n'));
  assert.equal(overview.stdout, await guideFile('SKILL.md').then(text => text.slice(text.indexOf('---', 3) + 4).trimStart()));

  const parameters = cli('guide', '--topic', 'parameters');
  assert.equal(parameters.status, 0, parameters.stderr);
  assert.match(parameters.stdout, /Strict decimation requires exactly one target/);
});

test('an unusable guide topic fails loudly and names the topics that exist', () => {
  const result = cli('guide', '--topic', 'everything');
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stderr).error, /overview, parameters, recipes, troubleshooting/);
});

test('help lists the guide command and every topic it accepts', () => {
  const help = cli('--help');
  assert.match(help.stdout, /palatial-agent guide {2,}/);
  for (const entry of GUIDE_TOPICS) assert.ok(help.stdout.includes(entry.topic), `help omits the ${entry.topic} topic`);
});

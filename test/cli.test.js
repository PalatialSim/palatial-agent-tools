import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

test('CLI repair request reaches the shared API client once with exact feedback and lineage', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'palatial-cli-feedback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requestPath = path.join(dir, 'repair.json');
  const observedPath = path.join(dir, 'observed.json');
  const mockPath = path.join(dir, 'fetch.mjs');
  const body = { from: 'texture', mode: 'auto', sourceRunId: 'asset-source', feedback: 'Add readable key legends; preserve the housing.' };
  await writeFile(requestPath, JSON.stringify(body));
  await writeFile(mockPath, `import { writeFile } from 'node:fs/promises';
    globalThis.fetch = async (url, init) => {
      await writeFile(process.env.TEST_OBSERVATION, JSON.stringify({ url: String(url), method: init.method, body: JSON.parse(init.body) }));
      return new Response(JSON.stringify({ id: 'asset-keyboard' }), { headers: { 'content-type': 'application/json' } });
    };`);
  const result = execFileSync(process.execPath, ['--import', pathToFileURL(mockPath).href,
    fileURLToPath(new URL('../bin/palatial-agent.js', import.meta.url)), 'reprocess', '--asset-id', 'asset-keyboard', '--request', requestPath],
    { encoding: 'utf8', env: { PATH: process.env.PATH, PALATIAL_API_KEY: 'fixture-key',
      PALATIAL_API_URL: 'https://api.example.test/api/v1/external/', TEST_OBSERVATION: observedPath } });
  assert.equal(JSON.parse(result).id, 'asset-keyboard');
  assert.deepEqual(JSON.parse(await readFile(observedPath, 'utf8')), {
    url: 'https://api.example.test/api/v1/external/assets/asset-keyboard/reprocess', method: 'POST', body });
});

test('CLI scene-message sends one message with the confirm-spend flag to the messages route', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'palatial-cli-scene-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const observedPath = path.join(dir, 'observed.json');
  const mockPath = path.join(dir, 'fetch.mjs');
  await writeFile(mockPath, `import { writeFile } from 'node:fs/promises';
    globalThis.fetch = async (url, init) => {
      await writeFile(process.env.TEST_OBSERVATION, JSON.stringify({ url: String(url), method: init.method, body: JSON.parse(init.body) }));
      return new Response(JSON.stringify({ message: { action: 'continued' } }), { headers: { 'content-type': 'application/json' } });
    };`);
  const sceneId = 'abcdef0123456789abcdef01';
  const requestId = '6f1c1f9e-1d0b-4c39-9a0e-0d2b7b1b6c11';
  const result = execFileSync(process.execPath, ['--import', pathToFileURL(mockPath).href,
    fileURLToPath(new URL('../bin/palatial-agent.js', import.meta.url)), 'scene-message', '--scene-id', sceneId,
    '--text', 'Add a rug.', '--request-id', requestId, '--confirm-spend', '--regenerate-object', 'chair-2'],
    { encoding: 'utf8', env: { PATH: process.env.PATH, PALATIAL_API_KEY: 'fixture-key',
      PALATIAL_API_URL: 'https://api.example.test/api/v1/external/', TEST_OBSERVATION: observedPath } });
  assert.equal(JSON.parse(result).message.action, 'continued');
  assert.deepEqual(JSON.parse(await readFile(observedPath, 'utf8')), {
    url: `https://api.example.test/api/v1/external/scene-generations/${sceneId}/messages`, method: 'POST',
    body: { request_id: requestId, text: 'Add a rug.', confirm_spend: true, regenerate_objects: ['chair-2'] } });
});

test('CLI scene-message reports a refusal with its code, next_message and request_id', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'palatial-cli-refusal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mockPath = path.join(dir, 'fetch.mjs');
  const nextMessage = { action: 'continue', requires_confirm_spend: true, accepts_text: true, requires_text: true, accepts_regenerate_objects: true,
    regenerable_objects: [], expected_head: null, question: null, reason: null, price_basis: 'new_work_actual_cost' };
  await writeFile(mockPath, `globalThis.fetch = async () => Response.json({ statusCode: 409, code: 'confirm_spend_required',
    message: 'Continuing a scene that ended is new paid work.', next_message: ${JSON.stringify(nextMessage)} }, { status: 409 });`);
  const requestId = '6f1c1f9e-1d0b-4c39-9a0e-0d2b7b1b6c11';
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(mockPath).href,
    fileURLToPath(new URL('../bin/palatial-agent.js', import.meta.url)), 'scene-message', '--scene-id', 'abcdef0123456789abcdef01',
    '--text', 'Add a rug.', '--request-id', requestId],
    { encoding: 'utf8', env: { PATH: process.env.PATH, PALATIAL_API_KEY: 'fixture-key', PALATIAL_API_URL: 'https://api.example.test/api/v1/external/' } });
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'confirm_spend_required');
  assert.deepEqual(error.next_message, nextMessage);
  assert.equal(error.request_id, requestId);
});

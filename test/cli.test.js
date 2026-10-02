import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkForUpdate, applyUpdate, isNewer } from '../src/update.js';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'palatial-update-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { cacheFile: path.join(dir, 'update.json'), current: '0.1.0', now: 100000000 };
}
const release = tag => new Response(JSON.stringify({ tag_name: tag }), { headers: { 'Content-Type': 'application/json' } });

test('release comparison handles numeric order, equality and downgrades', () => {
  assert.equal(isNewer('0.10.0', '0.9.0'), true);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
  assert.equal(isNewer('0.1.0', '0.2.0'), false);
  for (const v of ['0.01.0', 'v0.2.0', '0.2.0;echo bad', '0.2.0-beta']) assert.throws(() => isNewer(v, '0.1.0'));
});

test('update cache avoids network and recalculates availability after a package upgrade', async t => {
  const options = await fixture(t); let calls = 0;
  const fetchImpl = async () => { calls++; return release('v0.2.0'); };
  assert.equal((await checkForUpdate({ ...options, fetchImpl })).available, true);
  assert.equal((await checkForUpdate({ ...options, fetchImpl })).cached, true);
  assert.equal((await checkForUpdate({ ...options, current: '0.2.0', fetchImpl })).available, false);
  assert.equal(calls, 1);
  await checkForUpdate({ ...options, now: options.now + 86400001, fetchImpl });
  assert.equal(calls, 2);
});

test('offline, malformed, and failed release lookups return unknown, never up-to-date', async t => {
  const options = await fixture(t);
  for (const fetchImpl of [async () => { throw new Error('offline'); }, async () => release('bogus'), async () => new Response('', { status: 429 })]) {
    assert.equal((await checkForUpdate({ ...options, force: true, fetchImpl })).available, null);
  }
  const cached = await checkForUpdate({ ...options, fetchImpl: () => { throw new Error('must not fetch'); } });
  assert.equal(cached.cached, true);
  assert.equal(cached.status, 'unavailable');
});

test('corrupt cache refreshes, disabled checks avoid network, unwritable cache preserves result', async t => {
  const options = await fixture(t);
  await writeFile(options.cacheFile, '{broken');
  assert.equal((await checkForUpdate({ ...options, fetchImpl: async () => release('v0.2.0') })).available, true);
  assert.equal((await checkForUpdate({ ...options, disabled: true, fetchImpl: () => { throw Error('must not fetch'); } })).status, 'disabled');
  const parentFile = options.cacheFile;
  assert.equal((await checkForUpdate({ ...options, cacheFile: path.join(parentFile, 'child'), force: true, fetchImpl: async () => release('v0.2.0') })).available, true);
});

test('verified update installs downloaded bytes and cleans up its temporary package', async () => {
  const bytes = Buffer.from('test tarball bytes');
  const hash = createHash('sha256').update(bytes).digest('hex');
  let installed;
  const result = await applyUpdate({ current: '0.1.0', latest: '0.2.0', fetchImpl: async (url, options) => {
    assert.equal(options.headers, undefined);
    return new Response(url.endsWith('.sha256') ? `${hash}  palatial-agent-tools-0.2.0.tgz\n` : bytes);
  }, installer: async file => { installed = file; assert.deepEqual(await readFile(file), bytes); } });
  assert.equal(result.updated, true);
  await assert.rejects(stat(installed), { code: 'ENOENT' });
});

test('checksum mismatch, missing checksum, and downgrade never invoke installer', async () => {
  let calls = 0; const installer = async () => { calls++; };
  const fetchImpl = async url => new Response(url.endsWith('.sha256') ? `${'0'.repeat(64)}  palatial-agent-tools-0.2.0.tgz\n` : 'bad');
  await assert.rejects(applyUpdate({ latest: '0.2.0', current: '0.1.0', fetchImpl, installer }), /checksum mismatch/);
  await assert.rejects(applyUpdate({ latest: '0.2.0', current: '0.1.0', fetchImpl: async () => new Response('', { status: 404 }), installer }), /download failed/);
  assert.equal((await applyUpdate({ latest: '0.1.0', current: '0.2.0', installer })).updated, false);
  assert.equal(calls, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PalatialClient } from '../src/client.js';
import {
  HANDOFF_SCHEMA,
  buildHandoff,
  detailsFields,
  inferGenerationType,
  isaacPluginGuidance,
  readHandoffFile,
  resolveHandoffPath,
  defaultHandoffPath,
  wellKnownHandoffPath,
  viewerUrl,
  writeHandoffFile
} from '../src/handoff.js';

const PLUGIN_ASSET_ROUTE = /^\/(?:workspace\/[A-Za-z0-9_-]{1,128}\/assets|viewer)\/([A-Za-z0-9_-]{1,128})\/?$/;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('viewer URL matches the Isaac plugin dashboard parser', () => {
  const url = new URL(viewerUrl('6a8f06003febd2fb7542daa9'));
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'dashboard.palatial.cloud');
  assert.equal(PLUGIN_ASSET_ROUTE.exec(url.pathname)[1], '6a8f06003febd2fb7542daa9');
});

test('READY handoff is strict v1 JSON with plugin-owned export', () => {
  const document = buildHandoff({
    asset_id: 'asset-ready',
    status: 'READY',
    api_origin: 'https://dashboard.palatial.cloud',
    name: 'Storage bin',
    source: 'text',
    generation_type: 'texttosim',
    written_at: '2026-09-21T08:00:00.000Z'
  });
  assert.equal(document.schema, HANDOFF_SCHEMA);
  assert.equal(document.import_ready, true);
  assert.equal(document.export.owner, 'plugin');
  assert.equal(document.export.mcp_should_download, false);
  assert.equal(document.dashboard_url, 'https://dashboard.palatial.cloud/viewer/asset-ready');
  assert.deepEqual(document.engine, ['isaac_sim']);
});

test('non-READY handoff is written but not import-ready', () => {
  const document = buildHandoff({ asset_id: 'asset-wait', status: 'PROCESSING_IMPORT' });
  assert.equal(document.import_ready, false);
});

test('CAD details map onto plugin generation_type', () => {
  assert.equal(inferGenerationType({ type: 'cadtosimready' }), 'cadtosim');
  assert.deepEqual(detailsFields({
    name: 'Gripper',
    type: 'cadtosimready',
    workspaceId: 'ws-1',
    parameters: { engine: 'isaac_sim' }
  }), {
    name: 'Gripper',
    workspace_id: 'ws-1',
    engine: ['isaac_sim'],
    generation_type: 'cadtosim',
    source: 'cad'
  });
});

test('handoff file round-trips through an atomic write', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'palatial-handoff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'palatial-handoff.json');
  const payload = buildHandoff({ asset_id: 'asset-file', status: 'READY' });
  assert.equal(await writeHandoffFile(payload, file), file);
  assert.deepEqual(await readHandoffFile(file), payload);
  assert.match(await readFile(file, 'utf8'), /palatial\.isaac\.handoff\/v1/);
});

test('default handoff path is ~/.palatial/palatial-handoff.json, not cwd', () => {
  const home = path.join(tmpdir(), 'palatial-home');
  const file = wellKnownHandoffPath({ HOME: home, USERPROFILE: home });
  assert.equal(file, path.join(home, '.palatial', 'palatial-handoff.json'));
  assert.notEqual(path.dirname(file), process.cwd());
  assert.equal(defaultHandoffPath({ HOME: home, USERPROFILE: home }), file);
});

test('resolveHandoffPath uses PALATIAL_HANDOFF_PATH and rejects non-JSON paths', () => {
  const file = resolveHandoffPath(undefined, { PALATIAL_HANDOFF_PATH: 'assets/current.json' });
  assert.equal(path.basename(file), 'current.json');
  assert.throws(() => resolveHandoffPath('assets/'), /must be a \.json file/);
});

test('writeIsaacHandoff polls status, does not export, and writes the contract file', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'palatial-handoff-client-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const client = new PalatialClient({
    apiKey: 'unit-test-key-never-log',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init?.method || 'GET' });
      if (String(url).endsWith('/status')) return json({ status: 'READY', progress: 100 });
      if (String(url).includes('/media/')) return json({ error: 'export must not run' }, 500);
      return json({ id: 'asset-1', name: 'Tote', type: 'imagetosimready', parameters: { engine: ['isaac_sim'] } });
    },
    receiptDir: path.join(dir, 'requests')
  });
  const file = path.join(dir, 'palatial-handoff.json');
  const result = await client.writeIsaacHandoff('asset-1', file);
  assert.equal(result.import_ready, true);
  assert.equal(result.generation_type, 'imagetosim');
  assert.equal(result.handoff_file, file);
  assert.equal((await readHandoffFile(file)).asset_id, 'asset-1');
  assert.equal(calls.some(item => item.url.includes('/media/')), false);
  assert.match(result.message, /Do not download/);
});

test('create and READY status point coding agents at the Isaac handoff tool', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'palatial-handoff-guide-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const client = new PalatialClient({
    apiKey: 'unit-test-key-never-log',
    fetchImpl: async (url, init) => init?.method === 'POST'
      ? json({ id: 'asset-guide', status: { status: 'SUBMITTED' } }, 201)
      : json({ status: 'READY' }),
    receiptDir: path.join(dir, 'requests')
  });
  const created = await client.create({ source: 'text', name: 'Test bin', description: 'Rigid storage bin' });
  assert.equal(created.isaac_plugin.viewer_url, isaacPluginGuidance('asset-guide', 'https://dashboard.palatial.cloud').viewer_url);
  assert.match(created.isaac_plugin.write_handoff, /palatial_write_isaac_handoff/);
  assert.match(created.isaac_plugin.write_handoff, /Do not palatial_download_asset/);
  const ready = await client.getAsset('asset-guide');
  assert.match(ready.isaac_plugin.write_handoff, /READY/);
});

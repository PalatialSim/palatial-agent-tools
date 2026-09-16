// Run through isolated-release.Dockerfile. The application is installed from
// the public GitHub release, never imported from this repository's source.
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const bin = '/app/node_modules/@palatial/agent-tools/bin/palatial-agent.js';
const fixtureKey = 'isolated-fixture-only-not-a-real-key';
const scratch = await mkdtemp(path.join(tmpdir(), 'palatial-isolated-'));
const zip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
const evidence = { environment: 'fresh Node.js 22 Docker container', application_source: 'public v0.1.0 release tarball; SHA-256 verified in image build', runtime_network: 'none; loopback HTTPS fixtures only', real_palatial_api_calls: 0, paid_generations: 0, results: {} };
let apiServer, storageServer, client;
let apiCalls = 0, exportCalls = 0, failedCreates = 0;
const submitted = [], jobs = new Map();
const listen = server => new Promise(resolve => server.listen(0, '0.0.0.0', () => resolve(server.address().port)));
const connect = async env => {
  const c = new Client({ name: 'isolated-release-test', version: '1.0' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp'], env: { PATH: process.env.PATH, XDG_CONFIG_HOME: path.join(scratch, 'config'), PALATIAL_STATE_DIR: path.join(scratch, 'state'), PALATIAL_API_KEY: '', ...env }, stderr: 'pipe' }));
  return c;
};
try {
  const version = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0); assert.equal(version.stdout.trim(), '0.1.0');
  client = await connect({});
  assert.equal((await client.listTools()).tools.length, 11);
  const unauth = await client.callTool({ name: 'palatial_doctor', arguments: {} });
  assert.equal(unauth.isError, true);
  assert.match(unauth.content[0].text, /not authenticated/);
  await client.close(); client = undefined;
  evidence.results.clean_install_and_unauthenticated_discovery = 'passed';

  const cert = path.join(scratch, 'localhost.crt'), key = path.join(scratch, 'localhost.key');
  const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
  assert.equal(openssl.status, 0, openssl.stderr);
  const tls = { key: await readFile(key), cert: await readFile(cert) };
  let storageAuthLeaked = false;
  storageServer = https.createServer(tls, (req, res) => {
    if (req.headers['x-api-key'] || req.headers.authorization) storageAuthLeaked = true;
    res.writeHead(200, { 'Content-Type': 'application/zip' }); res.end(zip);
  });
  const storagePort = await listen(storageServer);
  apiServer = https.createServer(tls, async (req, res) => {
    const reply = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      apiCalls++;
      if (req.headers['x-api-key'] !== fixtureKey) return reply({ error: 'fixture auth rejected' }, 403);
      if (req.url.endsWith('/workspaces')) return reply([{ id: 'fixture-workspace' }]);
      if (req.method === 'POST' && req.url.includes('/assets/create/')) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        let fields;
        if (req.headers['content-type'].includes('multipart/form-data')) {
          const request = new Request('https://localhost' + req.url, { method: 'POST', headers: req.headers, body });
          const form = await request.formData();
          fields = { name: form.get('name'), engines: form.getAll('engine'), files: {} };
          for (const [name, value] of form.entries()) if (typeof value !== 'string') fields.files[name] = { name: value.name, bytes: value.size };
        } else fields = JSON.parse(body);
        if (fields.name === 'Fail fixture') { failedCreates++; return reply({ error: 'temporary fixture failure' }, 503); }
        const id = 'fixture-' + (submitted.length + 1);
        submitted.push({ id, route: req.url, fields }); jobs.set(id, { reads: 0, canceled: false });
        return reply({ id, status: { status: 'SUBMITTED' } }, 201);
      }
      const id = req.url.split('/assets/')[1]?.split('/')[0];
      const job = jobs.get(id);
      if (!job) return reply({ error: 'fixture asset not found' }, 404);
      if (req.url.endsWith('/cancel-processing')) { job.canceled = true; return reply({ success: true }); }
      if (req.url.endsWith('/status')) return reply({ status: job.canceled ? 'PROCESSING_CANCELED' : ++job.reads > 1 ? 'READY' : 'PROCESSING_IMPORT' });
      if (req.url.endsWith('/media/export')) {
        exportCalls++;
        res.writeHead(307, { Location: `https://127.0.0.1:${storagePort}/fixture.zip?signature=fixture` }); res.end(); return;
      }
      reply({ error: 'unknown fixture route' }, 404);
    } catch (error) { reply({ error: error.message }, 500); }
  });
  const apiPort = await listen(apiServer);
  client = await connect({ PALATIAL_API_KEY: fixtureKey, PALATIAL_API_URL: `https://localhost:${apiPort}/api/v1/external/`, NODE_EXTRA_CA_CERTS: cert });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    return result.structuredContent;
  };
  assert.equal((await call('palatial_doctor')).authenticated, true);
  const image = path.join(scratch, 'bin.jpg'), mesh = path.join(scratch, 'bin.step');
  await writeFile(image, 'fixture-reference'); await writeFile(mesh, 'fixture-CAD');
  const inputs = [
    { source: 'text', name: 'Text fixture', description: 'Rigid bin' },
    { source: 'image', name: 'Image fixture', description: 'Rigid bin', image_path: image },
    { source: 'image', name: 'Views fixture', description: 'Rigid bin', views: { front: image, back: image }, engine: ['isaac_sim', 'mujoco'] },
    { source: 'cad', name: 'CAD fixture', description: 'Rigid bin', image_path: image, mesh_path: mesh, units: 'mm' }
  ];
  for (const input of inputs) {
    const created = await call('palatial_create_asset', input);
    assert.ok((await readFile(created.receipt_file, 'utf8')).includes(created.asset_id));
    assert.equal((await call('palatial_get_asset', { asset_id: created.asset_id })).status, 'PROCESSING_IMPORT');
    assert.equal((await call('palatial_get_asset', { asset_id: created.asset_id })).status, 'READY');
  }
  assert.deepEqual(submitted[2].fields.engines, ['isaac_sim', 'mujoco']);
  assert.deepEqual(Object.keys(submitted[2].fields.files).sort(), ['back', 'front']);
  assert.equal(submitted[3].fields.files.mesh.bytes, Buffer.byteLength('fixture-CAD'));
  evidence.results.text_image_multiview_and_cad_over_https = 'passed';
  const args = { asset_id: submitted[0].id, output_dir: path.join(scratch, 'exports') };
  const downloaded = await call('palatial_download_asset', args);
  assert.equal(downloaded.bytes, zip.length); assert.equal(downloaded.sha256.length, 64);
  assert.deepEqual(await readFile(downloaded.file), zip);
  const again = await call('palatial_download_asset', args);
  assert.equal(again.cached, true); assert.equal(exportCalls, 1); assert.equal(storageAuthLeaked, false);
  evidence.results.redirect_credential_isolation_and_cached_export = 'passed';

  await client.close(); client = await connect({ PALATIAL_API_KEY: fixtureKey, PALATIAL_API_URL: `https://localhost:${apiPort}/api/v1/external/`, NODE_EXTRA_CA_CERTS: cert });
  assert.equal((await call('palatial_get_asset', { asset_id: submitted[0].id })).status, 'READY');
  assert.equal(submitted.length, 4);
  const failure = await client.callTool({ name: 'palatial_create_asset', arguments: { source: 'text', name: 'Fail fixture', description: 'Simulated failed request' } });
  assert.equal(failure.isError, true); assert.equal(failedCreates, 1);
  assert.match(failure.content[0].text, /uncertain/);
  assert.equal((await call('palatial_cancel_asset', { asset_id: submitted[1].id })).success, true);
  assert.equal((await call('palatial_get_asset', { asset_id: submitted[1].id })).status, 'PROCESSING_CANCELED');
  evidence.results.session_resume_ambiguous_failure_and_cancellation = 'passed';
  evidence.fixture_api_calls = apiCalls;
  evidence.fixture_generations = submitted.length;
  evidence.fixture_export_authorizations = exportCalls;
  evidence.simulator_acceptance = 'not_tested';
  evidence.overall = 'passed';
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (client) await client.close();
  if (apiServer) await new Promise(resolve => apiServer.close(resolve));
  if (storageServer) await new Promise(resolve => storageServer.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}

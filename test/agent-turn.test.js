import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PalatialClient } from '../src/client.js';
import { submitAgentTurn, hostTimeoutMs, AGENT_TURN_MAX_SENDS } from '../src/agent-turn.js';
import { submitAgentWithFiles } from '../src/agent-sources.js';

// A fake client clock and transport. Each answer receives the send options and may advance time.
function harness({ host = 600_000, margin = 10_000, answers }) {
  let time = 0;
  const calls = [], waits = [];
  const client = {
    hostTimeoutMs: host, hostMarginMs: margin, timeoutMs: 30_000, now: () => time,
    sleep: async ms => { waits.push(ms); time += ms; },
    async request(route, options) {
      calls.push({ route, at: time, ...options });
      const answer = answers.shift();
      assert.ok(answer, 'unexpected extra send');
      return answer({ options, advance: ms => { time += ms; } });
    }
  };
  return { client, calls, waits, advance: ms => { time += ms; }, time: () => time };
}
const ok = (body = { id: 'turn-1', status: 'running', statusUrl: '/api/v1/external/agent/turn-1', replayed: false }) => () => body;
const httpError = (status, code, retryAfter) => () => {
  throw Object.assign(new Error(`HTTP ${status}`), { http_status: status, ...(code ? { code } : {}), ...(retryAfter ? { retryAfter } : {}) });
};
const hang = ({ options, advance }) => { advance(options.timeoutMs); throw Object.assign(new Error('timed out'), { transport: true }); };
const turn = (client, input = { requestId: 'r-1', message: 'Build it.' }) => submitAgentTurn(client, input);
const unknown = (id, extra = () => true) => error => error.code === 'AGENT_TURN_OUTCOME_UNKNOWN' && error.request_id === id && extra(error);

test('a host limit is a positive whole number of milliseconds, and none leaves recovery off', () => {
  assert.equal(hostTimeoutMs(undefined), undefined);
  assert.equal(hostTimeoutMs(''), undefined);
  assert.equal(hostTimeoutMs('600000'), 600_000);
  for (const bad of ['0', '-1', '1.5', 'ten']) assert.throws(() => hostTimeoutMs(bad), /PALATIAL_HOST_TIMEOUT_MS/);
});

test('response-header hangs: each attempt is capped by the remaining window and no send starts after the deadline', async () => {
  const h = harness({ host: 60_000, answers: [hang, hang, hang] });
  await assert.rejects(turn(h.client), unknown('r-1', error => error.turn_sends === 2));
  assert.deepEqual(h.calls.map(call => call.timeoutMs), [30_000, 19_000]);
  assert.deepEqual(h.waits, [1_000]);
  for (const call of h.calls) assert.ok(call.at < 50_000);
  assert.equal(h.time(), 50_000);
});

test('mixed gateway failures stop at the four-send ceiling with identical frozen JSON', async () => {
  const h = harness({ answers: [httpError(502), httpError(503), httpError(504), hang, ok()] });
  await assert.rejects(turn(h.client), unknown('r-1', error => error.turn_sends === AGENT_TURN_MAX_SENDS && error.last_http_status === undefined));
  assert.equal(h.calls.length, AGENT_TURN_MAX_SENDS);
  assert.equal(new Set(h.calls.map(call => call.json)).size, 1);
  assert.equal(new Set(h.calls.map(call => call.route)).size, 1);
  assert.deepEqual(JSON.parse(h.calls[0].json), { requestId: 'r-1', message: 'Build it.' });
  assert.deepEqual(h.waits, [1_000, 2_000, 4_000]);
});

test('JSON → typed 503 → JSON → plain 502 → JSON → receipt uses three sends and honors Retry-After', async () => {
  const receipt = { id: 'turn-9', status: 'running', statusUrl: '/api/v1/external/agent/turn-9', replayed: true };
  const h = harness({ answers: [httpError(503, 'RUN_RETRY_STARTING', '3'), httpError(502), ok(receipt)] });
  assert.deepEqual(await turn(h.client), { ...receipt, request_id: 'r-1' });
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.waits, [3_000, 2_000]);
});

test('a long Retry-After that leaves no useful send window ends the call with the unknown outcome', async () => {
  const h = harness({ host: 40_000, answers: [httpError(503, 'RUN_RETRY_STARTING', '120')] });
  await assert.rejects(turn(h.client), unknown('r-1', error => error.last_http_status === 503 && error.last_code === 'RUN_RETRY_STARTING'));
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.waits, []);
});

test('without a verified host limit a caller ID is sent once and a gateway error returns the unknown outcome', async () => {
  const h = harness({ host: null, answers: [httpError(502)] });
  await assert.rejects(turn(h.client), unknown('r-1', error => error.retryable === true && /same API key and identical inputs/.test(error.message)));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].timeoutMs, 30_000);
});

test('an omitted-ID call sends once even inside a host window and returns its generated ID', async () => {
  const h = harness({ answers: [hang] });
  let id;
  await assert.rejects(turn(h.client, { message: 'Build it.' }), error => { id = error.request_id; return error.code === 'AGENT_TURN_OUTCOME_UNKNOWN'; });
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.parse(h.calls[0].json).requestId, id);
  const fresh = harness({ answers: [ok()] });
  const result = await turn(fresh.client, { message: 'Build it.' });
  assert.equal(result.request_id, JSON.parse(fresh.calls[0].json).requestId);
});

test('500 and a malformed success receipt are unknown outcomes and are not replayed', async () => {
  for (const answer of [httpError(500), ok({ status: 'running' }), ok({ id: '../bad' })]) {
    const h = harness({ answers: [answer] });
    await assert.rejects(turn(h.client), unknown('r-1'));
    assert.equal(h.calls.length, 1);
  }
});

test('a first refusal keeps its status and code and says it does not settle earlier sends under a caller ID', async () => {
  for (const [status, code] of [[429, 'RATE_LIMITED'], [403, 'ACCESS_DENIED']]) {
    const h = harness({ answers: [httpError(status, code)] });
    await assert.rejects(turn(h.client), error => {
      assert.equal(error.http_status, status);
      assert.equal(error.code, code);
      assert.equal(error.request_id, 'r-1');
      assert.equal(error.toJSON().earlier_outcome, 'unresolved');
      assert.match(error.message, /does not settle any earlier submission under request_id r-1/);
      return true;
    });
    assert.equal(h.calls.length, 1);
  }
  const generated = harness({ answers: [httpError(429)] });
  await assert.rejects(turn(generated.client, { message: 'Build it.' }), error => error.http_status === 429 && typeof error.request_id === 'string' && error.earlier_outcome === undefined);
});

test('REQUEST_ID_CONFLICT keeps its binding meaning and directs recovery to the original inputs', async () => {
  const h = harness({ answers: [httpError(409, 'REQUEST_ID_CONFLICT')] });
  await assert.rejects(turn(h.client), error => error.code === 'REQUEST_ID_CONFLICT' && error.request_id === 'r-1' && /already bound to different inputs.*original inputs/.test(error.message));
  assert.equal(h.calls.length, 1);
});

test('a refusal after an ambiguous send in the same call is an unknown outcome and is not retried', async () => {
  for (const status of [409, 429]) {
    const h = harness({ answers: [httpError(502), httpError(status, 'X')] });
    await assert.rejects(turn(h.client), unknown('r-1', error => error.last_http_status === status && error.last_code === 'X' && error.turn_sends === 2));
    assert.equal(h.calls.length, 2);
  }
});

test('unknown in one call, then 429 for the same ID in the next: the 429 is returned once with the ID and unresolved guidance', async () => {
  const h = harness({ answers: [hang, hang, hang, hang] });
  await assert.rejects(turn(h.client), unknown('r-1'));
  const before = h.calls.length;
  const next = harness({ answers: [httpError(429, 'RATE_LIMITED')] });
  await assert.rejects(turn(next.client), error => error.http_status === 429 && error.code === 'RATE_LIMITED' && error.request_id === 'r-1' && error.earlier_outcome === 'unresolved');
  assert.equal(next.calls.length, 1);
  assert.ok(before >= 1);
});

test('a confirmed failed turn is returned as received, never replaced', async () => {
  const failed = { id: 'turn-1', status: 'failed', replayed: true };
  const h = harness({ answers: [ok(failed)] });
  assert.deepEqual(await turn(h.client), { ...failed, request_id: 'r-1' });
  assert.equal(h.calls.length, 1);
});

test('PalatialClient replays an audited Agent turn byte for byte through real responses', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'palatial-turn-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bodies = [];
  const answers = [
    new Response(JSON.stringify({ code: 'RUN_RETRY_STARTING' }), { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '2' } }),
    Response.json({ id: 'turn-1', replayed: true }, { status: 202 })
  ];
  const waits = [];
  const client = new PalatialClient({ apiKey: 'fixture-key', receiptDir: dir, hostTimeoutMs: 600_000, sleep: async ms => { waits.push(ms); }, fetchImpl: async (url, init) => {
    bodies.push({ path: new URL(url).pathname, body: init.body, type: init.headers['Content-Type'] });
    return answers.shift();
  } });
  const result = await client.startAgentTurn({ requestId: 'r-1', assetId: 'asset-1', message: 'Make it taller.' });
  assert.equal(result.request_id, 'r-1');
  assert.deepEqual(waits, [2_000]);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].body, bodies[1].body);
  assert.equal(bodies[0].path, '/api/v1/external/assets/asset-1/agent');
  assert.equal(bodies[0].type, 'application/json');
});

// File calls: preparation and streaming keep their own timers and never consume the turn phase.
async function fileFixture(t, { size = 16 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'palatial-turn-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'bin.png');
  if (size > 1024 ** 2) { const handle = await open(filename, 'w'); await handle.truncate(size); await handle.close(); }
  else await writeFile(filename, Buffer.alloc(size, 7));
  let time = 0;
  const sends = [], other = [];
  const client = {
    base: new URL('https://dashboard.dev.palatial.cloud/api/v1/external/'), apiKey: 'fixture-key',
    receiptDir: path.join(directory, 'receipts'), hostTimeoutMs: 600_000, timeoutMs: 30_000,
    now: () => time, sleep: async ms => { time += ms; }, answers: [],
    async request(route, options) {
      if (route === 'agent' || /^assets\/[^/]+\/agent$/.test(route)) {
        if (options.uploadBody) {
          for await (const _chunk of options.uploadBody.body) time += client.streamMs ?? 0;
          options.uploadBody.onStreamEnd?.();
        }
        sends.push({ kind: options.uploadBody ? 'multipart' : 'json', at: time, timeoutMs: options.timeoutMs });
        const answer = client.answers.shift();
        assert.ok(answer, 'unexpected extra turn send');
        return answer();
      }
      other.push(route);
      if (route === 'agent/sources') return { assetId: '333333333333333333333333' };
      if (route.endsWith('/init')) { time += client.uploadMs ?? 0; return { key: 'uploads/projects/333333333333333333333333/uploads/x', uploadId: 'u', completionToken: 'c' }; }
      if (route.endsWith('/sign-parts')) return { signedUrls: [`https://${'a'.repeat(32)}.r2.cloudflarestorage.com/b/p`] };
      return { attachment: { name: 'bin.png', kind: 'image', bytesInAsset: true } };
    },
    async fetch(_url, options) { for await (const _chunk of options.body); return new Response('', { headers: { etag: 'e' } }); }
  };
  return { client, filename, sends, other, advance: ms => { time += ms; } };
}
const lost = () => { throw Object.assign(new Error('response lost'), { transport: true }); };

test('a spent host window still allows the first foreground file send once, with no recovery after it', async t => {
  const f = await fileFixture(t);
  f.client.answers = [lost];
  // Slow hashing or host time already spent before the turn: tool entry is long past.
  await assert.rejects(submitAgentWithFiles(f.client, { requestId: 'spent', message: 'Build it.', files: [f.filename] }, { startedAt: -1_000_000 }), unknown('spent', error => error.turn_sends === 1));
  assert.deepEqual(f.sends.map(send => send.kind), ['multipart']);
});

test('a long progressing multipart stream counts one send and its streaming time is not turn-phase time', async t => {
  const f = await fileFixture(t);
  f.client.streamMs = 100_000; // two chunks: 200 s of progress, beyond the 120 s turn phase
  f.client.answers = [lost, () => ({ id: 'turn-1', replayed: true })];
  const result = await submitAgentWithFiles(f.client, { requestId: 'slow', message: 'Build it.', files: [f.filename] });
  assert.equal(result.replayed, true);
  assert.deepEqual(f.sends.map(send => send.kind), ['multipart', 'json']);
});

test('multipart → manifest 503 → manifest missing bytes → multipart uses four sends and never a fifth', async t => {
  const f = await fileFixture(t);
  const missing = () => { throw Object.assign(new Error('bytes required'), { http_status: 400, code: 'AGENT_SOURCE_BYTES_REQUIRED' }); };
  f.client.answers = [lost, () => { throw Object.assign(new Error('unavailable'), { http_status: 503 }); }, missing, lost];
  await assert.rejects(submitAgentWithFiles(f.client, { requestId: 'four', message: 'Build it.', files: [f.filename] }), unknown('four', error => error.turn_sends === 4));
  assert.deepEqual(f.sends.map(send => send.kind), ['multipart', 'json', 'json', 'multipart']);
});

test('a saved manifest that needs bytes keeps its send, and the final submit after slow resumable preparation still goes once', async t => {
  const f = await fileFixture(t, { size: 64 * 1024 ** 2 + 1 });
  f.client.answers = [() => { throw Object.assign(new Error('response lost'), { transport: true }); }];
  // First call: parts are reserved and uploaded; the final JSON turn's response is lost.
  await assert.rejects(submitAgentWithFiles(f.client, { requestId: 'parts', message: 'Build it.', files: [f.filename] }, { startedAt: -1_000_000 }), unknown('parts'));
  assert.deepEqual(f.sends.map(send => send.kind), ['json']);
  // Next call: the saved manifest is probed first and the receipt returns.
  f.client.answers = [() => ({ id: 'turn-p', replayed: true })];
  assert.equal((await submitAgentWithFiles(f.client, { requestId: 'parts', message: 'Build it.', files: [f.filename] })).id, 'turn-p');
  assert.equal(f.sends.length, 2);
});

test('after a saved manifest reports missing bytes, resumable preparation beyond the host window still allows the final submit', async t => {
  const f = await fileFixture(t, { size: 64 * 1024 ** 2 + 1 });
  const missing = () => { throw Object.assign(new Error('bytes required'), { http_status: 400, code: 'AGENT_SOURCE_BYTES_REQUIRED' }); };
  // Seed a saved receipt whose upload never finished: the first call fails during part reservation.
  const reserve = f.client.request;
  f.client.request = async (route, options) => {
    if (route.endsWith('/init')) throw new Error('storage unavailable');
    return reserve(route, options);
  };
  await assert.rejects(submitAgentWithFiles(f.client, { requestId: 'resume', message: 'Build it.', files: [f.filename] }), error => error.request_id === 'resume');
  assert.equal(f.sends.length, 0);
  f.client.request = reserve;
  f.client.uploadMs = 1_000_000; // part transfer outlasts the host window
  f.client.answers = [missing, () => ({ id: 'turn-r' })];
  const result = await submitAgentWithFiles(f.client, { requestId: 'resume', message: 'Build it.', files: [f.filename] });
  assert.equal(result.id, 'turn-r');
  assert.deepEqual(f.sends.map(send => send.kind), ['json', 'json']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { progressUpload } from '../src/upload-progress.js';
import { PalatialClient } from '../src/client.js';

test('progressing upload survives 30 seconds and switches to response deadline after the last chunk', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transfer = progressUpload((async function* () { yield Buffer.from('a'); yield Buffer.from('b'); yield Buffer.from('c'); })());
  t.after(transfer.close);
  const iterator = transfer.body[Symbol.asyncIterator]();
  await iterator.next();
  t.mock.timers.tick(20000);
  await iterator.next();
  t.mock.timers.tick(20000);
  assert.equal(transfer.signal.aborted, false);
  await iterator.next();
  assert.equal((await iterator.next()).done, true);
  t.mock.timers.tick(119999);
  assert.equal(transfer.signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(transfer.signal.aborted, true);
});

test('stalled upload aborts after one minute without progress', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transfer = progressUpload((async function* () { yield Buffer.from('a'); })());
  t.after(transfer.close);
  t.mock.timers.tick(59999);
  assert.equal(transfer.signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(transfer.signal.aborted, true);
});

test('client uses the streaming deadline and duplex while preserving default small request timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new PalatialClient({ apiKey: 'fixture-key', fetchImpl: async (_url, init) => {
    assert.equal(init.duplex, 'half');
    assert.equal(init.headers['Content-Length'], '3');
    const received = [];
    for await (const chunk of init.body) {
      received.push(chunk);
      t.mock.timers.tick(20000);
      assert.equal(init.signal.aborted, false);
    }
    assert.equal(Buffer.concat(received).toString(), 'abc');
    return Response.json({ id: 'same-turn' }, { status: 202 });
  } });
  assert.deepEqual(await client.request('agent', { method: 'POST', uploadBody: {
    contentType: 'multipart/form-data; boundary=test', length: 3,
    body: (async function* () { for (const value of ['a', 'b', 'c']) yield Buffer.from(value); })()
  } }), { id: 'same-turn' });
  assert.equal(client.timeoutMs, 30000);
});

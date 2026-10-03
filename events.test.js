'use strict';

// Event delivery against a local receiver: no network beyond localhost.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOutbox, buildEvent, sign, BACKOFF_MS } = require('./events.js');
const { createServer, jobStore, validSignature } = require('./server.js');
const { loadConfig } = require('./config.js');

const SECRET = 'test-secret';

/** A receiver answering from `statuses` in turn (the last one repeats). */
async function receiver(t, statuses) {
  const got = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      got.push({ path: req.url, headers: req.headers, body: body.toString() });
      const status = statuses[Math.min(got.length - 1, statuses.length - 1)];
      res.writeHead(status, status === 302 ? { location: '/elsewhere' } : {});
      res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { got, url: `http://127.0.0.1:${srv.address().port}/events` };
}

function setup(t, callbackUrl) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-ev-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = jobStore(dataDir);
  const job = {
    id: 'job1',
    url: 'https://meet.google.com/abc-defg-hij',
    callback_url: callbackUrl,
    meta: { k: [1] },
    state: 'finished',
    error: null,
    started_at: '2026-01-01T10:00:00.000Z',
    ended_at: '2026-01-01T10:30:00.000Z',
    duration_s: 1800,
    reason: 'ended',
    participants: ['Alice'],
    artifacts: [{ kind: 'audio', path: '/data/meet/job1/audio.wav', format: 'wav' }],
    delivered: {},
  };
  fs.mkdirSync(store.dir(job.id));
  store.save(job);
  const outbox = (backoff = [5]) => createOutbox({ secret: SECRET, dataDir, store, log: () => {}, backoff });
  const pending = () => fs.readdirSync(path.join(dataDir, 'job1', 'outbox'));
  return { job, store, outbox, pending };
}

test('event bodies follow the contract', () => {
  const job = { id: 'a', url: 'u', meta: { m: 1 }, error: 'not_admitted', artifacts: [], started_at: 's', ended_at: 'e', duration_s: 1, reason: 'removed', participants: [] };
  assert.deepStrictEqual(buildEvent(job, 'recording.started', 'T'), { event: 'recording.started', id: 'a', source: 'meet', url: 'u', meta: { m: 1 }, at: 'T' });
  assert.deepStrictEqual(buildEvent(job, 'recording.failed', 'T'), { event: 'recording.failed', id: 'a', source: 'meet', url: 'u', meta: { m: 1 }, at: 'T', error: 'not_admitted' });
  const art = [{ kind: 'audio' }];
  assert.deepStrictEqual(buildEvent({ ...job, error: 'recorder_failed', artifacts: art }, 'recording.failed', 'T').artifacts, art);
  const f = buildEvent(job, 'recording.finished', 'T');
  assert.deepStrictEqual([f.reason, f.started_at, f.ended_at, f.duration_s, f.participants, f.artifacts], ['removed', 's', 'e', 1, [], []]);
  assert.deepStrictEqual(BACKOFF_MS, [5e3, 15e3, 45e3, 120e3, 300e3]);
});

test('signed delivery, retried after a 500, removed from the outbox and recorded', async (t) => {
  const r = await receiver(t, [500, 200]);
  const { job, store, outbox, pending } = setup(t, r.url);
  const p = outbox().emit(job, 'recording.finished');
  assert.deepStrictEqual(pending(), ['recording.finished.json'], 'written before the first attempt');
  await p;
  assert.strictEqual(r.got.length, 2);
  for (const g of r.got) {
    assert.strictEqual(g.headers['x-recorder-event'], 'recording.finished');
    assert.ok(validSignature(SECRET, Buffer.from(g.body), g.headers['x-recorder-signature']));
  }
  assert.strictEqual(r.got[0].body, r.got[1].body, 'a retry resends the same body');
  const body = JSON.parse(r.got[1].body);
  assert.deepStrictEqual([body.event, body.id, body.source, body.reason, body.meta], ['recording.finished', 'job1', 'meet', 'ended', { k: [1] }]);
  assert.deepStrictEqual(pending(), []);
  assert.ok(store.load('job1').delivered['recording.finished']);
});

test('the outbox survives a restart and is redelivered', async (t) => {
  const down = await receiver(t, [503]);
  const { job, store, outbox, pending } = setup(t, down.url);
  await outbox([]).emit(job, 'recording.failed');
  assert.strictEqual(down.got.length, 1);
  assert.deepStrictEqual(pending(), ['recording.failed.json']);
  assert.deepStrictEqual(store.load('job1').delivered, {});

  // A new process: the stored callback_url now answers.
  const up = await receiver(t, [200]);
  const stored = path.join(store.dir('job1'), 'outbox', 'recording.failed.json');
  const entry = JSON.parse(fs.readFileSync(stored, 'utf8'));
  fs.writeFileSync(stored, JSON.stringify({ ...entry, callback_url: up.url }));
  await outbox().sweep();
  assert.strictEqual(up.got.length, 1);
  assert.strictEqual(up.got[0].body, entry.body, 'the same event, not a rebuilt one');
  assert.deepStrictEqual(pending(), []);
  assert.ok(store.load('job1').delivered['recording.failed']);
});

test('a redirect is not followed and is not a delivery', async (t) => {
  const r = await receiver(t, [302]);
  const { job, outbox, pending } = setup(t, r.url);
  await outbox([1]).emit(job, 'recording.finished');
  assert.deepStrictEqual(r.got.map((g) => g.path), ['/events', '/events']);
  assert.deepStrictEqual(pending(), ['recording.finished.json']);
});

test('best-effort events: one attempt, no outbox', async (t) => {
  const r = await receiver(t, [500, 200]);
  const { job, store, outbox } = setup(t, r.url);
  const o = outbox();
  await o.emit(job, 'recording.waiting_admission');
  await o.emit(job, 'recording.started');
  assert.deepStrictEqual(r.got.map((g) => g.headers['x-recorder-event']), ['recording.waiting_admission', 'recording.started']);
  assert.ok(!fs.existsSync(path.join(store.dir('job1'), 'outbox')));
  assert.deepStrictEqual(Object.keys(store.load('job1').delivered), ['recording.started']);
});

test('delivery errors never log the callback URL', async (t) => {
  const { job, store } = setup(t, 'http://user:hunter2@127.0.0.1:1/events?token=private');
  const logs = [];
  const o = createOutbox({ secret: SECRET, dataDir: path.dirname(store.dir('x')), store, log: (m) => logs.push(m), backoff: [] });
  await o.emit(job, 'recording.started');
  await o.emit({ ...job, callback_url: 'http://127.0.0.1:1/events?token=private' }, 'recording.failed');
  assert.strictEqual(logs.length, 2);
  assert.ok(!logs.join('\n').match(/hunter2|private/), logs.join('\n'));
});

test('the server delivers through its outbox by default', async (t) => {
  const r = await receiver(t, [200]);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-ev-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let finish;
  const record = () => new Promise((resolve) => (finish = resolve));
  const config = loadConfig({ RECORDER_SECRET: SECRET, DATA_DIR: dataDir });
  const srv = createServer({ config, record, log: () => {} });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  t.after(() => srv.close());
  const raw = JSON.stringify({ id: 'j', url: 'https://meet.google.com/abc-defg-hij', callback_url: r.url });
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/recordings`, { method: 'POST', body: raw, headers: { 'x-recorder-signature': sign(SECRET, raw) } });
  assert.strictEqual(res.status, 202);
  finish({ durationS: 1, reason: 'ended', participants: [], captions: null });
  for (let i = 0; i < 100 && !jobStore(dataDir).load('j').delivered['recording.finished']; i++) await new Promise((ok) => setTimeout(ok, 10));
  assert.deepStrictEqual(r.got.map((g) => g.headers['x-recorder-event']), ['recording.finished']);
  assert.deepStrictEqual(fs.readdirSync(path.join(dataDir, 'j', 'outbox')), []);
});

'use strict';

// The HTTP API with record() stubbed: no browser, no network beyond localhost.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('./server.js');
const { loadConfig } = require('./config.js');

const SECRET = 'test-secret';
const sign = (body, secret = SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

/** A server on a random port with a controllable record() stub. */
async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-srv-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [];
  const events = [];
  const record = (opts) =>
    new Promise((resolve, reject) => {
      calls.push({ opts, resolve, reject });
    });
  const config = loadConfig({ RECORDER_SECRET: SECRET, DATA_DIR: dataDir });
  const srv = createServer({ config, record, emit: (job, event) => events.push([job.id, event]), log: () => {} });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, body, headers) => {
    const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const res = await fetch(base + p, {
      method,
      body: method === 'POST' ? raw : undefined,
      headers: headers || { 'x-recorder-signature': sign(raw) },
    });
    return { status: res.status, json: await res.json() };
  };
  return { dataDir, calls, events, req };
}

const ok = (over) => ({ id: 'job1', url: 'https://meet.google.com/abc-defg-hij', callback_url: 'http://bot:8080/events', meta: { k: [1] }, ...over });
const tick = () => new Promise((r) => setImmediate(r));

test('config: RECORDER_SECRET is required, defaults apply', () => {
  assert.throws(() => loadConfig({}), /RECORDER_SECRET is required/);
  assert.throws(() => loadConfig({ RECORDER_SECRET: '' }), /RECORDER_SECRET/);
  assert.throws(() => loadConfig({ RECORDER_SECRET: 's', PORT: 'x' }), /^Error: PORT must/);
  const c = loadConfig({ RECORDER_SECRET: 's' });
  assert.deepStrictEqual([c.dataDir, c.port, c.displayName, c.joinTimeoutS, c.maxDurationS, c.emptyGraceS], ['/data/meet', 8080, 'NoteTaker', 1200, 14400, 60]);
});

test('/health is unsigned', async (t) => {
  const { req } = await setup(t);
  assert.deepStrictEqual(await req('GET', '/health', undefined, {}), { status: 200, json: { status: 'ok' } });
});

test('signature: missing, wrong and bad-format are 401; good passes', async (t) => {
  const { req, calls } = await setup(t);
  const body = JSON.stringify(ok());
  assert.strictEqual((await req('POST', '/recordings', body, {})).status, 401);
  assert.strictEqual((await req('POST', '/recordings', body, { 'x-recorder-signature': sign(body, 'other') })).status, 401);
  assert.strictEqual((await req('POST', '/recordings', body, { 'x-recorder-signature': 'sha256=abc' })).status, 401);
  assert.strictEqual((await req('POST', '/recordings', body, { 'x-recorder-signature': sign(body + ' ') })).status, 401);
  assert.strictEqual((await req('GET', '/recordings/job1', undefined, {})).status, 401);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual((await req('POST', '/recordings', body)).status, 202);
});

test('validation: bad id, path traversal, bad callback, bad meta are 400; non-Meet URL is 422', async (t) => {
  const { req, calls, dataDir } = await setup(t);
  for (const id of ['', '../etc', 'a/b', 'x'.repeat(65), 42, undefined]) {
    assert.strictEqual((await req('POST', '/recordings', ok({ id }))).status, 400, `id ${id}`);
  }
  assert.strictEqual((await req('POST', '/recordings', 'not json')).status, 400);
  assert.strictEqual((await req('POST', '/recordings', ok({ callback_url: 'file:///etc/passwd' }))).status, 400);
  assert.strictEqual((await req('POST', '/recordings', ok({ meta: [1] }))).status, 400);
  assert.strictEqual((await req('POST', '/recordings', ok({ max_duration_s: -1 }))).status, 400);
  for (const url of [
    'https://example.com/abc-defg-hij',
    'http://meet.google.com/abc-defg-hij',
    'https://meet.google.com.example.com/abc-defg-hij',
    'https://meet.google.com/landing',
    'https://user@meet.google.com/abc-defg-hij',
    'https://meet.google.com/abc-defg-hij/../x',
  ]) {
    assert.strictEqual((await req('POST', '/recordings', ok({ url }))).status, 422, url);
  }
  assert.strictEqual((await req('POST', '/recordings', ok())).status, 202);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(fs.readdirSync(dataDir), ['job1']);
  assert.strictEqual((await req('GET', '/recordings/..%2F..%2Fetc')).status, 404);
});

test('POST keeps only the meeting code; repeat is idempotent; GET returns the record', async (t) => {
  const { req, calls, events, dataDir } = await setup(t);
  assert.deepStrictEqual(await req('GET', '/recordings/job1'), { status: 404, json: { error: 'unknown job' } });
  const r = await req('POST', '/recordings', ok({ url: 'https://meet.google.com/abc-defg-hij?authuser=1&pwd=secret#x', join_timeout_s: 30 }));
  assert.deepStrictEqual(r, { status: 202, json: { id: 'job1', state: 'joining' } });
  assert.strictEqual(calls.length, 1);
  const { opts } = calls[0];
  assert.strictEqual(opts.url, 'https://meet.google.com/abc-defg-hij');
  assert.strictEqual(opts.out, path.join(dataDir, 'job1', 'audio.wav'));
  assert.deepStrictEqual([opts.displayName, opts.joinTimeoutS, opts.maxDurationS, opts.emptyGraceS], ['NoteTaker', 30, 14400, 60]);

  assert.deepStrictEqual(await req('POST', '/recordings', ok({ url: 'https://meet.google.com/zzz-zzzz-zzz' })), { status: 200, json: { id: 'job1', state: 'joining' } });
  assert.strictEqual(calls.length, 1, 'a repeat starts nothing');

  const g = await req('GET', '/recordings/job1');
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.json.url, 'https://meet.google.com/abc-defg-hij');
  assert.deepStrictEqual(g.json.meta, { k: [1] });
  assert.strictEqual(g.json.callback_url, 'http://bot:8080/events');
  assert.ok(!fs.readFileSync(path.join(dataDir, 'job1', 'job.json'), 'utf8').includes('secret'));

  opts.onState('waiting_in_lobby');
  opts.onState('joined');
  assert.strictEqual((await req('GET', '/recordings/job1')).json.state, 'recording');
  fs.writeFileSync(opts.out, Buffer.alloc(100));
  fs.writeFileSync(opts.captionsOut, '{}\n');
  calls[0].resolve({ durationS: 1.5, reason: 'empty_room', participants: ['Alice'], captions: opts.captionsOut });
  await tick();
  const done = (await req('GET', '/recordings/job1')).json;
  assert.strictEqual(done.state, 'finished');
  assert.strictEqual(done.reason, 'empty_room');
  assert.strictEqual(done.duration_s, 1.5);
  assert.deepStrictEqual(done.participants, ['Alice']);
  assert.deepStrictEqual(done.artifacts, [
    { kind: 'audio', path: opts.out, format: 'wav' },
    { kind: 'captions', path: opts.captionsOut },
  ]);
  assert.ok(path.isAbsolute(done.artifacts[0].path));
  assert.deepStrictEqual(events, [
    ['job1', 'recording.waiting_admission'],
    ['job1', 'recording.started'],
    ['job1', 'recording.finished'],
  ]);
});

test('a failed job keeps its partial audio, or reports none', async (t) => {
  const { req, calls, events } = await setup(t);
  await req('POST', '/recordings', ok({ id: 'a' }));
  await req('POST', '/recordings', ok({ id: 'b' }));
  fs.writeFileSync(calls[0].opts.out, Buffer.alloc(1000));
  calls[0].reject(Object.assign(new Error('capture died'), { code: 'recorder_failed', durationS: 0.1 }));
  calls[1].reject(Object.assign(new Error('join timeout'), { code: 'not_admitted' }));
  await tick();
  const a = (await req('GET', '/recordings/a')).json;
  assert.deepStrictEqual([a.state, a.error, a.duration_s], ['failed', 'recorder_failed', 0.1]);
  assert.deepStrictEqual(a.artifacts, [{ kind: 'audio', path: calls[0].opts.out, format: 'wav' }]);
  const b = (await req('GET', '/recordings/b')).json;
  assert.deepStrictEqual([b.state, b.error, b.artifacts], ['failed', 'not_admitted', []]);
  assert.deepStrictEqual(events, [['a', 'recording.failed'], ['b', 'recording.failed']]);
});

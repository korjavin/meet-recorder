'use strict';

// The HTTP API (docs/architecture.md §3): POST /recordings starts record() in
// the background, GET /recordings/{id} returns the job record, GET /health.
// Every job lives in DATA_DIR/<id>/job.json, written atomically.
// Failure handling (§4): server.recover() at startup, server.shutdown() on
// SIGTERM/SIGINT. A hard death of the process takes its Chromium, PulseAudio
// and parec children with it: node is the container's PID 1, so the container
// restart clears them and nothing here hunts orphans.

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { record: realRecord, meetingCode, finalizeWav } = require('./meet.js');
const { createOutbox } = require('./events.js');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY = 1 << 20;
const OPTIONS = { display_name: 'displayName', join_timeout_s: 'joinTimeoutS', max_duration_s: 'maxDurationS', empty_grace_s: 'emptyGraceS' };

const stderrLog = (msg) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`);

/** Constant-time check of `sha256=<hex HMAC-SHA256(body, secret)>`. */
function validSignature(secret, body, header) {
  if (typeof header !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const want = crypto.createHmac('sha256', secret).update(body).digest();
  return crypto.timingSafeEqual(want, Buffer.from(header.slice(7), 'hex'));
}

/** The meeting code of a https://meet.google.com/<xxx-yyyy-zzz> URL, else null. */
function meetCode(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'meet.google.com' || u.port || u.username || u.password) return null;
  const m = u.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/);
  return m ? m[1] : null;
}

function httpUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Validate a POST /recordings body: { job } or { status, error }. */
function parseRequest(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: 'body must be a JSON object' };
  if (typeof body.id !== 'string' || !ID_RE.test(body.id)) return { status: 400, error: 'id must match ^[A-Za-z0-9_-]{1,64}$' };
  if (typeof body.callback_url !== 'string' || !httpUrl(body.callback_url)) return { status: 400, error: 'callback_url must be an http(s) URL' };
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (body.meta !== undefined && !isObj(body.meta)) return { status: 400, error: 'meta must be an object' };
  if (typeof body.url !== 'string') return { status: 400, error: 'url is required' };
  const code = meetCode(body.url);
  if (!code) return { status: 422, error: 'url must be https://meet.google.com/<meeting-code>' };
  const opts = {};
  for (const [k, key] of Object.entries(OPTIONS)) {
    const v = body[k];
    if (v === undefined) {
      opts[k] = config[key];
    } else if (k === 'display_name' ? typeof v !== 'string' || !v.trim() : typeof v !== 'number' || !(v > 0) || !Number.isFinite(v)) {
      return { status: 400, error: `${k} is invalid` };
    } else {
      opts[k] = v;
    }
  }
  return {
    job: {
      id: body.id,
      // Only the meeting code survives: a query string may carry a token.
      url: `https://meet.google.com/${code}`,
      callback_url: body.callback_url,
      meta: body.meta,
      ...opts,
      state: 'joining',
      error: null,
      created_at: new Date().toISOString(),
      started_at: null,
      ended_at: null,
      duration_s: null,
      reason: null,
      participants: [],
      artifacts: [],
      delivered: {}, // event name -> time the receiver answered 2xx
    },
  };
}

/** DATA_DIR/<id>/job.json, written atomically (temp file + rename). */
function jobStore(dataDir) {
  const dir = (id) => path.join(path.resolve(dataDir), id);
  const file = (id) => path.join(dir(id), 'job.json');
  return {
    dir,
    save(job) {
      const tmp = `${file(job.id)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
      fs.renameSync(tmp, file(job.id));
    },
    load(id) {
      try {
        return JSON.parse(fs.readFileSync(file(id), 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
  };
}

const RATE_BYTES = 16000 * 2; // 16 kHz mono s16le

/**
 * Repair the job's WAV header from the file length and list what is on disk:
 * { durationS, artifacts }. A partial recording is kept and reported; a bare
 * 44-byte header is no recording.
 */
function partialArtifacts(dir) {
  const audio = path.join(dir, 'audio.wav');
  const captions = path.join(dir, 'captions.jsonl');
  const size = (f) => {
    try {
      return fs.statSync(f).size;
    } catch {
      return 0;
    }
  };
  const pcm = finalizeWav(audio);
  if (size(audio) <= 44) return { durationS: null, artifacts: [] };
  const artifacts = [{ kind: 'audio', path: audio, format: 'wav' }];
  if (size(captions) > 0) artifacts.push({ kind: 'captions', path: captions });
  return { durationS: Math.round((pcm / RATE_BYTES) * 10) / 10, artifacts };
}

/**
 * The HTTP server; `server.outbox` is the event outbox (null when `emit` is
 * injected), `server.recover()` fails jobs a dead process left running,
 * `server.shutdown()` stops every running job and flushes the outbox once.
 */
function createServer({ config, record = realRecord, emit, log = stderrLog }) {
  const quiet = ['warn', 'error'].includes(config.logLevel);
  const store = jobStore(config.dataDir);
  const { save, load, dir: jobDir } = store;
  const outbox = emit ? null : createOutbox({ secret: config.secret, dataDir: path.resolve(config.dataDir), store, log });
  emit = emit || outbox.emit;
  const send = (job, event) => {
    try {
      Promise.resolve(emit(job, event)).catch((e) => log(`job ${job.id}: emit ${event} failed: ${e.message}`));
    } catch (e) {
      log(`job ${job.id}: emit ${event} failed: ${e.message}`);
    }
  };
  const running = new Map(); // job id -> { abort, done }
  let stopping = false;
  const update = (job, patch) => {
    Object.assign(job, patch);
    try {
      save(job);
    } catch (e) {
      log(`job ${job.id}: cannot write job.json: ${e.message}`);
    }
  };

  function start(job) {
    const dir = jobDir(job.id);
    const audio = path.join(dir, 'audio.wav');
    const captions = path.join(dir, 'captions.jsonl');
    log(`job ${job.id}: recording meeting ${meetingCode(job.url)}`);
    const artifacts = (captionsPath) => {
      const list = [{ kind: 'audio', path: audio, format: 'wav' }];
      if (captionsPath) list.push({ kind: 'captions', path: captionsPath });
      return list;
    };
    const ac = new AbortController();
    const done = Promise.resolve()
      .then(() =>
        record({
          url: job.url,
          out: audio,
          captionsOut: captions,
          displayName: job.display_name,
          joinTimeoutS: job.join_timeout_s,
          maxDurationS: job.max_duration_s,
          emptyGraceS: job.empty_grace_s,
          signal: ac.signal,
          // LOG_LEVEL warn|error silences record()'s progress lines.
          log: quiet ? () => {} : (msg) => log(`job ${job.id}: ${msg}`),
          onState: (s) => {
            if (s === 'waiting_in_lobby') send(job, 'recording.waiting_admission');
            if (s === 'joined') {
              update(job, { state: 'recording', started_at: new Date().toISOString() });
              send(job, 'recording.started');
            }
          },
        }),
      )
      .then(
        (r) => {
          update(job, {
            state: 'finished',
            ended_at: new Date().toISOString(),
            duration_s: r.durationS,
            reason: r.reason,
            participants: r.participants,
            artifacts: artifacts(r.captions),
          });
          log(`job ${job.id}: finished (${r.reason}, ${r.durationS}s)`);
          send(job, 'recording.finished');
        },
        (e) => {
          // Stopped by a signal before it was admitted: there is nothing to finish.
          const error = e && e.code === 'not_admitted' ? (ac.signal.aborted ? 'interrupted' : 'not_admitted') : 'recorder_failed';
          // record() may have died before finalizing the WAV header.
          const part = partialArtifacts(dir);
          update(job, {
            state: 'failed',
            error,
            ended_at: new Date().toISOString(),
            duration_s: e && e.durationS != null ? e.durationS : part.durationS,
            artifacts: part.artifacts,
          });
          log(`job ${job.id}: failed (${error}): ${e && e.message}`);
          send(job, 'recording.failed');
        },
      )
      .catch((e) => log(`job ${job.id}: ${e.message}`))
      .finally(() => running.delete(job.id));
    running.set(job.id, { abort: () => ac.abort(), done });
  }

  /** Startup: every job a dead process left joining/recording becomes failed/interrupted. */
  function recover() {
    let ids = [];
    try {
      ids = fs.readdirSync(path.resolve(config.dataDir));
    } catch (e) {
      if (e.code !== 'ENOENT') log(`recover: ${e.message}`);
    }
    for (const id of ids) {
      let job;
      try {
        job = ID_RE.test(id) && load(id);
      } catch (e) {
        log(`job ${id}: unreadable job.json (${e.code || e.name})`);
        continue;
      }
      if (!job || (job.state !== 'joining' && job.state !== 'recording') || running.has(id)) continue;
      const part = partialArtifacts(jobDir(id));
      update(job, { state: 'failed', error: 'interrupted', ended_at: new Date().toISOString(), duration_s: part.durationS, artifacts: part.artifacts });
      log(`job ${id}: interrupted by a restart (${part.durationS || 0}s on disk)`);
      send(job, 'recording.failed');
    }
  }

  /** Stop every running job (finished, reason "signal"), then one last delivery attempt. */
  async function shutdown() {
    stopping = true;
    const jobs = [...running.values()];
    if (jobs.length) log(`stopping ${jobs.length} running job(s)`);
    for (const j of jobs) j.abort();
    await Promise.all(jobs.map((j) => j.done));
    if (outbox) await outbox.flush();
  }

  function reply(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && pathname === '/health') return reply(res, 200, { status: 'ok' });
    const get = pathname.match(/^\/recordings\/([^/]+)$/);
    const route = req.method === 'POST' && pathname === '/recordings' ? 'post' : req.method === 'GET' && get ? 'get' : null;
    if (!route) return reply(res, 404, { error: 'not found' });

    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) return reply(res, 413, { error: 'body too large' });
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks);
    if (!validSignature(config.secret, raw, req.headers['x-recorder-signature'])) return reply(res, 401, { error: 'bad signature' });

    if (route === 'get') {
      const job = ID_RE.test(get[1]) ? load(get[1]) : null;
      return job ? reply(res, 200, job) : reply(res, 404, { error: 'unknown job' });
    }

    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply(res, 400, { error: 'body must be JSON' });
    }
    if (stopping) return reply(res, 503, { error: 'shutting down' });
    const p = parseRequest(body, config);
    if (p.error) return reply(res, p.status, { error: p.error });
    // Synchronous from here to save(): a concurrent retry sees the file.
    const existing = load(p.job.id);
    if (existing) return reply(res, 200, { id: existing.id, state: existing.state });
    fs.mkdirSync(jobDir(p.job.id), { recursive: true });
    save(p.job);
    start(p.job);
    return reply(res, 202, { id: p.job.id, state: p.job.state });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`${req.method} ${req.url.split('?')[0]}: ${e.message}`);
      if (!res.headersSent) reply(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });
  return Object.assign(server, { outbox, recover, shutdown });
}

module.exports = { createServer, jobStore, validSignature, meetCode, parseRequest, partialArtifacts };

if (require.main === module) {
  const { loadConfig } = require('./config.js');
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    stderrLog(`config: ${e.message}`);
    process.exit(1);
  }
  const server = createServer({ config });
  server.recover();
  server.outbox.start();
  let signalled = false;
  const onSignal = (sig) => {
    if (signalled) process.exit(1); // a second signal: exit at once
    signalled = true;
    stderrLog(`${sig}: shutting down`);
    server.close();
    server.shutdown().then(
      () => process.exit(0),
      (e) => {
        stderrLog(`shutdown: ${e.message}`);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  server.listen(config.port, () => stderrLog(`listening on :${config.port}, data in ${config.dataDir}`));
}

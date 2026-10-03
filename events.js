'use strict';

// Events to the caller's callback_url (docs/architecture.md §3.5).
// waiting_admission / started: one attempt, failure only logged.
// finished / failed: written to DATA_DIR/<id>/outbox/ first, retried on
// BACKOFF, then by the hourly sweep and on startup, until a 2xx. A delivered
// event leaves the outbox and is recorded in job.json `delivered`.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GUARANTEED = new Set(['recording.finished', 'recording.failed']);
const BACKOFF_MS = [5e3, 15e3, 45e3, 120e3, 300e3];
const SWEEP_MS = 3600e3;
const TIMEOUT_MS = 30e3;

const sign = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

/** The event body: the common envelope plus the per-event fields. */
function buildEvent(job, event, at = new Date().toISOString()) {
  const e = { event, id: job.id, source: 'meet', url: job.url, meta: job.meta, at };
  if (event === 'recording.finished') {
    const { started_at, ended_at, duration_s, reason, participants, artifacts } = job;
    Object.assign(e, { started_at, ended_at, duration_s, reason, participants, artifacts });
  } else if (event === 'recording.failed') {
    e.error = job.error;
    if (job.artifacts && job.artifacts.length) e.artifacts = job.artifacts;
  }
  return e;
}

/**
 * store: { dir(id), load(id), save(job) } over DATA_DIR/<id>/job.json.
 * Returns { emit(job, event), sweep(), start() }.
 */
function createOutbox({ secret, dataDir, store, log, backoff = BACKOFF_MS }) {
  const inFlight = new Set(); // outbox files with a delivery loop running

  /** One attempt. Resolves on 2xx, rejects otherwise. Redirects are not followed. */
  async function post(callbackUrl, event, body) {
    const res = await fetch(callbackUrl, {
      method: 'POST',
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', 'x-recorder-event': event, 'x-recorder-signature': sign(secret, body) },
    });
    await res.arrayBuffer().catch(() => {}); // drain so the connection can be reused
    if (res.status < 200 || res.status > 299) throw new Error(`http ${res.status}`);
  }

  /** Record a delivery in job.json; `job` is the live record when there is one. */
  function markDelivered(job, event, id) {
    try {
      job = job || store.load(id);
      if (!job) return;
      job.delivered = { ...job.delivered, [event]: new Date().toISOString() };
      store.save(job);
    } catch (e) {
      log(`job ${id}: cannot record delivery of ${event}: ${e.message}`);
    }
  }

  /** Deliver an outbox file, retrying on `schedule`; the file stays until a 2xx. */
  async function deliver(file, job, schedule) {
    if (inFlight.has(file)) return;
    inFlight.add(file);
    try {
      const { callback_url, event, id, body } = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (let attempt = 0; ; attempt++) {
        try {
          await post(callback_url, event, body);
          fs.rmSync(file, { force: true });
          markDelivered(job, event, id);
          log(`job ${id}: ${event} delivered (attempt ${attempt + 1})`);
          return;
        } catch (e) {
          if (attempt >= schedule.length) {
            log(`job ${id}: ${event} not delivered (${e.message}); left in the outbox`);
            return;
          }
          log(`job ${id}: ${event} failed (${e.message}), retry in ${schedule[attempt] / 1000}s`);
          await new Promise((r) => setTimeout(r, schedule[attempt]).unref());
        }
      }
    } catch (e) {
      log(`outbox ${file}: ${e.message}`);
    } finally {
      inFlight.delete(file);
    }
  }

  function emit(job, event) {
    const body = JSON.stringify(buildEvent(job, event));
    const once = () =>
      post(job.callback_url, event, body).then(
        () => markDelivered(job, event, job.id),
        (e) => log(`job ${job.id}: ${event} not delivered (${e.message})`),
      );
    if (!GUARANTEED.has(event)) return once();
    const dir = path.join(store.dir(job.id), 'outbox');
    const file = path.join(dir, `${event}.json`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ callback_url: job.callback_url, event, id: job.id, body }));
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      // ponytail: no outbox means one attempt only; the bot's watchdog covers a loss.
      log(`job ${job.id}: cannot write the outbox (${e.message}); one attempt only`);
      return once();
    }
    return deliver(file, job, backoff);
  }

  /** One attempt for every undelivered event on disk. */
  function sweep() {
    const files = [];
    let ids = [];
    try {
      ids = fs.readdirSync(dataDir);
    } catch (e) {
      if (e.code !== 'ENOENT') log(`outbox sweep: ${e.message}`);
    }
    for (const id of ids) {
      const dir = path.join(dataDir, id, 'outbox');
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) if (n.endsWith('.json')) files.push(path.join(dir, n));
    }
    return Promise.all(files.map((f) => deliver(f, null, [])));
  }

  /** Startup redelivery plus the hourly sweep. */
  function start() {
    sweep();
    setInterval(sweep, SWEEP_MS).unref();
  }

  return { emit, sweep, start };
}

module.exports = { createOutbox, buildEvent, sign, BACKOFF_MS };

'use strict';

// Headless Google Meet audio recorder, as a library: record() joins as a guest
// (no Google account), knocks, waits in the lobby, and records the call audio
// as a 16 kHz mono WAV. See docs/recording.md.
//
// It owns no process state: no signal handlers, no process.exit, no stdout.
// The caller stops a run with an AbortSignal. Every call gets its own
// PulseAudio, Chromium and temp dir, so several runs share one process.
//
// How the audio is captured (proven in live Meet tests): Meet
// only plays call audio to a participant that has media devices, so Chromium
// gets a fake silent mic and a fake black camera, both switched off before
// joining; it plays the call into a private PulseAudio null sink, and parec
// records that sink's monitor. Page-side capture (WebAudio/MediaRecorder on the
// RTP tracks, tab capture) does NOT work on Meet: it decodes in its own graph.
//
// Hard rule: the bot never sends audio or video into the call. The fake devices
// are digital silence and a black frame, Meet's mic/camera toggles are turned
// off before joining and re-checked in the call, and lockMedia() disables every
// captured track so Meet cannot re-enable it.
//
// Speaker hints (captionsOut): Meet gives no per-participant audio, but its
// live captions name the speaker of every utterance. With captionsOut set,
// captions are turned on after admission (visible to participants — owner-approved) and
// each finished utterance becomes one JSONL line {offset_s, speaker, text};
// the transcriber aligns them to its own transcript. Captions failing never
// affects the recording.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const POLL_MS = 2000;
// A guest knocking on a meeting nobody has opened yet gets "No one responded to
// your request" after a while; it knocks again this often until joinTimeoutS.
const REKNOCK_MS = 60000;
// Prejoin "Ask to join" clicked but the page still reads prejoin: click again.
const RECLICK_MS = 10000;
const RATE = 16000; // parec output: 16 kHz mono s16le, ~1.9 MB/min

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stderrLog = (msg) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
const scrub = (msg) => String(msg).replace(/https?:\/\/\S+/g, '<url>');

/** An Error carrying the job error code: 'not_admitted' | 'recorder_failed'. */
function recordError(code, message, extra) {
  return Object.assign(new Error(scrub(message)), { code }, extra);
}

/**
 * Pure stop decision. Times (`now`, `aloneSince`, `startedAt`) are epoch ms;
 * `emptyGrace` / `maxDuration` are seconds. `membersCount` includes the bot.
 * Returns the stop reason (or null) plus the carried-forward `aloneSince`,
 * which resets as soon as somebody else is in the room again.
 */
function shouldStop({ membersCount, aloneSince, now, emptyGrace, startedAt, maxDuration }) {
  if (now - startedAt >= maxDuration * 1000) return { reason: 'max_duration', aloneSince };
  const alone = membersCount <= 1;
  const since = alone ? (aloneSince ?? now) : null;
  if (alone && now - since >= emptyGrace * 1000) return { reason: 'empty_room', aloneSince: since };
  return { reason: null, aloneSince: since };
}

/** The meeting code only — never log the URL (it may carry an authuser or a pwd). */
function meetingCode(url) {
  const m = String(url).match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})\b/);
  return m ? m[1] : '(meeting)';
}

/**
 * The stop decision on Meet's visible roster. `others` = names other than the
 * bot, or null when the roster could not be read at all (no tile on screen —
 * a DOM change, not an empty room): unknown never counts as alone.
 * Delegates to shouldStop(), whose membersCount includes the bot.
 */
function meetShouldStop({ others, aloneSince, now, emptyGrace, startedAt, maxDuration }) {
  const membersCount = others === null ? 2 : others.length + 1;
  return shouldStop({ membersCount, aloneSince, now, emptyGrace, startedAt, maxDuration });
}

const CAPTION_SETTLE_MS = 3000;

/**
 * Fold one captions poll (readCaptions' blocks) into finished utterances. Meet
 * rewrites the newest block while its speaker talks (and corrects older ones
 * for a moment), so a block is final once it left the DOM, or a newer block
 * exists and it has not changed for CAPTION_SETTLE_MS, or the run ends
 * (`flush`). A block whose text shrinks to under half is Meet restarting a long
 * turn in the same element: the old text is final. Returns [{at, speaker,
 * text}] (`at` = ms when the utterance first showed), each one once.
 * `st` = { open: Map(id -> utterance), done: Set(id) }.
 * ponytail: corrections Meet makes after a block is final are dropped.
 */
function foldCaptions(st, blocks, now, flush = false) {
  const out = [];
  const emit = (u) => out.push({ at: u.first, speaker: u.speaker, text: u.text });
  const final = (id) => {
    emit(st.open.get(id));
    st.open.delete(id);
    st.done.add(id);
  };
  const present = new Set();
  for (const b of blocks) {
    if (!b.text) {
      // Still on screen but cleared: its turn is over and Meet may reuse the
      // element for the next one, so its id may start a new utterance.
      present.add(b.id);
      if (st.open.has(b.id)) final(b.id);
      st.done.delete(b.id);
      continue;
    }
    if (st.done.has(b.id)) continue;
    present.add(b.id);
    const u = st.open.get(b.id);
    if (!u) st.open.set(b.id, { speaker: b.name || '?', text: b.text, first: now, changed: now });
    else if (b.text !== u.text) {
      if (b.text.length < u.text.length / 2) {
        emit(u);
        u.first = now;
      }
      Object.assign(u, { speaker: b.name || u.speaker, text: b.text, changed: now });
    }
  }
  const withText = blocks.filter((b) => b.text);
  const newest = withText.length ? withText[withText.length - 1].id : null;
  for (const [id, u] of [...st.open]) {
    if (flush || !present.has(id) || (id !== newest && now - u.changed >= CAPTION_SETTLE_MS)) final(id);
  }
  return out;
}

/** One speaker-hint line: seconds since the recording started, 0.1 s steps,
 * never before `prev` (blocks can finalize out of order) nor before 0. */
function captionHint(u, startedAt, prev) {
  const offset = Math.max(prev, 0, Math.round((u.at - startedAt) / 100) / 10);
  return { offset_s: offset, speaker: u.speaker, text: u.text };
}

// --- page side ----------------------------------------------------------------
// Every Meet DOM read lives in the functions below (no closures: puppeteer
// serializes them). Meet's markup is obfuscated and changes without notice, so
// a Meet UI change stays a fix in this block. English UI is forced at launch;
// every phrase is English.
// Last checked in live Meet tests on 2026-10-02 (Workspace-hosted and
// externally hosted meetings).

/** Injected before any Meet script: every captured mic/camera track starts
 * disabled and stays so — Meet setting track.enabled = true hits a no-op.
 * ponytail: a track Meet clone()s loses the lock; it is still disabled and
 * still the silent/black fake file. */
function lockMedia() {
  if (!window.MediaDevices || !MediaDevices.prototype.getUserMedia) return;
  const gum = MediaDevices.prototype.getUserMedia;
  MediaDevices.prototype.getUserMedia = function (...a) {
    return gum.apply(this, a).then((stream) => {
      for (const t of stream.getTracks()) {
        t.enabled = false;
        Object.defineProperty(t, 'enabled', { get: () => false, set: () => {} });
      }
      return stream;
    });
  };
}

/** Classify the page: {state, why}. Order matters: in the call, terminal
 * phrases are ignored; without tiles they win over a lingering Leave button. */
function readState() {
  // Captions are participant speech: "the call has ended" said aloud must not end the run.
  const cap = document.querySelector('[role="region"][aria-label*="aption" i]');
  let text = (document.body && document.body.innerText) || '';
  if (cap && cap.innerText) text = text.replace(cap.innerText, '');
  const flat = text.replace(/\s+/g, ' ');
  const has = (re) => {
    const m = flat.match(re);
    return m ? m[0] : null;
  };
  const leave = !!document.querySelector('[aria-label*="Leave call" i]');
  const tiles = !!document.querySelector('[data-participant-id]');
  const rules = [
    ['signin', () => (/accounts\.google\.com/.test(location.host) ? 'sign-in page' : null)],
    // The lobby shows a Leave call button too: its own phrases win over it.
    ['lobby', () => has(/please wait until a meeting host brings you into the call|asking to be let in|you'll join the call when someone lets you in/i)],
    // In the call (Leave button + video tiles), page text is chat and names —
    // participant-controlled, so "the call has ended" typed in chat must not end the run.
    ['admitted', () => (leave && tiles ? 'Leave call button + tiles' : null)],
    // Nobody answered the knock (nobody in the meeting yet): re-knock.
    ['unanswered', () => has(/no one responded to your request/i)],
    ['denied', () => has(/denied your request|someone in the call denied|you can't join this call/i)],
    ['blocked', () => has(/you can't join this video call|not allowed to join|this meeting has been locked/i)],
    ['invalid', () => has(/check your meeting code|invalid video call name/i)],
    ['removed', () => has(/you've been removed from the meeting|removed you from the meeting/i)],
    ['ended', () => has(/you left the meeting|the call has ended|call ended|meeting has ended|return to home screen/i)],
    ['admitted', () => (leave ? 'Leave call button' : null)],
    // Weaker phrases ("X is asking to join" is also an in-call notice) only count without the button.
    ['lobby', () => has(/please wait until a meeting host|someone will let you in|waiting for the host|asking to join/i)],
    // Meet's pre-check page: "Getting ready... System info will be sent to confirm you're not a bot."
    ['loading', () => has(/getting ready\.\.\./i)],
    ['prejoin', () => has(/ask to join|join now|what's your name|ready to join|other ways to join/i)],
  ];
  for (const [state, test] of rules) {
    const why = test();
    if (why) return { state, why };
  }
  return { state: 'unknown', why: '' };
}

/** Prejoin screen, one pass: dismiss device prompts, switch every "Turn off
 * microphone/camera" toggle off, and report what is left to do. `mic`/`cam`:
 * 'on' | 'off' | '?' (no toggle) as read before this pass's clicks. Same
 * aria-labels on the prejoin screen and the in-call toolbar. */
function prejoin(name) {
  const btns = [...document.querySelectorAll('button, [role="button"]')];
  const label = (b) => b.getAttribute('aria-label') || '';
  const text = (b) => (b.innerText || label(b)).trim();
  for (const re of [/continue without microphone and camera/i, /^got it$/i, /^dismiss$/i]) {
    const b = btns.find((x) => re.test(text(x)));
    if (b) b.click();
  }
  const dev = (d) =>
    btns.some((b) => new RegExp('turn off ' + d, 'i').test(label(b))) ? 'on' : btns.some((b) => new RegExp('turn on ' + d, 'i').test(label(b))) ? 'off' : '?';
  const r = { mic: dev('microphone'), cam: dev('camera') };
  for (const b of btns) if (/turn off (microphone|camera)/i.test(label(b))) b.click();
  const input = document.querySelector('input[aria-label="Your name" i], input[placeholder="Your name" i], input[type="text"][autocomplete="name"]');
  r.needsName = !!(input && !input.value && name);
  return r;
}

/** Click "Ask to join" (or its variants) if it is enabled; returns its label. */
function clickJoin() {
  const b = [...document.querySelectorAll('button, [role="button"]')].find(
    (x) =>
      /^(ask to join( anyway)?|join( the call)? now|join anyway|join here too)$/i.test((x.innerText || '').trim()) &&
      !x.disabled &&
      x.getAttribute('aria-disabled') !== 'true', // a disabled click is a no-op: retry next poll
  );
  if (b) b.click();
  return b ? b.innerText.trim() : null;
}

/** Visible participant names: the video tiles, the people panel when open, and
 * the bot's own name as Meet marks it. `tiles` = number of tiles on screen
 * (self included) — 0 means the roster is unreadable, not empty. */
function readNames() {
  const uniq = (a) => [...new Set(a.map((s) => (s || '').trim()).filter(Boolean))];
  const firstLine = (el) => ((el.innerText || '').split('\n')[0] || '').trim();
  const tileEls = [...document.querySelectorAll('[data-participant-id]')];
  const panel = [...document.querySelectorAll('[role="list"][aria-label*="articipant" i] [role="listitem"]')];
  return {
    tiles: tileEls.length,
    unnamed: tileEls.filter((e) => !firstLine(e)).length,
    names: uniq([...tileEls.map(firstLine), ...panel.map((e) => e.getAttribute('aria-label') || firstLine(e))]),
    self: uniq([...document.querySelectorAll('[data-self-name]')].map((e) => e.getAttribute('data-self-name'))),
  };
}

/** Captions on by the toolbar button; returns what it saw/did. The 'c'
 * shortcut is the node-side fallback. Selectors as used by open-source Meet
 * bots and caption extensions (aria-label, then the Material icon name). */
function captionsOn(mayClick) {
  const on = document.querySelector('button[aria-label*="Turn off captions" i], button[aria-label*="aption" i][aria-pressed="true"]');
  if (on) return { on: true, did: null };
  const b =
    document.querySelector('button[aria-label*="Turn on captions" i]') ||
    [...document.querySelectorAll('button')].find((x) => /closed_caption_off/.test(x.innerText || ''));
  if (!b || !mayClick) return { on: false, did: null };
  const label = (b.getAttribute('aria-label') || b.innerText || '').trim(); // before the click flips it
  b.click();
  return { on: false, did: `clicked "${label}"` };
}

/** The caption blocks (one per speaker turn) in the captions region:
 * [{id, name, text}]. Meet's classes are obfuscated and rotate, so: known
 * classes first, then a structural guess (an element whose first child is a
 * short one-line name and whose other children hold the text). Every block
 * gets a stable id so foldCaptions can tell a rewrite from a new block. */
function readCaptions() {
  const region =
    document.querySelector('[role="region"][aria-label*="aption" i]') ||
    document.querySelector('div[role="region"][tabindex="0"]');
  if (!region) return { region: false, blocks: [] };
  const txt = (el) => ((el && el.innerText) || '').replace(/\s+/g, ' ').trim();
  window.__capId = window.__capId || 0;
  const id = (el) => el.dataset.capId || (el.dataset.capId = String(++window.__capId));
  let blocks = [...region.querySelectorAll('.nMcdL')].map((b) => ({
    id: id(b),
    name: txt(b.querySelector('.NWpY1d, .KcIKyf, .zs7s8d')),
    text: txt(b.querySelector('.ygicle, .bh44bd, .iTTPOb')),
  }));
  // Known blocks with a name count even while cleared (empty text): foldCaptions needs them.
  if (!blocks.some((b) => b.name)) {
    const cand = [...region.querySelectorAll('*')].filter((e) => {
      if (e.children.length < 2) return false;
      const name = (e.children[0].innerText || '').trim();
      // A turn seen before (it has an id) stays a candidate once cleared, so
      // foldCaptions sees the empty text and lets Meet reuse the element.
      return name && name.length <= 80 && !name.includes('\n') && (txt(e).length > name.length || e.dataset.capId);
    });
    // A wrapper with two or more candidate children is the caption list, not a
    // turn; of the rest the outermost wins (a text div of several spans can
    // pass the test inside its turn).
    const turns = cand.filter((e) => [...e.children].filter((c) => cand.includes(c)).length < 2);
    blocks = turns
      .filter((e) => !turns.some((o) => o !== e && o.contains(e)))
      .map((e) => ({ id: id(e), name: txt(e.children[0]), text: [...e.children].slice(1).map(txt).filter(Boolean).join(' ') }));
  }
  return { region: true, blocks };
}

// --- node side ----------------------------------------------------------------

/** Captions on: the toolbar button (two clicks at most: a button whose label
 * never flips must not be toggled forever), then the 'c' shortcut. Never
 * clicks once captions read as on, so it cannot toggle them back off. The
 * caption language is left as the meeting has it: only speaker and time matter. */
async function enableCaptions(page, stopped, log) {
  let pressed = false;
  let clicks = 0;
  for (let i = 0; i < 10 && !stopped(); i++) {
    const r = await page.evaluate(captionsOn, clicks < 2).catch(() => ({ on: false, did: null }));
    if (r.on) {
      log(`captions on${pressed ? ' (c shortcut)' : ''}`);
      return;
    }
    if (r.did) {
      clicks++;
      log(`captions: ${r.did}`);
    }
    if (!clicks && !pressed && i >= 3) {
      await page.keyboard.press('c').catch(() => {}); // Meet shortcut: toggle captions
      pressed = true;
    }
    await sleep(1500);
  }
  log('captions: not confirmed on; still reading the captions region (the recording is not affected)');
}

/** Names other than the bot's, or null when the roster is unreadable — no
 * tile on screen, or any tile without name text: a missing name must never
 * make the room look empty. */
function otherNames({ tiles, unnamed, names, self }, displayName) {
  // ponytail: one nameless tile (a placeholder, a share) disables the empty-room
  // rule for that poll; maxDurationS is the backstop.
  if (!tiles || unnamed || !names.length) return null;
  const me = new Set([displayName, ...self].map((s) => s.toLowerCase()));
  return names.filter((n) => !me.has(n.toLowerCase()) && !/\(you\)$/i.test(n) && !/^you$/i.test(n));
}

/** `seconds` of digital silence as a 48 kHz mono s16 WAV: the fake mic. */
function silentWav(seconds) {
  const rate = 48000;
  const n = rate * seconds * 2;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + n, 4);
  h.write('WAVEfmt ', 8, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(n, 40);
  return Buffer.concat([h, Buffer.alloc(n)]);
}

/** One black 320x240 frame as Y4M (Chromium loops it): the fake camera. */
function blackY4m() {
  return Buffer.concat([
    Buffer.from('YUV4MPEG2 W320 H240 F15:1 Ip A1:1 C420jpeg\nFRAME\n', 'latin1'),
    Buffer.alloc(320 * 240, 16),
    Buffer.alloc(2 * 160 * 120, 128),
  ]);
}

/** Puppeteer launch options: fake silent mic + black camera from files in
 * `dir`, prompts auto-accepted, audio NOT muted (the null sink must hear it),
 * Chromium on the private PulseAudio `server`. */
function launchOpts(dir, server) {
  const audio = path.join(dir, 'fake-mic-silence.wav');
  const video = path.join(dir, 'fake-cam-black.y4m');
  fs.writeFileSync(audio, silentWav(2));
  fs.writeFileSync(video, blackY4m());
  return {
    headless: true, // new headless in puppeteer >= 22
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,800',
      '--lang=en-US', // every phrase readState matches is English
      '--no-first-run',
      '--no-default-browser-check',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${audio}`,
      `--use-file-for-fake-video-capture=${video}`,
      // The usual evasions open-source Meet bots ship with; live Meet tests passed
      // Meet's bot check with these and no stealth plugin.
      '--disable-blink-features=AutomationControlled',
    ],
    // --mute-audio: puppeteer mutes headless audio by default.
    ignoreDefaultArgs: ['--mute-audio', '--enable-automation'],
    env: { ...process.env, PULSE_SERVER: server },
    // No process-level handlers: the caller's AbortSignal stops a run, and
    // the WAV must be finalized before the browser goes.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
}

/** Spawn a child whose stderr tail is kept on `p.err`. */
function run(cmd, args, env) {
  const p = spawn(cmd, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
  p.err = '';
  p.stderr.on('data', (d) => (p.err = (p.err + d).slice(-500)));
  p.on('error', (e) => (p.err = e.message));
  // ponytail: record()'s finally kills every child; a host process dying hard
  // leaves them orphaned — the host's shutdown aborts its runs first.
  return p;
}

const alive = (p) => p.exitCode === null && !p.signalCode;

/** SIGINT (parec finalizes the WAV header on it), then SIGKILL after 3 s. */
async function stopProc(p) {
  if (!p || !alive(p)) return;
  p.kill('SIGINT');
  await new Promise((r) => {
    p.once('exit', r);
    setTimeout(r, 3000);
  });
  if (alive(p)) p.kill('SIGKILL');
}

/**
 * One private PulseAudio per run in `dir` (a fresh temp dir, so concurrent jobs
 * never share a server): its only — so default — output is a null sink named
 * `meet`, so Chromium has a real output device that pulls WebRTC playout.
 * Returns { server, proc } or throws.
 */
async function startPulse(dir) {
  const sock = path.join(dir, 'native');
  const env = { ...process.env, HOME: dir, XDG_RUNTIME_DIR: dir, PULSE_RUNTIME_PATH: dir };
  // -n: no default.pa, so nothing but these two modules (no hardware probing).
  const proc = run(
    'pulseaudio',
    ['-n', '--daemonize=no', '--exit-idle-time=-1', '--use-pid-file=no', '--log-target=stderr',
      '-L', `module-native-protocol-unix socket=${sock} auth-anonymous=1`,
      '-L', 'module-null-sink sink_name=meet rate=48000'],
    env,
  );
  for (let i = 0; i < 50 && !fs.existsSync(sock) && alive(proc); i++) await sleep(100);
  if (!fs.existsSync(sock)) {
    await stopProc(proc);
    throw new Error(`pulseaudio did not start: ${proc.err.trim().split('\n').pop() || 'no socket'}`);
  }
  return { server: `unix:${sock}`, proc };
}

/** parec on the null sink's monitor -> `out` as 16 kHz mono s16 WAV. */
function startParec(server, out) {
  return run('parec', ['-s', server, '-d', 'meet.monitor', `--rate=${RATE}`, '--channels=1', '--format=s16le', '--file-format=wav', out], process.env);
}

/**
 * Make the WAV header match the file whatever happened to parec (a SIGKILL
 * leaves placeholder sizes) and return the PCM byte count — 0 for a missing,
 * header-only or unparseable file.
 */
function finalizeWav(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r+');
  } catch {
    return 0;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, 4096));
    fs.readSync(fd, head, 0, head.length, 0);
    const at = head.indexOf('data', 12, 'latin1');
    if (head.toString('latin1', 0, 4) !== 'RIFF' || at < 0) return 0;
    const pcm = size - (at + 8);
    if (pcm <= 0) return 0;
    const u32 = (n, pos) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n);
      fs.writeSync(fd, b, 0, 4, pos);
    };
    u32(size - 8, 4);
    u32(pcm, at + 4);
    return pcm;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Record one Meet call into `out` (16 kHz mono WAV; its parent dir is created,
 * the file truncated). Resolves { durationS, reason, participants, captions }:
 * `reason` = empty_room | max_duration | signal | ended | removed; `captions`
 * = captionsOut when it got at least one line, else undefined. Rejects with an
 * Error whose `code` is 'not_admitted' (denied, invalid meeting, join timeout,
 * aborted before admission) or 'recorder_failed' (browser/page failure, or the
 * capture died mid-call — the truncated WAV is kept and `err.durationS` says
 * how much of it there is). Bad arguments throw a TypeError without a code.
 *
 * `signal` (AbortSignal) stops the run: parec gets SIGINT, the WAV header is
 * finalized and the promise resolves with reason 'signal'. `onState` gets
 * 'waiting_in_lobby' once, on the first knock, and 'joined' at admission.
 * `log(msg)` gets the progress lines (default: timestamped stderr); it never
 * sees the meeting URL.
 */
async function record({
  url,
  out,
  captionsOut,
  displayName = 'NoteTaker',
  joinTimeoutS = 1200,
  maxDurationS = 14400,
  emptyGraceS = 60,
  signal,
  onState = () => {},
  log = stderrLog,
} = {}) {
  if (!/^https:\/\/meet\.google\.com\/./.test(url || '')) throw new TypeError('url must be a https://meet.google.com/... URL');
  if (!out) throw new TypeError('out is required');
  out = path.resolve(out);
  if (captionsOut) {
    captionsOut = path.resolve(captionsOut);
    if (captionsOut === out) throw new TypeError('captionsOut must differ from out');
  }
  for (const [k, v] of Object.entries({ joinTimeoutS, maxDurationS, emptyGraceS })) {
    if (!Number.isFinite(v) || v <= 0) throw new TypeError(`${k} must be a positive number`);
  }
  const state = (s) => {
    try {
      onState(s);
    } catch (e) {
      log(`onState threw: ${scrub(e.message)}`); // a caller bug never stops the recording
    }
  };

  let reason = null;
  const onAbort = () => {
    if (reason) return;
    reason = 'signal';
    log('abort signal — stopping');
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let dir = null;
  let pulse = null;
  let parec = null;
  let browser = null;
  let pageGone = false;
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.rmSync(out, { force: true }); // truncate semantics: a rerun never appends
    if (captionsOut) {
      try {
        fs.mkdirSync(path.dirname(captionsOut), { recursive: true });
        fs.rmSync(captionsOut, { force: true });
      } catch (e) {
        log(`captions: cannot prepare the output (${e.message}); recording without speaker hints`);
        captionsOut = undefined;
      }
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-'));

    let page;
    try {
      pulse = await startPulse(dir);
      browser = await require('puppeteer').launch(launchOpts(dir, pulse.server));
      page = (await browser.pages())[0] || (await browser.newPage());
      const ua = await browser.userAgent();
      if (/HeadlessChrome/.test(ua)) await page.setUserAgent(ua.replace('HeadlessChrome', 'Chrome'));
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
      await page.evaluateOnNewDocument(lockMedia);
      // Meet may not play call audio to a guest without devices (seen in live Meet tests).
      await browser.defaultBrowserContext().overridePermissions('https://meet.google.com', ['camera', 'microphone']);
      log(`joining room ${meetingCode(url)} as ${displayName}`);
      page.on('close', () => (pageGone = true));
      page.on('error', () => (pageGone = true)); // the renderer crashed
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      throw recordError('recorder_failed', `browser launch/page failure: ${e.message}`);
    }

    // --- join phase -------------------------------------------------------
    const joinDeadline = Date.now() + joinTimeoutS * 1000;
    let last = '';
    let nameTyped = false;
    let clickedAt = 0; // last "Ask to join" click
    let knocks = 0;
    let knocked = false;
    // waiting_in_lobby once, on the first knock: the first "Ask to join" click,
    // or the lobby showing first (the poll can miss a short lobby, not the click).
    const knock = () => !knocked && (knocked = true) && state('waiting_in_lobby');
    let admitted = false;
    while (!reason && Date.now() < joinDeadline) {
      if (!browser.connected || pageGone) {
        throw recordError('recorder_failed', 'browser launch/page failure: the Meet page closed or crashed before admission');
      }
      const s = await page.evaluate(readState).catch((e) => ({ state: 'probe-error', why: scrub(e.message) }));
      if (s.state !== last) {
        log(`state: ${s.state} (${s.why})`);
        last = s.state;
      }
      if (s.state === 'lobby' || s.state === 'unanswered') knock();
      if (s.state === 'admitted') {
        admitted = true;
        break;
      }
      if (['denied', 'blocked', 'invalid', 'removed', 'ended', 'signin'].includes(s.state)) {
        throw recordError('not_admitted', `not admitted: ${s.state}`);
      }
      if (s.state === 'unanswered' && Date.now() - clickedAt >= REKNOCK_MS) {
        knocks++;
        log(`no one responded; re-knock ${knocks}`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => log(`reload failed: ${scrub(e.message)}`));
        nameTyped = false;
        clickedAt = 0;
        last = '';
      } else if (s.state === 'prejoin' && Date.now() - clickedAt >= RECLICK_MS) {
        const p = await page.evaluate(prejoin, displayName).catch((e) => ({ mic: '?', cam: '?', error: scrub(e.message) }));
        // Never join while the mic or camera reads on: the next pass confirms the clicks.
        if (p.mic !== 'on' && p.cam !== 'on' && !p.error) {
          if (p.needsName && !nameTyped) {
            await page.type('input[aria-label="Your name" i], input[placeholder="Your name" i], input[type="text"][autocomplete="name"]', displayName, { delay: 60 }).catch(() => {});
            nameTyped = true;
            await sleep(500);
          }
          await sleep(1000); // let device/name state settle like a human would
          const clicked = await page.evaluate(clickJoin).catch(() => null);
          if (clicked) {
            clickedAt = Date.now();
            log(`clicked "${clicked}"`);
            knock();
          }
        }
      }
      await sleep(POLL_MS);
    }
    if (!admitted) throw recordError('not_admitted', reason === 'signal' ? 'aborted before joining' : 'join timeout');
    state('joined');

    // --- record phase -----------------------------------------------------
    // parec starts at admission: the WAV is the call, not the prejoin screen.
    parec = startParec(pulse.server, out);
    const startedAt = Date.now();
    log('recording');
    let aloneSince = null;
    let failure = null;
    const participants = new Set(); // first-seen order
    // Captions as speaker hints: one JSONL line per finished utterance.
    const cap = { st: { open: new Map(), done: new Set() }, lines: 0, prev: 0 };
    const pollCaptions = async (flush) => {
      if (!captionsOut) return;
      const r = await page.evaluate(readCaptions).catch(() => null);
      // A failed read is not "every block left": keep the open ones for the next poll.
      if (!r && !flush) return;
      for (const u of foldCaptions(cap.st, r ? r.blocks : [], Date.now(), flush)) {
        const h = captionHint(u, startedAt, cap.prev);
        cap.prev = h.offset_s;
        try {
          fs.appendFileSync(captionsOut, JSON.stringify(h) + '\n');
          cap.lines++;
        } catch (e) {
          log(`captions: write failed: ${e.message}`); // hints are optional; the recording goes on
        }
      }
    };
    if (captionsOut) await enableCaptions(page, () => reason, log);
    for (let tick = 0; !reason && !failure; tick++) {
      // Every 10 s (and right away): Meet's mic/camera toggles stay off.
      if (tick % 5 === 0) {
        const p = await page.evaluate(prejoin, '').catch(() => null);
        if (p && (p.mic === 'on' || p.cam === 'on')) log(`in-call mic=${p.mic} cam=${p.cam}: turned off`);
      }
      // Captions every second: Meet drops old blocks from the DOM.
      for (let i = 0; i < 2; i++) {
        await sleep(POLL_MS / 2);
        await pollCaptions(false);
      }
      if (!alive(parec)) failure = `audio capture (parec) exited mid-call: ${parec.err.trim().split('\n').pop() || 'no error'}`;
      else if (!alive(pulse.proc)) failure = 'pulseaudio exited mid-call';
      else if (!browser.connected || pageGone) failure = 'the Meet page closed or crashed mid-call';
      if (failure || reason) break;
      const s = await page.evaluate(readState).catch(() => ({ state: 'probe-error' }));
      if (s.state === 'ended' || s.state === 'removed') {
        reason = s.state;
        break;
      }
      const names = await page.evaluate(readNames).catch(() => null);
      const others = names ? otherNames(names, displayName) : null;
      for (const n of others || []) participants.add(n);
      const next = meetShouldStop({
        others,
        aloneSince,
        now: Date.now(),
        emptyGrace: emptyGraceS,
        startedAt,
        maxDuration: maxDurationS,
      });
      aloneSince = next.aloneSince;
      if (next.reason) reason = next.reason;
    }

    log(`stopping: ${failure ? 'failed' : reason}`);
    await pollCaptions(true);
    if (captionsOut) log(`captions: ${cap.lines} utterance(s)`);
    await stopProc(parec);
    const pcm = finalizeWav(out);
    const durationS = Math.round((pcm / (RATE * 2)) * 10) / 10;
    if (failure) throw recordError('recorder_failed', `${failure} — the recording is truncated`, { durationS });
    if (!pcm) throw recordError('recorder_failed', 'the recording is missing or empty', { durationS });
    log(`wrote ${durationS}s, ${participants.size} participant(s)`);
    return { durationS, reason, participants: [...participants], captions: cap.lines ? captionsOut : undefined };
  } catch (e) {
    if (e.code === 'not_admitted' || e.code === 'recorder_failed') throw e;
    throw recordError('recorder_failed', `unexpected: ${e && e.stack ? e.stack : e}`);
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (browser) await browser.close().catch(() => {});
    await stopProc(parec);
    if (pulse) await stopProc(pulse.proc);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  record,
  meetingCode,
  meetShouldStop,
  otherNames,
  readState,
  readNames,
  readCaptions,
  captionsOn,
  foldCaptions,
  captionHint,
  CAPTION_SETTLE_MS,
  prejoin,
  lockMedia,
  launchOpts,
  startPulse,
  startParec,
  stopProc,
  finalizeWav,
  silentWav,
  RATE,
};

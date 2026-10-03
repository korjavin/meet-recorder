'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Requiring must not launch a browser or run the CLI.
const meet = require('./meet.js');
const { parseArgs, meetingCode, meetShouldStop, otherNames, readState, finalizeWav, silentWav, RATE, foldCaptions, captionHint, CAPTION_SETTLE_MS } = meet;

const URL = 'https://meet.google.com/abc-defg-hij';
const MIN = ['--url', URL, '--out', '/tmp/a.wav'];

test('parseArgs takes the flags and defaults', () => {
  assert.deepStrictEqual(parseArgs(MIN), {
    url: URL,
    out: '/tmp/a.wav',
    joinTimeout: 1200,
    maxDuration: 14400,
    emptyGrace: 60,
    displayName: 'NoteTaker',
  });
  const o = parseArgs([...MIN, '--join-timeout', '30', '--max-duration', '90', '--empty-grace', '5', '--display-name', 'Bot', '--tracks-dir', '/tmp/x/tracks']);
  assert.strictEqual(o.joinTimeout, 30);
  assert.strictEqual(o.maxDuration, 90);
  assert.strictEqual(o.emptyGrace, 5);
  assert.strictEqual(o.displayName, 'Bot');
});

test('parseArgs takes --captions-out anywhere among the pairs', () => {
  assert.strictEqual(parseArgs([...MIN, '--captions-out', '/tmp/c.jsonl']).captionsOut, '/tmp/c.jsonl');
  const o = parseArgs(['--captions-out', '/tmp/c.jsonl', ...MIN, '--join-timeout', '30']);
  assert.strictEqual(o.captionsOut, '/tmp/c.jsonl');
  assert.strictEqual(o.joinTimeout, 30);
  assert.throws(() => parseArgs([...MIN, '--captions-out']), /missing value/);
  assert.throws(() => parseArgs([...MIN, '--captions-out', '/tmp/../tmp/a.wav']), /differ from --out/);
});

test('foldCaptions stores each utterance once, with its final text', () => {
  const st = { open: new Map(), done: new Set() };
  const t = 1_000_000;
  const out = [];
  // Meet grows block 1 while Alice talks, then Bob starts block 2.
  out.push(...foldCaptions(st, [{ id: '1', name: 'Alice', text: 'Hello' }], t));
  out.push(...foldCaptions(st, [{ id: '1', name: 'Alice', text: 'Hello every' }], t + 1000));
  out.push(...foldCaptions(st, [{ id: '1', name: 'Alice', text: 'Hello everyone.' }, { id: '2', name: 'Bob', text: 'Hi' }], t + 2000));
  assert.deepStrictEqual(out, [], 'nothing is final while it may still change');
  // Block 1 settles while Bob's newest block keeps changing.
  out.push(...foldCaptions(st, [{ id: '1', name: 'Alice', text: 'Hello everyone.' }, { id: '2', name: 'Bob', text: 'Hi there' }], t + 2000 + CAPTION_SETTLE_MS));
  assert.deepStrictEqual(out, [{ at: t, speaker: 'Alice', text: 'Hello everyone.' }]);
  // Seeing a finished block again does not repeat it; a block leaving the DOM finalizes it.
  out.push(...foldCaptions(st, [{ id: '1', name: 'Alice', text: 'Hello everyone.' }], t + 9000));
  assert.deepStrictEqual(out[1], { at: t + 2000, speaker: 'Bob', text: 'Hi there' });
  assert.strictEqual(out.length, 2);
});

test('foldCaptions splits a block Meet restarts, and flush drains the rest', () => {
  const st = { open: new Map(), done: new Set() };
  const long = 'a long monologue that goes on and on';
  assert.deepStrictEqual(foldCaptions(st, [{ id: '7', name: 'Ann', text: long }], 0), []);
  const cut = foldCaptions(st, [{ id: '7', name: 'Ann', text: 'and more' }], 1000);
  assert.deepStrictEqual(cut, [{ at: 0, speaker: 'Ann', text: long }]);
  const rest = foldCaptions(st, [{ id: '7', name: 'Ann', text: 'and more' }], 1500, true);
  assert.deepStrictEqual(rest, [{ at: 1000, speaker: 'Ann', text: 'and more' }]);
  assert.deepStrictEqual(foldCaptions(st, [], 2000, true), []);
});

test('foldCaptions: a block cleared on screen ends its turn and may start another', () => {
  const st = { open: new Map(), done: new Set() };
  foldCaptions(st, [{ id: '3', name: 'Ann', text: 'first turn' }], 0);
  const end = foldCaptions(st, [{ id: '3', name: 'Ann', text: '' }], 1000);
  assert.deepStrictEqual(end.map((u) => u.text), ['first turn']);
  foldCaptions(st, [{ id: '3', name: 'Ann', text: 'second turn' }], 2000);
  const rest = foldCaptions(st, [], 3000, true);
  assert.deepStrictEqual(rest.map((u) => u.text), ['second turn']);
  assert.strictEqual(foldCaptions(st, [{ id: '9', name: '', text: 'x' }], 4000, true)[0].speaker, '?');
});

test('captionHint: seconds since the recording started, monotonic, never negative', () => {
  const u = (at) => ({ at, speaker: 'Ann', text: 'hi' });
  assert.deepStrictEqual(captionHint(u(13_460), 10_000, 0), { offset_s: 3.5, speaker: 'Ann', text: 'hi' });
  assert.strictEqual(captionHint(u(9_000), 10_000, 0).offset_s, 0, 'before the start clamps to 0');
  assert.strictEqual(captionHint(u(12_000), 10_000, 3.5).offset_s, 3.5, 'out of order clamps to the previous line');
});

test('parseArgs rejects bad input, including a non-Meet URL', () => {
  assert.throws(() => parseArgs(['--out', '/tmp/a.wav']), /--url/);
  assert.throws(() => parseArgs(['--url', URL]), /--out/);
  assert.throws(() => parseArgs([...MIN, '--nope', '1']), /unknown argument/);
  assert.throws(() => parseArgs([...MIN, '--join-timeout', '0']), /positive number/);
  assert.throws(() => parseArgs(['--url', 'https://example.com/room', '--out', '/tmp/a.wav']), /meet\.google\.com/);
  assert.throws(() => parseArgs(['--url', 'http://meet.google.com/abc-defg-hij', '--out', '/tmp/a.wav']), /meet\.google\.com/);
});

test('bad arguments exit 2 with the usage on stderr', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'meet.js'), '--url', 'https://example.com/x', '--out', '/tmp/a.wav'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /usage: meet\.js/);
  assert.strictEqual(r.stdout, '');
});

test('meetingCode logs the code, never the rest of the URL', () => {
  assert.strictEqual(meetingCode(`${URL}?authuser=1&pwd=secret`), 'abc-defg-hij');
  assert.strictEqual(meetingCode('https://meet.google.com/lookup/xyz'), '(meeting)');
});

/** Run the page-side readState against a stubbed DOM. */
function stateOf(text, { leave = false, tiles = false, captions = '' } = {}) {
  const els = {
    '[data-participant-id]': tiles ? {} : null,
    '[role="region"][aria-label*="aption" i]': captions ? { innerText: captions } : null,
    '[aria-label*="Leave call" i]': leave ? {} : null,
  };
  global.document = { body: { innerText: text }, querySelector: (sel) => els[sel] || null };
  global.location = { host: 'meet.google.com' };
  try {
    return readState().state;
  } finally {
    delete global.document;
    delete global.location;
  }
}

test('readState classifies the Meet screens', () => {
  assert.strictEqual(stateOf("What's your name? Ask to join Other ways to join"), 'prejoin');
  assert.strictEqual(stateOf('Getting ready... confirm you are not a bot'), 'loading');
  assert.strictEqual(stateOf('Asking to be let in…', { leave: true }), 'lobby', 'the lobby has a Leave button too');
  assert.strictEqual(stateOf('Alice  Bob is asking to join', { leave: true }), 'admitted', 'an in-call notice is not the lobby');
  assert.strictEqual(stateOf('Alice NoteTaker', { leave: true }), 'admitted');
  assert.strictEqual(stateOf('No one responded to your request to join the call'), 'unanswered');
  assert.strictEqual(stateOf('Someone in the call denied your request to join'), 'denied');
  assert.strictEqual(stateOf("You can't join this video call"), 'blocked');
  assert.strictEqual(stateOf('Check your meeting code'), 'invalid');
  assert.strictEqual(stateOf("You've been removed from the meeting"), 'removed');
  assert.strictEqual(stateOf('The call has ended. Return to home screen'), 'ended');
  assert.strictEqual(stateOf('Alice: the call has ended', { leave: true, captions: 'Alice: the call has ended' }), 'admitted', 'caption speech is ignored');
  assert.strictEqual(stateOf('Alice: the call has ended', { leave: true, tiles: true }), 'admitted', 'chat text in the call is ignored');
  assert.strictEqual(stateOf("Alice You've been removed from the meeting", { leave: true, tiles: true }), 'admitted');
  assert.strictEqual(stateOf("You've been removed from the meeting", { leave: true }), 'removed', 'a lingering Leave button without tiles');
  assert.strictEqual(stateOf('Asking to be let in…', { leave: true, tiles: true }), 'lobby', 'a lobby self-preview tile');
  assert.strictEqual(stateOf('something else'), 'unknown');
});

test('otherNames drops the bot and treats no tiles as unknown', () => {
  assert.deepStrictEqual(otherNames({ tiles: 3, unnamed: 0, names: ['Alice', 'NoteTaker', 'Bob (You)', 'Carol'], self: [] }, 'NoteTaker'), ['Alice', 'Carol']);
  assert.deepStrictEqual(otherNames({ tiles: 1, unnamed: 0, names: ['Meet Bot'], self: ['Meet Bot'] }, 'NoteTaker'), []);
  assert.strictEqual(otherNames({ tiles: 0, names: [], self: [] }, 'NoteTaker'), null);
  assert.strictEqual(otherNames({ tiles: 2, unnamed: 2, names: [], self: [] }, 'NoteTaker'), null, 'tiles without name text');
  assert.strictEqual(otherNames({ tiles: 2, unnamed: 1, names: ['NoteTaker'], self: [] }, 'NoteTaker'), null, 'one nameless tile');
});

test('meetShouldStop: empty grace on a readable empty roster, never on an unknown one', () => {
  const base = { emptyGrace: 10, startedAt: 0, maxDuration: 3600 };
  let r = meetShouldStop({ ...base, others: [], aloneSince: null, now: 1000 });
  assert.deepStrictEqual(r, { reason: null, aloneSince: 1000 });
  r = meetShouldStop({ ...base, others: [], aloneSince: 1000, now: 11000 });
  assert.strictEqual(r.reason, 'empty_room');
  r = meetShouldStop({ ...base, others: ['Alice'], aloneSince: 1000, now: 11000 });
  assert.deepStrictEqual(r, { reason: null, aloneSince: null }, 'somebody back resets the grace');
  r = meetShouldStop({ ...base, others: null, aloneSince: null, now: 999999 });
  assert.strictEqual(r.reason, null, 'an unreadable roster is not an empty room');
  r = meetShouldStop({ ...base, others: ['Alice'], aloneSince: null, now: 3600 * 1000 });
  assert.strictEqual(r.reason, 'max_duration');
});

test('the fake mic is digital silence', () => {
  const w = silentWav(1);
  assert.strictEqual(w.toString('latin1', 0, 4), 'RIFF');
  assert.ok(w.subarray(44).every((b) => b === 0));
});

test('finalizeWav repairs placeholder sizes and reports the PCM bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-test-'));
  try {
    const f = path.join(dir, 'a.wav');
    const w = silentWav(1);
    w.writeUInt32LE(0xffffffff, 4); // what a killed writer leaves behind
    w.writeUInt32LE(0xffffffff, 40);
    fs.writeFileSync(f, w);
    assert.strictEqual(finalizeWav(f), 96000);
    const b = fs.readFileSync(f);
    assert.strictEqual(b.readUInt32LE(4), b.length - 8);
    assert.strictEqual(b.readUInt32LE(40), 96000);
    fs.writeFileSync(f, w.subarray(0, 44));
    assert.strictEqual(finalizeWav(f), 0, 'header only = empty');
    fs.writeFileSync(f, 'not a wav');
    assert.strictEqual(finalizeWav(f), 0);
    assert.strictEqual(finalizeWav(path.join(dir, 'missing.wav')), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- end to end against a fake Meet ------------------------------------------
// Runs meet.js's main() with a real Chromium, PulseAudio and parec, but serves a
// fake Meet page in place of meet.google.com (request interception, no network).
// The page plays a beeping tone the way Meet does — a remote WebRTC track played
// through WebAudio — so this proves the capture path: fake devices, the null
// sink, parec, the WAV. It also enforces the hard rule: the page refuses the bot
// (=> exit 3) if it knocks with the mic or camera on, or if a captured track can
// be re-enabled. Skipped where Chromium or pulseaudio is missing (the CI node
// job); runs in the Docker image:
//   docker run --rm --shm-size=512m --entrypoint node <image> --test meet.test.js

const FAKE_MEET = `<!doctype html><title>Meet</title><body><div id="ui"></div><script>
const ui = document.getElementById('ui');
const params = new URLSearchParams(location.search);
let mic = true, cam = true, tracks = [];
const refuse = (why) => { ui.innerHTML = "<p>You can't join this call</p><p>" + why + "</p>"; };
navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then((s) => {
  tracks = s.getTracks();
  tracks.forEach((t) => (t.enabled = true)); // what Meet does on "Turn on microphone"
});
function prejoin() {
  ui.innerHTML = '<p>What\\'s your name?</p><input aria-label="Your name">' +
    '<button id="m" aria-label="' + (mic ? 'Turn off microphone' : 'Turn on microphone') + '">m</button>' +
    '<button id="c" aria-label="' + (cam ? 'Turn off camera' : 'Turn on camera') + '">c</button>' +
    '<button id="j">Ask to join</button>';
  document.getElementById('m').onclick = () => { mic = !mic; prejoin(); };
  document.getElementById('c').onclick = () => { cam = !cam; prejoin(); };
  document.getElementById('j').onclick = () => {
    if (mic || cam) return refuse('knocked with mic/camera on');
    if (tracks.some((t) => t.enabled)) return refuse('a captured track is enabled');
    if (!document.querySelector('input').value) return refuse('no name');
    ui.innerHTML = '<p>Asking to be let in…</p><button aria-label="Leave call">x</button>';
    setTimeout(admit, 2000);
  };
}
async function admit() {
  ui.innerHTML = '<button aria-label="Leave call">x</button>' +
    '<div data-participant-id="a">Alice<br>more</div><div data-participant-id="b">NoteTaker</div>' +
    '<button id="cc" aria-label="Turn on captions">cc</button>';
  // Captions: Meet-like blocks (speaker + text), rewritten in place while the speaker talks.
  document.getElementById('cc').onclick = (e) => {
    e.target.setAttribute('aria-label', 'Turn off captions');
    const region = document.createElement('div');
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'Captions');
    ui.appendChild(region);
    const say = (name, text) => {
      const b = document.createElement('div');
      b.className = 'nMcdL';
      b.innerHTML = '<div class="NWpY1d">' + name + '</div><div class="ygicle">' + text + '</div>';
      region.appendChild(b);
      return b.querySelector('.ygicle');
    };
    const alice = say('Alice', 'Hello');
    setTimeout(() => (alice.textContent = 'Hello everyone'), 500);
    setTimeout(() => say('Bob', 'Hi Alice'), 1500);
  };
  const leave = Number(params.get('aliceLeavesAfter') || 0);
  if (leave) setTimeout(() => document.querySelector('[data-participant-id="a"]').remove(), leave * 1000);
  const src = new AudioContext();
  const osc = src.createOscillator();
  const gain = src.createGain();
  const dst = src.createMediaStreamDestination();
  osc.connect(gain).connect(dst);
  osc.start();
  setInterval(() => (gain.gain.value = gain.gain.value ? 0 : 0.5), 500);
  const a = new RTCPeerConnection(), b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  b.ontrack = (e) => {
    // Chromium only decodes a remote track while a media element plays it; a
    // muted one is the usual workaround (Meet has its own). Sound goes via WebAudio.
    const el = new Audio();
    el.muted = true;
    el.srcObject = new MediaStream([e.track]);
    el.play();
    const ctx = new AudioContext();
    ctx.createMediaStreamSource(new MediaStream([e.track])).connect(ctx.destination);
  };
  a.addTrack(dst.stream.getAudioTracks()[0], dst.stream);
  await a.setLocalDescription();
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription();
  await a.setRemoteDescription(b.localDescription);
}
setTimeout(prejoin, 500);
</script>`;

function canRunBrowser() {
  if (spawnSync('pulseaudio', ['--version']).error || spawnSync('parec', ['--version']).error) return false;
  try {
    return fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH || require('puppeteer').executablePath());
  } catch {
    return false;
  }
}

let fakePage = null; // the page main() drives, for tests that break it

/** Serve FAKE_MEET for meet.google.com on every page main() opens. */
function fakeMeet() {
  const puppeteer = require('puppeteer');
  const launch = puppeteer.launch.bind(puppeteer);
  puppeteer.launch = async (o) => {
    const browser = await launch(o);
    const [page] = await browser.pages();
    fakePage = page;
    await page.setRequestInterception(true);
    page.on('request', (r) =>
      r.url().startsWith('https://meet.google.com/') ? r.respond({ contentType: 'text/html', body: FAKE_MEET }) : r.abort(),
    );
    return browser;
  };
  return () => (puppeteer.launch = launch);
}

/** main() in-process with stdout captured; `during(out)` runs while it records. */
async function runMain(args, during) {
  const writes = [];
  const write = process.stdout.write;
  process.stdout.write = (s, ...rest) => (String(s).startsWith('{') ? writes.push(String(s)) : write.call(process.stdout, s, ...rest));
  try {
    const p = meet.main(args);
    if (during) await during();
    return { code: await p, stdout: writes.join('') };
  } finally {
    process.stdout.write = write;
  }
}

/** RMS of a 16-bit PCM WAV in dBFS. */
function wavDb(file) {
  const b = fs.readFileSync(file);
  const at = b.indexOf('data');
  let sum = 0;
  let n = 0;
  for (let i = at + 8; i + 1 < b.length; i += 2, n++) sum += (b.readInt16LE(i) / 32768) ** 2;
  return 20 * Math.log10(Math.sqrt(sum / n) || 1e-10);
}

const skip = canRunBrowser() ? false : 'needs Chromium + pulseaudio + parec (run in the Docker image)';

test('end to end: knocks muted, records the call audio, SIGTERM finalizes the WAV', { skip, timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-e2e-'));
  const restore = fakeMeet();
  try {
    const out = path.join(dir, 'job', 'audio.wav');
    const captions = path.join(dir, 'job', 'captions.jsonl');
    const { code, stdout } = await runMain(['--url', URL, '--out', out, '--join-timeout', '60', '--captions-out', captions], async () => {
      for (let i = 0; i < 300 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 6000)); // record ~6 s
      process.emit('SIGTERM', 'SIGTERM');
    });
    assert.strictEqual(code, 0);
    const res = JSON.parse(stdout);
    assert.strictEqual(res.out, out);
    assert.strictEqual(res.reason, 'signal');
    assert.deepStrictEqual(res.participants, ['Alice']);
    assert.ok(res.duration_s > 3, `duration ${res.duration_s}`);
    assert.strictEqual(res.tracks, undefined);
    assert.strictEqual(res.captions, captions);
    const hints = fs.readFileSync(captions, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(hints.map((h) => [h.speaker, h.text]), [['Alice', 'Hello everyone'], ['Bob', 'Hi Alice']]);
    assert.ok(hints[0].offset_s >= 0 && hints[1].offset_s >= hints[0].offset_s, `offsets ${hints.map((h) => h.offset_s)}`);
    const b = fs.readFileSync(out);
    assert.strictEqual(b.readUInt32LE(4), b.length - 8, 'header finalized');
    assert.strictEqual(b.readUInt32LE(24), RATE);
    assert.strictEqual(b.readUInt16LE(22), 1, 'mono');
    const db = wavDb(out);
    assert.ok(db > -30, `call audio captured: ${db.toFixed(1)} dBFS`);
  } finally {
    restore();
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('end to end: stops on its own once the room is empty', { skip, timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-e2e-'));
  const restore = fakeMeet();
  try {
    const out = path.join(dir, 'audio.wav');
    const { code, stdout } = await runMain(['--url', `${URL}?aliceLeavesAfter=8`, '--out', out, '--join-timeout', '60', '--empty-grace', '2']);
    assert.strictEqual(code, 0);
    const res = JSON.parse(stdout);
    assert.strictEqual(res.reason, 'empty_room');
    assert.strictEqual(res.captions, undefined, 'no --captions-out, no captions key');
    assert.deepStrictEqual(res.participants, ['Alice']);
  } finally {
    restore();
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('end to end: the Meet page dying mid-call is a truncated recording (exit 5)', { skip, timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-e2e-'));
  const restore = fakeMeet();
  try {
    const out = path.join(dir, 'audio.wav');
    const { code, stdout } = await runMain(['--url', URL, '--out', out, '--join-timeout', '60'], async () => {
      for (let i = 0; i < 300 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 2000));
      await fakePage.close();
    });
    assert.strictEqual(code, 5);
    assert.strictEqual(stdout, '');
  } finally {
    restore();
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

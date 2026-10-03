# Recording a Google Meet call

`meet.js` joins a Google Meet call as an anonymous guest, records the call
audio as a 16 kHz mono WAV and, optionally, writes Meet's live captions as
speaker hints. It is a library: the HTTP service described in
[architecture.md](architecture.md) calls `record()` in-process, and several
recordings may run at once in one process.

## API

```js
const { record, finalizeWav } = require('./meet.js');

const ac = new AbortController();
const res = await record({
  url: 'https://meet.google.com/abc-defg-hij',
  out: '/data/job/audio.wav',
  captionsOut: '/data/job/captions.jsonl', // optional: speaker hints
  displayName: 'NoteTaker',                // default
  joinTimeoutS: 1200,                      // default: lobby wait incl. re-knocks
  maxDurationS: 14400,                     // default
  emptyGraceS: 60,                         // default
  signal: ac.signal,                       // abort = stop gracefully
  onState: (s) => {},                      // 'waiting_in_lobby' | 'joined'
  log: (msg) => {},                        // default: timestamped stderr
});
// res = { durationS: 114.1, reason: 'empty_room', participants: ['Alice', 'Bob'],
//         captions: '/data/job/captions.jsonl' }
```

The parent directories of `out` and `captionsOut` are created if missing; both
files are truncated at the start. Bad arguments (not a `https://meet.google.com/`
URL, no `out`, `captionsOut` equal to `out`, a non-positive number) reject with
a `TypeError` before anything starts.

### Result

* `durationS` — length of the audio in the WAV, 0.1 s steps.
* `reason` — `empty_room` | `max_duration` | `signal` | `ended` (the meeting
  ended or the host ended it for everyone) | `removed` (the bot was removed).
* `participants` — names other than the bot seen on the video tiles at any
  point, deduped, first-seen order.
* `captions` — `captionsOut` when it got at least one line, else `undefined`.

There are never per-participant tracks: Meet sends a few mixed loudest-speaker
streams, no per-participant audio.

### Errors

`record()` rejects with an `Error` whose `code` is the job error code of
[architecture.md](architecture.md):

| code | meaning |
|------|---------|
| `not_admitted` | denied, guests refused, invalid code, a sign-in page, or `joinTimeoutS` passed; also an abort before joining |
| `recorder_failed` | browser launch / page failure, or the recording did not complete: the WAV is missing or empty, or the page, `parec` or PulseAudio died mid-call (the WAV is truncated but kept; `err.durationS` is its length) |

### Events and logs

`onState('waiting_in_lobby')` fires once, on the first knock (re-knocks do not
repeat it); `onState('joined')` fires at admission. `log` gets every progress
line; only the meeting code is logged, never the URL (it may carry a token).

### Stopping on request

Aborting `signal` stops gracefully: `parec` gets `SIGINT`, the WAV header is
finalized and the promise resolves with `reason: "signal"`. The library
installs no process signal handlers and never exits the process; the host maps
its own `SIGTERM` to aborting its runs.

### WAV header repair

`finalizeWav(file)` rewrites the RIFF and data sizes from the file length (a
writer killed mid-file leaves placeholders) and returns the PCM byte count — 0
for a missing, header-only or unparseable file. Crash recovery uses it on a WAV
whose writer died.

## Joining as a guest

No Google account. Chromium is launched with an English UI, a fake silent mic
and a fake black camera, prompts auto-accepted. On the prejoin screen the bot
types `displayName`, switches Meet's mic and camera toggles off (it never
knocks while either reads on), clicks *Ask to join* and waits in the lobby
until a human admits it.

Knocking on a meeting nobody has opened yet ends in "No one responded to your
request". The bot re-knocks (reload + *Ask to join*) every 60 s, logging
`state: waiting_in_lobby (no one responded; re-knock N)`, until admitted or
`joinTimeoutS` passes (`not_admitted`).

## Capturing the audio

Meet plays call audio only to a participant that has media devices, so the bot
has fake ones: a silent WAV as the mic and one black frame as the camera. Both
toggles are switched off before joining and re-checked every 10 s in the call,
and every captured track is disabled and locked page-side, so **nothing is
ever sent into the call**.

Each job starts its own PulseAudio in a fresh temp dir (concurrent jobs never
share one) whose only output is a null sink. Chromium plays the call into it
and `parec` records the sink's monitor into `out`, starting at admission.
`parec` is stopped with `SIGINT`, which writes the final WAV header; the header
is re-checked afterwards regardless. Both children are killed on every exit
path. The image needs `chromium`, `pulseaudio` and `pulseaudio-utils`, and the
container needs `shm_size` of at least 512 MB.

Page-side capture (WebAudio/MediaRecorder on the RTP tracks, tab capture) does
not work on Meet: it decodes audio in its own graph.

## Speaker hints (captions)

With `captionsOut`, after admission the bot turns Meet's live captions on
(the toolbar button, else the `c` shortcut — visible to participants) and
writes each finished utterance as one JSON line:

```json
{"offset_s": 3.5, "speaker": "Alice", "text": "Hello everyone"}
```

`offset_s` is seconds since the recording started, monotonic, in 0.1 s steps.
The caption language is left as the meeting has it: the text is only a hint,
the transcript comes from the audio. Captions that cannot be turned on are
logged and the recording goes on.

## Stopping

The record phase polls every 2 s and stops on the first of:

* nobody but the bot on the roster continuously for `emptyGraceS` seconds.
  The roster is the names on the video tiles (and the people panel when open),
  bot excluded. When no tile or no name can be read the roster counts as
  unknown, never as empty, so a Meet markup change cannot cut a call short — it
  falls back to `maxDurationS`;
* `maxDurationS` reached;
* the meeting ended (`ended`) or the bot was removed (`removed`);
* the abort signal.

The Meet page closing or crashing, or `parec`/PulseAudio exiting mid-call, is
`recorder_failed`.

## The Meet DOM block

Every Meet DOM read and phrase lives in one page-side block in `meet.js`
(`readState`, `prejoin`, `clickJoin`, `readNames`, `captionsOn`,
`readCaptions`). Google changes Meet's markup without notice, so a Meet UI
change stays a fix in that block; it carries the date it was last checked
against live Meet.

## Tests

```bash
PUPPETEER_SKIP_DOWNLOAD=1 npm ci
npm test
```

Offline unit tests cover argument checks, Meet state matching against a
stubbed DOM, the stop rule, caption folding and WAV finalization. Four
end-to-end tests (one runs two jobs at once) call `record()` with real Chromium, PulseAudio and `parec`
against a fake Meet page served by request interception (no network): the page
plays a tone over a WebRTC track the way Meet does and refuses the bot if it
knocks with the mic or camera on or a captured track can be re-enabled. They
skip without Chromium/PulseAudio and run in the Docker image, as CI does:

```bash
docker build -t meet-recorder .
docker run --rm --shm-size=512m --entrypoint node meet-recorder --test meet.test.js
```

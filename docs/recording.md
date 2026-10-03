# Recording a Google Meet call

`meet.js` joins a Google Meet call as an anonymous guest, records the call
audio as a 16 kHz mono WAV and, optionally, writes Meet's live captions as
speaker hints. Today it is a CLI; the HTTP service described in
[architecture.md](architecture.md) wraps the same code.

## Usage

```bash
node meet.js --url <https://meet.google.com/xxx-xxxx-xxx> --out <path/audio.wav> \
  [--join-timeout <sec, default 1200>] \
  [--max-duration <sec, default 14400>] \
  [--empty-grace <sec, default 60>] \
  [--display-name <str, default NoteTaker>] \
  [--tracks-dir <dir>] \  # accepted and ignored
  [--captions-out <path/captions.jsonl>]
```

The parent directories of `--out` and `--captions-out` are created if missing;
both files are truncated at startup.

### stdout

Exactly one JSON line, on success only:

```json
{"out":"/data/audio.wav","duration_s":114.1,"reason":"empty_room","participants":["Alice","Bob"],"captions":"/data/captions.jsonl"}
```

* `out` — absolute path of the WAV.
* `duration_s` — length of the audio in the WAV.
* `reason` — `empty_room` | `max_duration` | `signal` | `ended` (the meeting
  ended or the host ended it for everyone) | `removed` (the bot was removed).
* `participants` — names other than the bot seen on the video tiles at any
  point, deduped, first-seen order.
* `captions` — present only when `--captions-out` was given and the file got
  at least one line.

There is never a `tracks` key: Meet sends a few mixed loudest-speaker streams,
no per-participant audio.

### stderr

Every log line is prefixed with an ISO timestamp. Only the meeting code is
logged, never the URL (it may carry a token). The milestones are
`joining room <meeting-code> as <name>`, `state: waiting_in_lobby`,
`state: joined`, `stopping: <reason>` and `wrote <bytes> bytes in <s>s, <n> participant(s)`.

### Exit codes

| code | meaning |
|------|---------|
| 0 | recorded OK; the WAV exists and is non-empty |
| 2 | bad arguments (usage on stderr) |
| 3 | not admitted: denied, guests refused, invalid code, a sign-in page, or `--join-timeout` passed; also a signal before joining |
| 4 | browser launch / page failure |
| 5 | the recording did not complete: the WAV is missing or empty, or the page, `parec` or PulseAudio died mid-call (the WAV is truncated but kept) |

### Signals

`SIGTERM` / `SIGINT` stop gracefully: the WAV is finalized, the JSON line is
printed with `"reason":"signal"` and the process exits 0. A second signal exits
immediately.

## Joining as a guest

No Google account. Chromium is launched with an English UI, a fake silent mic
and a fake black camera, prompts auto-accepted. On the prejoin screen the bot
types `--display-name`, switches Meet's mic and camera toggles off (it never
knocks while either reads on), clicks *Ask to join* and waits in the lobby
until a human admits it.

Knocking on a meeting nobody has opened yet ends in "No one responded to your
request". The bot re-knocks (reload + *Ask to join*) every 60 s, logging
`state: waiting_in_lobby (no one responded; re-knock N)`, until admitted or
`--join-timeout` passes (exit 3).

## Capturing the audio

Meet plays call audio only to a participant that has media devices, so the bot
has fake ones: a silent WAV as the mic and one black frame as the camera. Both
toggles are switched off before joining and re-checked every 10 s in the call,
and every captured track is disabled and locked page-side, so **nothing is
ever sent into the call**.

Each job starts its own PulseAudio in a fresh temp dir (concurrent jobs never
share one) whose only output is a null sink. Chromium plays the call into it
and `parec` records the sink's monitor into `--out`, starting at admission.
`parec` is stopped with `SIGINT`, which writes the final WAV header; the header
is re-checked afterwards regardless. Both children are killed on every exit
path. The image needs `chromium`, `pulseaudio` and `pulseaudio-utils`, and the
container needs `shm_size` of at least 512 MB.

Page-side capture (WebAudio/MediaRecorder on the RTP tracks, tab capture) does
not work on Meet: it decodes audio in its own graph.

## Speaker hints (captions)

With `--captions-out`, after admission the bot turns Meet's live captions on
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

* nobody but the bot on the roster continuously for `--empty-grace` seconds.
  The roster is the names on the video tiles (and the people panel when open),
  bot excluded. When no tile or no name can be read the roster counts as
  unknown, never as empty, so a Meet markup change cannot cut a call short — it
  falls back to `--max-duration`;
* `--max-duration` reached;
* the meeting ended (`ended`) or the bot was removed (`removed`);
* `SIGTERM` / `SIGINT`.

The Meet page closing or crashing, or `parec`/PulseAudio exiting mid-call, is
exit 5.

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

Offline unit tests cover argument parsing, Meet state matching against a
stubbed DOM, the stop rule, caption folding and WAV finalization. Three
end-to-end tests run `main()` with real Chromium, PulseAudio and `parec`
against a fake Meet page served by request interception (no network): the page
plays a tone over a WebRTC track the way Meet does and refuses the bot if it
knocks with the mic or camera on or a captured track can be re-enabled. They
skip without Chromium/PulseAudio and run in the Docker image, as CI does:

```bash
docker build -t meet-recorder .
docker run --rm --shm-size=512m --entrypoint node meet-recorder --test meet.test.js
```

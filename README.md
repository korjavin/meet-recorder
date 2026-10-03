# meet-recorder

Records a Google Meet call on request: joins as an anonymous guest (headless
Chromium with fake media devices), records the call audio as a 16 kHz mono WAV
through a per-job PulseAudio null sink, and captures live captions as speaker
hints.

* [docs/architecture.md](docs/architecture.md) — the service contract: HTTP
  API, events, artifacts, failure handling.
* [docs/recording.md](docs/recording.md) — how a Meet call is joined and
  recorded.

```bash
PUPPETEER_SKIP_DOWNLOAD=1 npm ci && npm test
docker build -t meet-recorder .
```

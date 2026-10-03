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

## API

The contract is [docs/architecture.md](docs/architecture.md) §3; in short:

| request | |
|---|---|
| `POST /recordings` `{id, url, callback_url, meta?, display_name?, join_timeout_s?, max_duration_s?, empty_grace_s?}` | `202` started · `200` already exists · `400` · `401` · `422` URL is not `https://meet.google.com/<code>` |
| `GET /recordings/{id}` | `200` job record · `404` |
| `GET /health` | `200 {"status":"ok"}`, unsigned |

Every other request, and every event the service posts to `callback_url`
(`recording.waiting_admission`, `recording.started`, `recording.finished`,
`recording.failed`), carries
`x-recorder-signature: sha256=<hex HMAC-SHA256(raw body, RECORDER_SECRET)>`;
a `GET` signs the empty body. Recordings land in `DATA_DIR/<id>/audio.wav`
(+ `captions.jsonl`) and are never deleted.

## Running

`node server.js` serves the HTTP API (the image's entrypoint). Configuration
is env-only, read in `config.js`; [.env.example](.env.example) lists it all:

| variable | default | |
|---|---|---|
| `RECORDER_SECRET` | — | required; HMAC key for requests and events |
| `DATA_DIR` | `/data/meet` | one directory per job |
| `PORT` | `8080` | |
| `BOT_DISPLAY_NAME` | `NoteTaker` | |
| `JOIN_TIMEOUT_S` | `1200` | a link sent before the call keeps knocking |
| `MAX_DURATION_S` | `14400` | |
| `EMPTY_GRACE_S` | `60` | |
| `LOG_LEVEL` | `info` | `warn` / `error` drop per-job progress lines |

`docker-compose.yml` also reads `RECORDINGS_VOLUME` (default `recordings`) and
`TRAEFIK_NETWORK_NAME` (default `traefik`), and fixes `DATA_DIR=/data/meet`.

## Deploy

The service is internal: no published ports and no Traefik route. The
orchestrator reaches it as `http://meet-recorder:8080` over a shared external
Docker network.

1. Once per host: `docker volume create recordings` (the shared recordings
   volume, docs/architecture.md §6; another name works via
   `RECORDINGS_VOLUME`), and make sure the external network named by
   `TRAEFIK_NETWORK_NAME` exists.
2. In Portainer, add a git stack from this repository on the **`deploy`**
   branch, compose path `docker-compose.yml`, and set at least
   `RECORDER_SECRET` in the stack environment (the same value the orchestrator
   uses). Enable its redeploy webhook.
3. In the GitHub repository, add the secret `PORTAINER_REDEPLOY_HOOK` with that
   webhook URL.

Every push to `master` then runs `.github/workflows/deploy.yml`: it builds and
pushes `ghcr.io/<owner>/meet-recorder:<sha>` (and `:latest`), rewrites the image tag on the
`deploy` branch and calls the webhook (skipped when the secret is unset). The
host must be able to pull the GHCR package (public, or a registry login in
Portainer).

To run it by hand instead: `cp .env.example .env`, edit it, `docker compose up -d`.

## Smoke test

Start a Meet call in a browser and keep it open: the bot joins as a guest and
**someone in the call must admit it**. Then, on the host:

```bash
SECRET=...        # RECORDER_SECRET of the stack
NET=traefik       # TRAEFIK_NETWORK_NAME
ID=smoke-$(date +%s)
BODY=$(printf '{"id":"%s","url":"https://meet.google.com/abc-defg-hij","callback_url":"http://receiver.example:8080/events"}' "$ID")
sign() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //'; }

docker run --rm --network "$NET" curlimages/curl -s \
  -H 'content-type: application/json' \
  -H "x-recorder-signature: sha256=$(sign "$BODY")" \
  -d "$BODY" http://meet-recorder:8080/recordings   # {"id":"smoke-…","state":"joining"}

# Poll the job (a GET signs the empty body): joining → recording → finished.
docker run --rm --network "$NET" curlimages/curl -s \
  -H "x-recorder-signature: sha256=$(sign '')" \
  "http://meet-recorder:8080/recordings/$ID"
```

Use your meeting code in `url`, and as `callback_url` any receiver on that
network that answers `2xx`; until one does, the guaranteed events wait in
`DATA_DIR/<id>/outbox/` and are retried. Leave the call (or let the room stay
empty for `EMPTY_GRACE_S`) and the recording is in the recordings volume at
`meet/<id>/audio.wav`; `docker logs` on the container shows progress.

FROM node:22-bookworm-slim
# chromium joins the call; pulseaudio + pulseaudio-utils (parec): every job
# starts its own null-sink PulseAudio and records it with parec. Nothing
# autospawns PulseAudio.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium pulseaudio pulseaudio-utils \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.js ./

# ponytail: runs as root — Chromium already gets --no-sandbox; a non-root user
# is a later polish. The entrypoint becomes the HTTP server once it exists.
ENTRYPOINT ["node", "meet.js"]

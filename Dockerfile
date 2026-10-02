# syntax=docker/dockerfile:1

# yt-dlp is REQUIRED. The pure-JS @distube/ytdl-core fallback no longer
# understands YouTube's current player response and fails with
# "Failed to find any playable formats", so a container without this binary
# can show metadata (via oEmbed) but cannot play a single frame.
FROM node:22-bookworm-slim

# ffmpeg lets yt-dlp merge separate video/audio streams when a muxed
# progressive format is unavailable, and is required by some extractors.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install yt-dlp as the official standalone binary, so the resolver's ./bin
# lookup finds it without any environment variable.
#
# NOT via pip: node:*-slim ships without pip, so `python3 -m pip install` dies
# with "No module named pip" and the whole image build fails. The standalone
# binary is self-contained and needs no Python at runtime.
RUN mkdir -p /app/bin \
 && curl -fsSL -o /app/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" \
 && chmod 0755 /app/bin/yt-dlp \
 && /app/bin/yt-dlp --version

# Dependencies first so code edits do not invalidate the layer cache.
#
# `--ignore-scripts` is deliberate: postinstall runs
# scripts/prepare-runtime.js, which imports server/install.js - and the source
# tree is not copied yet at this point in the build. The yt-dlp binary is
# already vendored above, so there is nothing for that hook to do in the image.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts || npm install --omit=dev --ignore-scripts

COPY . .

ENV NODE_ENV=production \
    PORT=5173 \
    HOST=0.0.0.0 \
    MAX_QUALITY=1080 \
    YTDLP_PATH=/app/bin/yt-dlp

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5173)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
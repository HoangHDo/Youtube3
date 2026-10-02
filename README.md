# ⚡ CYBERSTREAM

A Tesla-dashboard-style web player that streams any public YouTube video in the
browser. Paste a URL (or a bare video ID) into the top bar, hit **LOAD**, and it
plays — with seeking, quality selection, a queue, history and a suggested feed.

![stack](https://img.shields.io/badge/node-%E2%89%A518-informational) ![deps](https://img.shields.io/badge/runtime_dependencies-1-informational)

---

## Quick start

```bash
npm install
npm run doctor   # checks for a stream resolver and tells you what to do
npm start        # http://localhost:5173
```

`npm run doctor` is the important one. Video playback needs a **stream
resolver**, and the app is useless without one. Install either:

```bash
winget install yt-dlp.yt-dlp     # Windows
brew install yt-dlp              # macOS
pip install -U yt-dlp            # any platform with Python
# ...or the pure-JS fallback, no binary needed:
npm install @distube/ytdl-core
```

Then run `npm start` and open <http://localhost:5173>.

---

## How it works

```
browser ──POST /api/resolve──▶  Express  ──yt-dlp -J──▶  YouTube
   │                            │                        (returns signed
   │                            │                         googlevideo URLs)
   │                            ▼
   ├──GET /api/hls?s=…──▶  playlist is fetched, every URI rewritten
   │                            │
   └──GET /api/proxy?s=…──▶  byte-range relay, 206 + Content-Range
```

Four ideas do all the work:

**1. The browser never talks to YouTube.** YouTube's media URLs are
IP-locked, signed and short-lived, so a `<video src="https://…googlevideo…">`
tag cannot work. The server resolves them and hands the browser same-origin
`/api/proxy?s=…` links instead.

**2. Those links are signed and allow-listed.** Every proxy URL carries an
HMAC over the upstream URL plus an expiry, so `/api/proxy` cannot be used as an
open proxy or an SSRF gadget — a forged or stale link is rejected before any
network call, and the host must be on the allow-list even when the signature is
valid.

**3. Seeking is real seeking.** The proxy forwards `Range` / `If-Range`
upstream and mirrors the `206` back. Without that, the player would be stuck at
whatever byte the first response happened to contain.

**4. Playback degrades gracefully.** In order of preference:

| Source | When it is used | Needs |
| --- | --- | --- |
| Progressive MP4 | default, up to 720p | nothing — a `<video>` tag plays it |
| HLS | above 720p, or no muxed format exists | hls.js (CDN) outside Safari |
| oEmbed | last resort, metadata only | nothing — but **not playable** |

If every resolver fails the UI says so explicitly rather than showing a black
rectangle.

### Resolution pipeline

`server/resolver.js` tries `yt-dlp` → `ytdl-core` → oEmbed and uses whichever
answers first. Results are cached (the signed URLs expire), and concurrent
requests for the same video collapse into a single upstream call. Every failed
attempt is logged server-side — a silent fall back to oEmbed means *something
broke*, and the health endpoint reports which resolver is actually live.

---

## Deploying

### Render.com (one click)

Push the repo, then **New → Blueprint** and point it at this repository.
`render.yaml` tells Render to build with the included `Dockerfile`, which bakes
yt-dlp into the image and sets `YTDLP_PATH` for you.

### Any Docker host

```bash
docker build -t cyberstream .
docker run -d -p 5173:5173 -e PROXY_SECRET="$(openssl rand -hex 32)" cyberstream
```

### Plain Node hosts (no Dockerfile)

If your platform builds with its own Node image, the app provisions yt-dlp
itself: at install (`postinstall`) and again at boot, it downloads the official
standalone binary into `./bin/yt-dlp`, and the resolver finds it there. First
boot is slower because of the ~18 MB download.

Disable with `YTDLP_AUTOINSTALL=0`.

### Diagnosing a live deployment

```bash
curl https://your-site.onrender.com/api/health
```

```json
{ "resolver": { "ytdlp": "2026.08.19", "ytdlpBin": "/app/bin/yt-dlp" } }   <- healthy
{ "resolver": { "ytdlp": null, "ytdlpError": "spawn yt-dlp ENOENT" } }     <- broken
```

`ytdlp: null` with `ENOENT` means the binary is missing — the UI will say
"No stream available" because the only thing left is unplayable oEmbed
metadata. If `ytdlp` reports a version but playback still fails, it is almost
always YouTube refusing the datacenter IP; check the container log for
`[resolver] <id>: ytdlp failed - ...` and try `YTDLP_PLAYER_CLIENT=tv,web_safari`.

### Why yt-dlp matters so much

This is the single most common deployment failure, so it is worth being blunt:
**the pure-JS `@distube/ytdl-core` fallback no longer works.** It fails with
`Failed to find any playable formats` against current YouTube responses. A
server without the yt-dlp binary can still show title, thumbnail and duration
(via oEmbed) but cannot play a single frame — which is exactly the
"No stream available" screen. `npm run doctor` reports it as a warning, and the
settings panel shows it as `unreliable` rather than pretending otherwise.

The resolver searches, in order: `$YTDLP_PATH` → `./bin/yt-dlp` (how the Docker
image vendors it) → `yt-dlp` on `PATH`. Whichever answers `--version` first is
the binary that gets used.

### If it says "confirm you're not a bot"

YouTube blocks datacenter and cloud IP ranges. `Sign in to confirm you're not a
bot` is an IP reputation block from YouTube, not an application bug — the app is
working correctly and the request never reaches a playable response. Render,
Railway, Fly and most shared hosts are affected.

Verified working, in order of preference:

1. **Run the server on your own machine.** A residential IP is not blocked. This
   is what actually fixes it.
2. **Route yt-dlp through a proxy** with a clean or residential IP:
   ```bash
   YTDLP_PROXY=socks5://user:pass@host:1080
   ```
   Note this only affects resolution. The media relay fetches from your
   server's IP, which YouTube also polices for bandwidth.
3. **Use cookies**, which can satisfy the check on some IPs:
   ```bash
   YTDLP_COOKIES=/path/cookies.txt
   ```

Trying different `YTDLP_PLAYER_CLIENT` values is worth one attempt, but it does
not defeat an IP-level block. `/api/health` stays green in this state, and
`/api/resolve` reports `blocked: "youtube_bot_check"` so you can confirm it.

### Cloud IPs need a player client

Datacenter and cloud IPs are frequently served a bot-check or consent page
instead of the player response, which breaks resolution on hosted instances.
`YTDLP_PLAYER_CLIENT` (default `default,android,web`) makes yt-dlp impersonate
browser clients and is what makes hosted deployments work in practice.

### Environment variables on a host

Set these in your dashboard — **not** in a committed `.env`:

| Variable | Why |
| --- | --- |
| `PROXY_SECRET` | **Set it.** Otherwise proxy links die on every restart. |
| `YTDLP_PATH` | Only if not using the bundled Dockerfile. |
| `YTDLP_PLAYER_CLIENT` | Usually leave at the default. |
| `YTDLP_COOKIES_FROM_BROWSER` | Only for age-gated / region-locked videos. |
| `MAX_QUALITY` | Server-wide ceiling. |

`data/` is a volume-less local directory, so history and saved videos reset on
redeploy. That is fine for a dashboard; mount a volume if you need them to
persist.

---

## Project layout

```
Dockerfile      bakes yt-dlp into a node:22-slim image
render.yaml     Render blueprint (blueprint deploy = one click)
server/
  index.js      Express app, routes, static serving
  install.js    downloads yt-dlp when the host does not have it
  resolver.js   yt-dlp / ytdl-core / oEmbed cascade + cache
  youtube.js    URL parsing and format selection  (pure, unit tested)
  sign.js       HMAC-signed proxy URLs            (pure, unit tested)
  stream.js     byte-range proxy + HLS rewriting
  catalog.js    curated feed and Atom feed parsing
  store.js      history / saved / preferences (data/state.json)
  config.js     env loading and the proxy host allow-list
public/
  index.html    the dashboard shell
  css/style.css the whole design system
  js/
    app.js        wiring and state
    player.js     <video> wrapper, source switching
    player-hls.js lazy hls.js loading
    catalog.js    suggested feed
    library.js    queue / history / saved
    api.js        fetch wrapper
    ui.js         toasts, status pill, icons
test/core.test.js
```

---

## Configuration

Everything is optional; copy `.env.example` to `.env` to change it.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `5173` | |
| `MAX_QUALITY` | `1080` | Hard ceiling. The server never hands out more. |
| `PROXY_SECRET` | random per boot | **Set this in production**, or links die on restart. |
| `CACHE_TTL_MS` | `300000` | How long resolved stream URLs are reused. |
| `UPSTREAM_UA` | desktop Chrome | |
| `YTDLP_PATH` | `yt-dlp` | Full path to the binary if it is not on `PATH`. |
| `YTDLP_COOKIES` | — | `--cookies FILE`, for age/region gated videos. |
| `YTDLP_COOKIES_FROM_BROWSER` | — | e.g. `chrome` |
| `YTDLP_PROXY` | — | |

---

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | resolver status, cache size, version |
| `POST` | `/api/resolve` | `{url}` → metadata + signed stream links |
| `GET` | `/api/video/:id` | same, by id |
| `GET` | `/api/preview` | metadata only, for a quick lookup |
| `GET` | `/api/catalog` | curated list, or an Atom feed via `?source=feed&url=` |
| `GET` | `/api/proxy` | media relay, `?s=<signed>` |
| `GET` | `/api/hls` | playlist relay, URIs rewritten, `?s=<signed>` |
| `GET` | `/api/thumb` | thumbnail relay, `?v=<id>&k=<size>` |
| `GET`/`PUT` | `/api/state`, `/api/state/*` | history, saved, preferences |
| `POST` | `/api/admin/cache/clear` | drop the resolve cache |
| `POST` | `/api/admin/resolver/refresh` | re-probe for `yt-dlp` |

---

## Keyboard

| Key | Action |
| --- | --- |
| `Space` / `K` | play / pause (or click the video) |
| `←` `→` | skip 10s |
| `N` / `P` | next / previous in queue |
| `S` | save |
| `T` | theater mode |
| `F` | fullscreen |
| `L` | picture-in-picture |
| `M` | mute |
| `/` | focus catalog search |
| `Esc` | dismiss error |

---

## Tests

```bash
npm test
```

17 tests covering URL parsing, signature verification (including tampering,
expiry and open-proxy/SSRF rejection), format selection, playlist rewriting,
and the quality-ceiling logic — plus one live end-to-end resolve that skips
itself when there is no network or no `yt-dlp`.

---

## Legal note

This tool is for personal use with videos you have the right to watch. It does
not circumvent DRM, and it does not bypass YouTube's paywalls or age gates.
Respect the terms of service of whatever content you point it at, and the
copyright of the people who made it.

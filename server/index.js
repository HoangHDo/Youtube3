import express from 'express';
import fs from 'node:fs';
import { config } from './config.js';
import { fetchCatalogFeed, localCatalog } from './catalog.js';
import { cacheStats, clearCache, probeYtdlp, resolveVideo, resetYtdlpProbe } from './resolver.js';
import { proxyMedia, proxyPlaylist } from './stream.js';
import * as store from './store.js';
import { isValidVideoId, parseVideoId, thumbnailUrl } from './youtube.js';

const app = express();
app.disable('x-powered-by');

app.use(express.json({ limit: '256kb' }));

// The app is same-origin, but a permissive policy keeps the API usable from a
// separately hosted front end during development.
app.use((req, res, next) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, range');
  res.setHeader('access-control-expose-headers', 'content-length, content-range, accept-ranges');
  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
    res.status(204).end();
    return;
  }
  next();
});

/** Wrap async handlers so rejections reach the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function fail(res, status, code, message, extra = {}) {
  res.status(status).json({ error: code, message, ...extra });
}

function requireVideoId(value) {
  const id = parseVideoId(value);
  if (!id) return null;
  return isValidVideoId(id) ? id : null;
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

app.get(
  '/api/health',
  wrap(async (_req, res) => {
    const ytdlp = await probeYtdlp();
    res.json({
      ok: true,
      name: 'cyberstream',
      version: '1.0.0',
      uptimeSeconds: Math.round(process.uptime()),
      maxQuality: config.maxQuality,
      resolver: {
        ytdlp: ytdlp.ok ? ytdlp.version : null,
        ytdlpError: ytdlp.ok ? undefined : ytdlp.error,
        ytdlCore: true, // presence is probed lazily on first resolve
      },
      cache: cacheStats(),
      signedLinksEphemeral: config.proxySecretIsEphemeral,
    });
  }),
);

/**
 * Resolve anything the user pasted - a URL or a bare id - into metadata plus
 * same-origin stream links. This is the endpoint the LOAD button hits.
 */
const resolveHandler = wrap(async (req, res) => {
  const input = req.method === 'POST' ? req.body?.url ?? req.body?.id : req.params.id;

  const id = requireVideoId(input);
  if (!id) {
    fail(
      res,
      400,
      'bad_video_reference',
      'That does not look like a YouTube URL or video ID.',
      { received: String(input ?? '').slice(0, 120) },
    );
    return;
  }

  const quality = req.query.quality ?? req.body?.quality ?? store.getPreferences().quality;
  const refresh = req.query.refresh === '1' || req.body?.refresh === true;

  try {
    const video = await resolveVideo(id, { quality, refresh });
    if (video.playable) store.pushHistory(video);
    res.json(video);
  } catch (error) {
    fail(res, error.status || 502, 'resolve_failed', error.message, {
      detail: error.detail,
    });
  }
});

app.post('/api/resolve', resolveHandler);
app.get('/api/video/:id', resolveHandler);

/**
 * Fast metadata-only lookup, used to preview a pasted URL before loading it.
 * Falls back to oEmbed so it still answers when the resolvers are unavailable.
 */
app.get(
  '/api/preview',
  wrap(async (req, res) => {
    const id = requireVideoId(req.query.url);
    if (!id) {
      fail(res, 400, 'bad_video_reference', 'Not a YouTube URL or video ID.');
      return;
    }
    try {
      const video = await resolveVideo(id, { quality: 144 });
      res.json({
        id: video.id,
        title: video.title,
        author: video.author,
        duration: video.duration,
        thumbnail: video.thumbnail || thumbnailUrl(id),
        playable: video.playable,
        source: video.source,
      });
    } catch (error) {
      fail(res, error.status || 502, 'preview_failed', error.message);
    }
  }),
);

/** Suggested feed. `source=feed&url=...` swaps in a user-supplied Atom feed. */
app.get(
  '/api/catalog',
  wrap(async (req, res) => {
    const source = String(req.query.source || 'local');
    const url = String(req.query.url || '').trim();
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 24, 60);

    if (source !== 'local') {
      if (!/^https?:\/\//i.test(url)) {
        fail(res, 400, 'bad_feed', 'A feed URL must start with http:// or https://');
        return;
      }
      try {
        const entries = await fetchCatalogFeed(url, { limit });
        res.json({ source: 'feed', feed: url, items: entries });
        return;
      } catch (error) {
        // Never let a dead feed blank out the dashboard.
        res.json({
          source: 'local',
          feed: url,
          warning: `Feed unavailable (${error.message}); showing the local catalog.`,
          items: localCatalog().slice(0, limit),
        });
        return;
      }
    }

    res.json({ source: 'local', items: localCatalog().slice(0, limit) });
  }),
);

/**
 * Same-origin thumbnail relay.
 *
 * i.ytimg.com sends no CORS headers, so the browser cannot read a thumbnail
 * into a canvas (the stage tint) and the request fails outright. Serving
 * thumbnails from our own origin fixes both, and means the UI still renders
 * thumbnails on a network that only allows localhost.
 *
 * The upstream URL is rebuilt from a validated id plus an allow-listed size,
 * so this is not a general-purpose image proxy.
 */
const THUMB_KINDS = new Set(['default', 'mqdefault', 'hqdefault', 'sddefault', 'maxresdefault']);

app.get('/api/thumb', (req, res) => {
  const id = String(req.query.v || '');
  const kind = String(req.query.k || 'hqdefault');

  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
    fail(res, 400, 'bad_video_id', 'Not a video ID.');
    return;
  }
  if (!THUMB_KINDS.has(kind)) {
    fail(res, 400, 'bad_thumb_kind', 'Unsupported thumbnail size.');
    return;
  }

  // maxresdefault 404s for videos without a 4K still; fall back gracefully.
  const upstream = `https://i.ytimg.com/vi/${id}/${kind}.jpg`;
  res.setHeader('cache-control', 'public, max-age=86400');

  fetch(upstream, { headers: { 'user-agent': config.userAgent } })
    .then((up) => (up.ok ? up : null))
    .then(async (up) => {
      if (!up) {
        if (kind === 'maxresdefault') {
          // Retry once at the always-present size.
          const fallback = await fetch(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, {
            headers: { 'user-agent': config.userAgent },
          });
          if (!fallback.ok) {
            res.status(404).end();
            return;
          }
          res.setHeader('content-type', fallback.headers.get('content-type') || 'image/jpeg');
          res.setHeader('content-length', fallback.headers.get('content-length') || '');
          res.end(Buffer.from(await fallback.arrayBuffer()));
          return;
        }
        res.status(404).end();
        return;
      }
      res.setHeader('content-type', up.headers.get('content-type') || 'image/jpeg');
      res.setHeader('content-length', up.headers.get('content-length') || '');
      res.end(Buffer.from(await up.arrayBuffer()));
    })
    .catch(() => {
      if (!res.headersSent) res.status(502);
      res.end();
    });
});

/* -------- media proxy -------- */

app.get('/api/proxy', proxyMedia);
app.get('/api/hls', proxyPlaylist);

/* -------- persistent state -------- */

app.get('/api/state', (_req, res) => {
  res.json({
    history: store.getState().history,
    saved: store.getState().saved,
    preferences: store.getPreferences(),
  });
});

app.put(
  '/api/state/preferences',
  wrap(async (req, res) => {
    res.json(store.updatePreferences(req.body || {}));
  }),
);

app.put(
  '/api/state/history',
  wrap(async (req, res) => {
    if (req.body?.action === 'clear') return res.json(store.clearHistory());
    if (req.body?.action === 'remove' && req.body.id) {
      return res.json(store.removeHistory(String(req.body.id)));
    }
    fail(res, 400, 'bad_request', 'action must be "clear" or "remove"');
    return undefined;
  }),
);

app.put(
  '/api/state/saved',
  wrap(async (req, res) => {
    if (req.body?.action === 'remove' && req.body.id) {
      return res.json(store.removeSaved(String(req.body.id)));
    }
    if (req.body?.action === 'reset') return res.json(store.resetState());
    fail(res, 400, 'bad_request', 'action must be "remove" or "reset"');
    return undefined;
  }),
);

/** Record a play - keeps history/saved in sync with what the user watched. */
app.post(
  '/api/state/watch',
  wrap(async (req, res) => {
    const id = requireVideoId(req.body?.id);
    if (!id) {
      fail(res, 400, 'bad_video_reference', 'Not a YouTube URL or video ID.');
      return;
    }
    if (req.body?.saved) store.toggleSaved({ id, ...req.body });
    else store.pushHistory({ id, ...req.body });
    res.json({ ok: true, history: store.getState().history, saved: store.getState().saved });
  }),
);

/** Operational helpers used by the settings panel. */
app.post(
  '/api/admin/cache/clear',
  wrap(async (_req, res) => {
    clearCache();
    res.json({ ok: true, cache: cacheStats() });
  }),
);

app.post(
  '/api/admin/resolver/refresh',
  wrap(async (_req, res) => {
    resetYtdlpProbe();
    const ytdlp = await probeYtdlp();
    res.json({ ok: ytdlp.ok, ytdlp });
  }),
);

/* ------------------------------------------------------------------ *
 * Static front end
 * ------------------------------------------------------------------ */

// The app is a self-hosted dashboard, so correctness beats cache hits: let the
// browser keep a copy but force it to revalidate, which means an edit shows up
// on reload instead of serving a stale bundle for hours.
app.use(
  express.static(config.publicDir, {
    extensions: ['html'],
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      if (/\.(html|js|css|svg)$/i.test(filePath)) {
        res.setHeader('cache-control', 'no-cache');
      }
    },
  }),
);

// Client-side routing: everything that is not /api and not a real file falls
// back to the shell.
app.get(/^(?!\/api\/).*/, (_req, res, next) => {
  const indexFile = `${config.publicDir}/index.html`;
  if (!fs.existsSync(indexFile)) return next();
  res.setHeader('cache-control', 'no-cache');
  res.sendFile(indexFile);
});

/* ------------------------------------------------------------------ */

app.use((req, res) => {
  fail(res, 404, 'not_found', `No route for ${req.method} ${req.path}`);
});

app.use((error, _req, res, _next) => {
  console.error('[error]', error);
  if (res.headersSent) return res.destroy();
  fail(res, error.status || 500, 'internal_error', error.message || 'Unexpected error');
});

/* ------------------------------------------------------------------ */

store.loadState();

const server = app.listen(config.port, config.host, async () => {
  const ytdlp = await probeYtdlp();
  const ytdlCore = await import('@distube/ytdl-core')
    .then(() => 'available')
    .catch(() => 'missing');

  console.log('');
  console.log('  \x1b[1;31m⚡ CYBERSTREAM\x1b[0m  \x1b[2mv1.0.0\x1b[0m');
  console.log(`  \x1b[2mhttp://localhost:${config.port}\x1b[0m`);
  console.log('');
  console.log(`  yt-dlp      ${ytdlp.ok ? `\x1b[32m${ytdlp.version}\x1b[0m` : '\x1b[33mnot found\x1b[0m'}`);
  console.log(`  ytdl-core   ${ytdlCore === 'available' ? '\x1b[32mavailable\x1b[0m' : '\x1b[33mnot installed\x1b[0m'}`);
  console.log(`  max quality ${config.maxQuality}p`);
  if (config.proxySecretIsEphemeral) {
    console.log('  \x1b[2mnote: PROXY_SECRET is unset, proxy links expire on restart\x1b[0m');
  }
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

// Node exits on an unhandled rejection by default. For a long-running media
// server that turns one bad request into a dead dashboard, so log it loudly
// and keep serving.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[fatal] uncaught exception:', error);
});

export { app, server };

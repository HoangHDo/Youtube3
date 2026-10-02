import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { signUpstream, verifySigned } from './sign.js';

/**
 * Byte-range aware reverse proxy for YouTube media.
 *
 * `<video>` seeking is driven entirely by `Range` requests, so this handler
 * forwards `Range` (and `If-Range`) upstream and mirrors the 206 response
 * back. Without that the player would be stuck at whatever byte the first
 * response happened to contain.
 */

/** Headers we deliberately pass through from the upstream response. */
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
  'cache-control',
  'expires',
];

function upstreamHeaders(req) {
  const headers = {
    'user-agent': config.userAgent,
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
  };
  if (req.headers.range) headers.range = req.headers.range;
  if (req.headers['if-range']) headers['if-range'] = req.headers['if-range'];
  return headers;
}

async function handle(req, res) {
  const verdict = verifySigned(req.query.s);
  if (!verdict.ok) {
    res.status(403).json({ error: 'proxy_rejected', detail: verdict.reason });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.proxyTimeoutMs);

  // If the browser seeks away or unmounts the <video>, stop pulling bytes.
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);

  try {
    const upstream = await fetch(verdict.url, {
      method: 'GET',
      headers: upstreamHeaders(req),
      redirect: 'follow',
      signal: controller.signal,
    });

    res.status(upstream.status);

    for (const name of FORWARD_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader('access-control-allow-origin', '*');

    if (!upstream.ok || !upstream.body) {
      res.setHeader('content-length', '0');
      res.end();
      await upstream.body?.cancel().catch(() => {});
      return;
    }

    // Node refuses a forwarded content-length when the body ends up chunked,
    // so clear it whenever the upstream answered with a partial body.
    if (upstream.status === 206) res.removeHeader('content-length');

    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    if (controller.signal.aborted) {
      // Normal: client cancelled the seek.
      if (!res.headersSent) res.status(499);
      res.end();
      return;
    }
    if (!res.headersSent) {
      res.status(502).json({ error: 'upstream_failed', detail: String(error?.message || error) });
    } else {
      res.destroy();
    }
  } finally {
    clearTimeout(timer);
    res.off('close', onClose);
  }
}

/** GET /api/proxy?s=... - media relay with range support. */
export function proxyMedia(req, res) {
  return handle(req, res);
}

/**
 * GET /api/hls?s=... - fetch an m3u8 playlist and rewrite every URI in it
 * (variant playlists and media segments alike) into signed proxy URLs, so the
 * browser never talks to googlevideo.com directly.
 */
export async function proxyPlaylist(req, res) {
  const verdict = verifySigned(req.query.s);
  if (!verdict.ok) {
    res.status(403).json({ error: 'proxy_rejected', detail: verdict.reason });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.proxyTimeoutMs);

  try {
    const upstream = await fetch(verdict.url, {
      headers: { 'user-agent': config.userAgent, accept: '*/*' },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: 'playlist_unavailable' });
      return;
    }

    const body = await upstream.text();
    const base = new URL(verdict.url);
    // The ceiling travels inside the signed payload, so a client cannot raise
    // it. Without this the master playlist would happily hand the player a
    // 4K variant and quietly ignore MAX_QUALITY.
    const maxHeight = Number(verdict.meta?.maxHeight) || 0;
    const rewritten = rewritePlaylist(body, base, { maxHeight });

    res.status(200);
    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('access-control-allow-origin', '*');
    res.send(rewritten);
  } catch (error) {
    if (!res.headersSent) {
      res.status(502).json({ error: 'playlist_failed', detail: String(error?.message || error) });
    } else {
      res.end();
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk an m3u8 and swap every URI line for a proxied one. Anything on a line
 * that starts with `#` is a tag, except URI attributes such as
 * `#EXT-X-MAP:URI="..."` and `#EXT-X-KEY:URI="..."` which must be rewritten
 * in place.
 *
 * When `maxHeight` is set, variants above that resolution are dropped from a
 * master playlist (the tag *and* the URI line that follows it). Audio
 * `EXT-X-MEDIA` entries are always kept - they carry no resolution, and
 * dropping them is what silences the player.
 */
export function rewritePlaylist(text, baseUrl, { maxHeight = 0 } = {}) {
  const source = String(text).split(/\r?\n/);
  const out = [];

  for (let i = 0; i < source.length; i++) {
    const line = source[i];

    if (!line) {
      out.push(line);
      continue;
    }

    if (line.startsWith('#')) {
      // Drop an over-ceiling variant together with the URI line beneath it.
      if (maxHeight > 0 && /^#EXT-X-STREAM-INF:/i.test(line)) {
        const resolution = line.match(/RESOLUTION=(\d+)x(\d+)/i);
        const height = resolution ? Number(resolution[2]) : 0;
        if (height && height > maxHeight) {
          i += 1; // also skip its URI line
          continue;
        }
      }

      out.push(
        line.replace(/URI="([^"]+)"/g, (match, uri) => {
          const proxied = toProxy(uri, baseUrl);
          return proxied ? `URI="${proxied}"` : match;
        }),
      );
      continue;
    }

    const proxied = toProxy(line.trim(), baseUrl);
    out.push(proxied || line);
  }

  return out.join('\n');
}

function toProxy(reference, baseUrl) {
  let absolute;
  try {
    absolute = new URL(reference, baseUrl);
  } catch {
    return null;
  }
  if (absolute.protocol !== 'https:' && absolute.protocol !== 'http:') return null;

  const isPlaylist = /\.m3u8(\?|$)/i.test(absolute.pathname);
  const isSegment = /\.ts(\?|$)/i.test(absolute.pathname) || /\/videoplayback/.test(absolute.href);

  if (isPlaylist) return `/api/hls?s=${signUpstream(absolute.href)}`;
  if (isSegment || /googlevideo|youtube/.test(absolute.hostname)) {
    return `/api/proxy?s=${signUpstream(absolute.href)}`;
  }
  return null;
}

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config, isAllowedProxyHost } from './config.js';

/**
 * Signed proxy URLs.
 *
 * The client never sees a googlevideo.com URL. Instead the server hands out
 * `/api/proxy?s=...` links, each carrying an HMAC over the upstream URL plus
 * an expiry. That gives us three things:
 *
 *  1. no open proxy / SSRF - the signature can only be minted by us,
 *  2. host allow-listing as a second line of defence,
 *  3. expiring links, so a leaked URL dies on its own.
 */

function hmac(input) {
  return createHmac('sha256', config.proxySecret).update(input).digest('base64url');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Default link lifetime. Kept in step with the resolve cache. */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function encode(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value) {
  return Buffer.from(String(value), 'base64url').toString('utf8');
}

/**
 * Sign an upstream URL, optionally with extra tamper-proof metadata.
 *
 * The payload is base64url-encoded wholesale so that query strings full of
 * &, = and ? need no escaping, and the HMAC runs over the encoded blob - the
 * exact string verify() receives.
 *
 * @param {string} upstreamUrl
 * @param {number} [ttlMs]
 * @param {object} [meta] extra fields carried inside the signed payload, so a
 *   client cannot tamper with them (e.g. the quality ceiling for a playlist).
 */
export function signUpstream(upstreamUrl, ttlMs = DEFAULT_TTL_MS, meta = null) {
  const payload = { u: upstreamUrl, e: Date.now() + ttlMs };
  if (meta && Object.keys(meta).length) payload.m = meta;

  const blob = encode(JSON.stringify(payload));
  return `${blob}.${hmac(blob)}`;
}

/**
 * @returns {{ok: true, url: string, exp: number, meta: object|null}
 *          | {ok: false, reason: string}}
 */
export function verifySigned(signed) {
  if (typeof signed !== 'string' || !signed) {
    return { ok: false, reason: 'missing signature' };
  }
  const parts = signed.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed signature' };

  const [payload, signature] = parts;
  if (!safeEqual(signature, hmac(payload))) {
    return { ok: false, reason: 'bad signature' };
  }

  let parsedPayload;
  try {
    parsedPayload = JSON.parse(decode(payload));
  } catch {
    return { ok: false, reason: 'unreadable payload' };
  }

  const { u: url, e: exp, m: meta } = parsedPayload || {};

  if (typeof url !== 'string') return { ok: false, reason: 'unreadable payload' };
  if (!Number.isFinite(exp)) return { ok: false, reason: 'bad expiry' };
  if (Date.now() > exp) return { ok: false, reason: 'link expired' };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'bad upstream url' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'unsupported protocol' };
  }
  if (!isAllowedProxyHost(parsed.hostname)) {
    return { ok: false, reason: `host not allowed: ${parsed.hostname}` };
  }

  return {
    ok: true,
    url,
    exp,
    meta: meta && typeof meta === 'object' ? meta : null,
  };
}

/** Build a same-origin proxy path for an upstream URL. */
export function proxyPath(upstreamUrl, ttlMs) {
  return `/api/proxy?s=${signUpstream(upstreamUrl, ttlMs)}`;
}

/** Build a same-origin proxy path for an HLS playlist. */
export function playlistPath(upstreamUrl, ttlMs) {
  return `/api/hls?s=${signUpstream(upstreamUrl, ttlMs)}`;
}

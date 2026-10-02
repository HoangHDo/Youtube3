/**
 * YouTube URL / ID parsing and stream-format selection.
 *
 * Everything here is pure and dependency free so it can be unit tested with
 * `node --test`.
 */

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Turn anything a user can paste - a watch URL, a short link, an embed URL,
 * a shorts/live URL, an attribution link, a `youtu.be` link with extra query
 * params, or a bare 11 character id - into a video id.
 *
 * @param {string} input
 * @returns {string|null}
 */
export function parseVideoId(input) {
  if (typeof input !== 'string') return null;
  let value = input.trim();
  if (!value) return null;

  // Strip a wrapping pair of quotes people often paste along with a link.
  value = value.replace(/^["']|["']$/g, '').trim();
  if (!value) return null;

  if (ID_RE.test(value)) return value;

  // Bare id with stray whitespace / dashes is not valid, but people paste
  // ids with extra path segments such as `dQw4w9WgXcQ/`.
  if (ID_RE.test(value.split(/[/?#\s]/)[0])) {
    return value.split(/[/?#\s]/)[0];
  }

  let url;
  try {
    // Assume https for schemeless input so `URL` is happy.
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  const isYouTube =
    host === 'youtube.com' ||
    host === 'youtube-nocookie.com' ||
    host === 'youtu.be' ||
    host.endsWith('.youtube.com');

  if (!isYouTube) return null;

  const fromParam = url.searchParams.get('v');
  if (fromParam && ID_RE.test(fromParam)) return fromParam;

  const segments = url.pathname.split('/').filter(Boolean);

  // /watch handled above via ?v=, but support /watch/ID too.
  if (segments[0] === 'watch' && segments[1] && ID_RE.test(segments[1])) {
    return segments[1];
  }

  // /embed/ID, /v/ID, /shorts/ID, /live/ID, /e/ID
  if (
    ['embed', 'v', 'shorts', 'live', 'e'].includes(segments[0]) &&
    segments[1] &&
    ID_RE.test(segments[1])
  ) {
    return segments[1];
  }

  // youtu.be/ID
  if (host === 'youtu.be' && segments[0] && ID_RE.test(segments[0])) {
    return segments[0];
  }

  // /attribution_link?u=%2Fwatch%3Fv%3DID and /redirect?q=...
  // searchParams.get already URL-decodes, so do not decode a second time.
  const nested = url.searchParams.get('u') || url.searchParams.get('q');
  if (nested) {
    // The nested value is usually a site-relative path such as /watch?v=ID.
    const candidate = nested.startsWith('/') ? `https://www.youtube.com${nested}` : nested;
    const inner = parseVideoId(candidate);
    if (inner) return inner;
  }

  return null;
}

export function isValidVideoId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function thumbnailUrl(id, kind = 'hqdefault') {
  return `https://i.ytimg.com/vi/${id}/${kind}.jpg`;
}

/**
 * Whether a format carries real video *and* real audio. Progressive formats
 * are the ones a plain <video> tag can play from a single URL.
 */
function isMuxed(format) {
  const hasVideo = format.vcodec && format.vcodec !== 'none';
  const hasAudio = format.acodec && format.acodec !== 'none';
  return Boolean(hasVideo && hasAudio);
}

function isVideoOnly(format) {
  const hasVideo = format.vcodec && format.vcodec !== 'none';
  return Boolean(hasVideo && (!format.acodec || format.acodec === 'none'));
}

function isAudioOnly(format) {
  const hasAudio = format.acodec && format.acodec !== 'none';
  return Boolean(hasAudio && (!format.vcodec || format.vcodec === 'none'));
}

/**
 * Height as a plain number. yt-dlp reports `resolution: "audio only"` for
 * audio-only formats, so the resolution fallback has to be validated rather
 * than trusted - otherwise "audio only" leaks through as a height.
 */
function heightOf(format) {
  const direct = Number(format.height);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const match = String(format.resolution || '').match(/(\d+)\s*x\s*(\d+)/i);
  return match ? Number(match[2]) : 0;
}

function hasDirectUrl(format) {
  return typeof format.url === 'string' && /^https?:\/\//i.test(format.url);
}

function isHls(format) {
  const protocol = String(format.protocol || '').toLowerCase();
  return (
    protocol.includes('m3u8') ||
    protocol === 'http' && /\.m3u8(\?|$)/i.test(format.url || '')
  );
}

/**
 * Pick the best progressive (video+audio in one file) format at or below
 * `maxHeight`.
 *
 * YouTube only publishes muxed progressive files up to ~720p, so above that
 * we fall back to HLS, which every browser can play (Safari natively, everyone
 * else through hls.js).
 *
 * @param {any[]} formats raw formats from yt-dlp / ytdl-core
 * @param {{maxHeight?: number}} [options]
 */
export function selectProgressive(formats = [], { maxHeight = 1080 } = {}) {
  const candidates = formats
    .filter((f) => f && hasDirectUrl(f) && isMuxed(f) && !isHls(f))
    // DASH manifest formats describe adaptive streams - unusable as one file.
    .filter((f) => !String(f.protocol || '').startsWith('http_dash'))
    .map((f) => ({
      url: f.url,
      height: heightOf(f),
      width: f.width || 0,
      fps: f.fps || 0,
      ext: f.ext || 'mp4',
      size: f.filesize || f.filesize_approx || 0,
      tbr: f.tbr || 0,
      formatId: f.format_id,
      protocol: f.protocol || 'https',
    }))
    .filter((f) => f.height > 0);

  if (!candidates.length) return null;

  const withinCap = candidates.filter((f) => f.height <= maxHeight);
  const pool = withinCap.length ? withinCap : candidates;

  pool.sort((a, b) => {
    if (b.height !== a.height) return b.height - a.height;
    if (b.fps !== a.fps) return b.fps - a.fps;
    return b.tbr - a.tbr;
  });

  return pool[0];
}

/**
 * Pick the best HLS variant at or below `maxHeight`. Returns the variant
 * playlist URL, which we rewrite into a proxied playlist on the fly.
 */
export function selectHls(formats = [], { maxHeight = 1080 } = {}) {
  const picked = pickHlsVariant(
    (formats || []).filter((f) => f && hasDirectUrl(f) && isHls(f)),
    maxHeight,
  );
  if (!picked) return null;
  return {
    url: picked.url,
    height: heightOf(picked),
    fps: picked.fps || 0,
    ext: picked.ext || 'mp4',
    size: picked.filesize || picked.filesize_approx || 0,
    tbr: picked.tbr || 0,
    formatId: picked.format_id,
    protocol: picked.protocol,
  };
}

/**
 * Choose the HLS source to hand the browser, audio guaranteed.
 *
 * This matters more than it looks: every HLS *variant* YouTube publishes is
 * video-only (`acodec: none`). Point a player at one of those and you get a
 * picture with no sound. The audio lives in `EXT-X-MEDIA` groups on the
 * *master* playlist, which also declares `AUDIO="..."` per variant, so handing
 * the master to hls.js is what gets both tracks muxed back together.
 *
 * @returns {{url: string, master: boolean, height: number, fps: number, bitrate: number, formatId: any} | null}
 */
export function selectHlsSource(formats = [], { maxHeight = 1080 } = {}) {
  const hlsFormats = (formats || []).filter((f) => f && isHls(f) && hasDirectUrl(f));
  if (!hlsFormats.length) return null;

  // Best case: a variant that already carries both tracks.
  const muxed = pickHlsVariant(hlsFormats.filter(isMuxed), maxHeight);
  if (muxed) {
    return {
      url: muxed.url,
      master: false,
      height: heightOf(muxed),
      fps: muxed.fps || 0,
      bitrate: muxed.tbr || 0,
      formatId: muxed.format_id,
    };
  }

  // Otherwise fall back to the master playlist of the best video variant.
  const withMaster = hlsFormats.filter((f) => /^https?:\/\//i.test(f.manifest_url || ''));
  const best = pickHlsVariant(withMaster, maxHeight);
  if (!best) return null;

  return {
    url: best.manifest_url,
    master: true,
    height: heightOf(best),
    fps: best.fps || 0,
    bitrate: best.tbr || 0,
    formatId: best.format_id,
  };
}

function pickHlsVariant(candidates, maxHeight) {
  if (!candidates.length) return null;
  const withHeight = candidates.filter((f) => heightOf(f) > 0);
  if (!withHeight.length) return null;

  const within = withHeight.filter((f) => heightOf(f) <= maxHeight);
  const pool = within.length ? within : withHeight;
  pool.sort((a, b) => heightOf(b) - heightOf(a) || (b.fps || 0) - (a.fps || 0));
  return pool[0];
}

/**
 * The best audio-only rendition - used for the "audio only" quality option so
 * the client can build its own <audio> track.
 */
export function selectAudio(formats = [], { maxBitrate = 192 } = {}) {
  const candidates = formats
    .filter((f) => f && hasDirectUrl(f) && isAudioOnly(f) && !isHls(f))
    .map((f) => ({
      url: f.url,
      bitrate: Math.round(f.abr || f.tbr || 0),
      ext: f.ext || 'm4a',
      size: f.filesize || f.filesize_approx || 0,
      formatId: f.format_id,
      protocol: f.protocol || 'https',
    }))
    .filter((f) => f.bitrate > 0);

  if (!candidates.length) return null;
  // Strict ceiling: a tolerance here would silently hand back the next
  // rendition up (asking for <=128kbps and getting 160kbps is worse than
  // getting nothing, because the caller cannot see the difference).
  const withinCap = candidates.filter((f) => f.bitrate <= maxBitrate);
  const pool = withinCap.length ? withinCap : candidates;
  pool.sort((a, b) => b.bitrate - a.bitrate);
  return pool[0];
}

/** Full inventory so the client can offer a quality picker. */
export function buildLadder(formats = [], { maxHeight = 1080 } = {}) {
  const qualities = new Map();

  for (const format of formats || []) {
    if (!format || !hasDirectUrl(format)) continue;
    if (isAudioOnly(format)) {
      const bitrate = Math.round(format.abr || format.tbr || 0);
      if (!bitrate) continue;
      const key = `${bitrate}kbps audio`;
      if (!qualities.has(key)) {
        qualities.set(key, {
          label: `AUDIO ${bitrate}k`,
          height: 0,
          bitrate,
          hls: isHls(format),
          size: format.filesize || format.filesize_approx || 0,
        });
      }
      continue;
    }
    const height = heightOf(format);
    if (!height || height > maxHeight) continue;
    const key = `${height}p`;
    if (!qualities.has(key)) {
      qualities.set(key, {
        label: `${height}p`,
        height,
        hls: isHls(format),
        size: format.filesize || format.filesize_approx || 0,
      });
    }
  }

  return [...qualities.values()].sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
}

export { isMuxed, isVideoOnly, isAudioOnly, isHls, hasDirectUrl, heightOf };

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { signUpstream } from './sign.js';
import { buildLadder, selectAudio, selectHlsSource, selectProgressive } from './youtube.js';

const execFileAsync = promisify(execFile);

/**
 * Stream resolution with graceful degradation.
 *
 * Three strategies, tried in order of reliability:
 *
 *   1. `yt-dlp` binary - handles the most YouTube changes, best format
 *      coverage, supports cookies for age/region gated videos.
 *   2. `@distube/ytdl-core` - pure JS, no binary needed.
 *   3. YouTube oEmbed - metadata only (title/author/thumbnail) but works even
 *      when both resolvers are dead, so the UI can still show something.
 *
 * Whichever one answers first wins; results are cached because the resolved
 * googlevideo URLs are short lived.
 */

const cache = new Map(); // id -> { expires, value }
const inflight = new Map(); // id -> Promise

let ytdlCore = null;
let ytdlCoreChecked = false;
let ytdlBinary = null; // { ok, path, version, error }

async function loadYtdlCore() {
  if (ytdlCoreChecked) return ytdlCore;
  ytdlCoreChecked = true;
  try {
    const mod = await import('@distube/ytdl-core');
    ytdlCore = mod.default ?? mod;
  } catch {
    ytdlCore = null;
  }
  return ytdlCore;
}

export async function probeYtdlp() {
  if (ytdlBinary) return ytdlBinary;
  try {
    const { stdout } = await execFileAsync(config.ytdlpPath, ['--version'], {
      timeout: 8000,
      windowsHide: true,
    });
    ytdlBinary = { ok: true, version: String(stdout).trim() };
  } catch (error) {
    ytdlBinary = { ok: false, error: String(error?.message || error).slice(0, 200) };
  }
  return ytdlBinary;
}

/** Drop the binary probe cache so a newly installed yt-dlp is picked up. */
export function resetYtdlpProbe() {
  ytdlBinary = null;
}

async function resolveWithYtdlp(id) {
  const probe = await probeYtdlp();
  if (!probe.ok) throw new Error(`yt-dlp unavailable: ${probe.error}`);

  const args = [
    '-J',
    '--no-warnings',
    '--no-playlist',
    '--no-check-certificate',
    '--socket-timeout',
    '15',
    '--extractor-retries',
    '2',
  ];
  if (process.env.YTDLP_COOKIES) args.push('--cookies', process.env.YTDLP_COOKIES);
  if (process.env.YTDLP_COOKIES_FROM_BROWSER) {
    args.push('--cookies-from-browser', process.env.YTDLP_COOKIES_FROM_BROWSER);
  }
  if (process.env.YTDLP_PROXY) args.push('--proxy', process.env.YTDLP_PROXY);
  args.push(`https://www.youtube.com/watch?v=${id}&bpctr=9999999999`);

  const { stdout } = await execFileAsync(config.ytdlpPath, args, {
    timeout: config.upstreamTimeoutMs * 2,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });

  const info = JSON.parse(stdout);
  if (info._type === 'playlist' && info.entries?.length) {
    // --no-playlist should prevent this, but be forgiving.
    return normalize(info.entries[0], 'ytdlp');
  }
  return normalize(info, 'ytdlp');
}

async function resolveWithYtdlCore(id) {
  const lib = await loadYtdlCore();
  if (!lib) throw new Error('ytdl-core not installed');
  const info = await lib.getInfo(`https://www.youtube.com/watch?v=${id}`, {
    requestOptions: { headers: { 'user-agent': config.userAgent } },
  });
  return normalize(info, 'ytdl-core');
}

async function resolveWithOembed(id) {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${id}`,
  )}&format=json`;
  const res = await fetch(url, {
    headers: { 'user-agent': config.userAgent },
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
  });
  if (!res.ok) throw new Error(`oembed ${res.status}`);
  const data = await res.json();
  return {
    id,
    source: 'oembed',
    degraded: true,
    title: data.title || id,
    author: data.author_name || 'Unknown',
    authorUrl: data.author_url || '',
    duration: 0,
    thumbnail: `/api/thumb?v=${id}&k=hqdefault`,
    description: '',
    description: '',
    viewCount: 0,
    live: false,
    formats: [],
  };
}

function normalize(info, source) {
  return {
    id: info.id,
    source,
    degraded: false,
    title: cleanTitle(info.title || info.id),
    author: info.uploader || info.channel || info.author || 'Unknown',
    authorUrl:
      info.uploader_url ||
      info.channel_url ||
      (info.uploader_id ? `https://www.youtube.com/@${info.uploader_id}` : ''),
    duration: Number(info.duration) || 0,
    // Rewritten to our own origin: i.ytimg.com sends no CORS headers, so the
    // browser could not read it into the stage-tint canvas.
    thumbnail: info.id ? `/api/thumb?v=${info.id}&k=maxresdefault` : '',
    description: stripHtml(info.description || ''),
    viewCount: Number(info.view_count) || 0,
    likeCount: Number(info.like_count) || 0,
    uploadDate: info.upload_date || '',
    live: Boolean(info.is_live),
    wasLive: Boolean(info.was_live),
    categories: Array.isArray(info.categories) ? info.categories.slice(0, 4) : [],
    formats: Array.isArray(info.formats) ? info.formats : [],
  };
}

function cleanTitle(title) {
  return String(title).replace(/\s+/g, ' ').trim();
}

function stripHtml(text) {
  return String(text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

export function cacheStats() {
  let live = 0;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expires <= now) cache.delete(key);
    else live += 1;
  }
  return { entries: live };
}

export function clearCache() {
  cache.clear();
  inflight.clear();
}

/**
 * Resolve a video id to metadata + proxied stream descriptors.
 * @param {string} id
 * @param {{quality?: number, refresh?: boolean}} [options]
 */
export async function resolveVideo(id, options = {}) {
  const maxQuality = clampQuality(options.quality);
  const key = `${id}:${maxQuality}`;

  if (options.refresh) {
    cache.delete(key);
  } else {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    if (hit) cache.delete(key);
  }

  // Collapse concurrent resolves for the same video into one upstream call.
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    const attempts = [
      ['ytdlp', resolveWithYtdlp],
      ['ytdl-core', resolveWithYtdlCore],
      ['oembed', resolveWithOembed],
    ];

    const errors = [];
    let meta = null;

    for (const [name, run] of attempts) {
      try {
        meta = await run(id);
        if (name !== 'ytdlp') {
          console.warn(`[resolver] ${id}: fell back to ${name} (ytdlp/ytdl-core unavailable)`);
        }
        break;
      } catch (error) {
        const reason = String(error?.message || error).slice(0, 180);
        errors.push(`${name}: ${reason}`);
        console.warn(`[resolver] ${id}: ${name} failed - ${reason}`);
      }
    }

    if (!meta) {
      const error = new Error('Unable to resolve this video');
      error.status = 502;
      error.detail = errors.join(' | ');
      throw error;
    }

    const value = buildStreams(meta, maxQuality);
    // oembed-only results carry no formats, so don't cache them for long.
    const ttl = meta.degraded ? 30_000 : config.cacheTtlMs;
    cache.set(key, { expires: Date.now() + ttl, value });
    return value;
  })().finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

/**
 * Resolve a requested quality to a concrete ceiling.
 *
 * 0 / "auto" / missing / junk all mean "the best you have", which is
 * MAX_QUALITY. Regression guard: this used to floor "auto" at 144, which
 * silently capped every default request to the worst rendition available.
 */
export function clampQuality(requested) {
  const ceiling = Math.min(Math.max(Number(config.maxQuality) || 1080, 144), 2160);
  const parsed = Number.parseInt(requested ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return ceiling;
  return Math.min(Math.max(parsed, 144), ceiling);
}

/**
 * Turn raw yt-dlp formats into same-origin, signed, playable descriptors.
 */
function buildStreams(meta, maxQuality) {
  const formats = meta.formats || [];
  const progressive = selectProgressive(formats, { maxHeight: maxQuality });
  // Not selectHls: the variants are video-only, which means no sound.
  const hls = selectHlsSource(formats, { maxHeight: maxQuality });
  const audio = selectAudio(formats);
  const ladder = buildLadder(formats, { maxHeight: maxQuality });

  // Give every proxied link the same generous lifetime as the cache entry.
  const ttl = meta.degraded ? 30_000 : Math.max(config.cacheTtlMs, 10 * 60 * 1000);

  const descriptor = (fmt, kind) =>
    fmt && {
      kind,
      url: `/api/proxy?s=${sign(ttl, fmt.url)}`,
      height: fmt.height || 0,
      width: fmt.width || 0,
      fps: fmt.fps || 0,
      ext: fmt.ext || 'mp4',
      size: fmt.size || 0,
      bitrate: fmt.bitrate || fmt.tbr || 0,
    };

  return {
    ...meta,
    quality: maxQuality,
    playable: Boolean(progressive || hls),
    streams: {
      // Progressive = one MP4 with video+audio, playable by <video> directly.
      progressive: descriptor(progressive, 'progressive'),
      // HLS = adaptive, higher ceilings, needs hls.js outside Safari.
      // `master` is the master playlist, which carries the audio groups - a
      // bare variant is video-only and would play silently.
      hls: hls
        ? {
            kind: 'hls',
            // The ceiling is signed in, so the playlist handler can strip
            // over-quality variants without trusting the client.
            url: `/api/hls?s=${sign(ttl, hls.url, { maxHeight: maxQuality })}`,
            master: hls.master,
            height: hls.height || 0,
            ext: 'mp4',
            size: 0,
          }
        : null,
      // Audio-only, lets the client mute video and keep sound.
      audio: descriptor(audio, 'audio'),
    },
    ladder: ladder.map((q) => ({
      ...q,
      hls: Boolean(q.hls),
    })),
  };
}

function sign(ttl, url, meta) {
  // Kept in a helper so buildStreams stays readable.
  return signUpstream(url, ttl, meta);
}

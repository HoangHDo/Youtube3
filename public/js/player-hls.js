/**
 * Minimal HLS support.
 *
 * Safari plays HLS natively, so we only pull in a library where it is
 * actually needed. The player prefers a progressive MP4 (single URL, audio and
 * video together, zero extra machinery) and only falls back to HLS when that
 * is unavailable or the user explicitly picks a height above what progressive
 * covers.
 */

let loaderPromise = null;
const CDN = [
  'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js',
  'https://unpkg.com/hls.js@1.5.17/dist/hls.min.js',
];

export function nativeHlsSupported() {
  const video = document.createElement('video');
  return Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
}

async function loadHlsLibrary() {
  if (window.Hls) return window.Hls;
  if (loaderPromise) return loaderPromise;

  loaderPromise = (async () => {
    for (const url of CDN) {
      try {
        await loadScript(url);
        if (window.Hls) return window.Hls;
      } catch {
        /* try the next mirror */
      }
    }
    throw new Error('Could not load an HLS engine (offline?)');
  })().catch((error) => {
    loaderPromise = null;
    throw error;
  });

  return loaderPromise;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(new Error(`failed to load ${src}`));
    };
    document.head.append(script);
  });
}

/**
 * Attach an HLS playlist to a <video> element.
 *
 * The URL is normally a *master* playlist. That is deliberate: YouTube's HLS
 * variants are video-only, and the master is what pairs each variant with its
 * `EXT-X-MEDIA` audio group. Handing a player a bare variant produces a picture
 * with no sound.
 *
 * @returns {Promise<{destroy: () => void, setQuality?: Function, heights?: number[]}>}
 */
export async function attachHls(video, url) {
  if (nativeHlsSupported()) {
    video.src = url;
    return { destroy: () => { video.removeAttribute('src'); } };
  }

  const Hls = await loadHlsLibrary();
  if (!Hls.isSupported()) {
    throw new Error('This browser cannot play HLS');
  }

  const hls = new Hls({
    enableWorker: true,
    lowLatencyMode: false,
    // The playlist is same-origin and signed, so CORS/credentials are a
    // non-issue; the defaults would only add latency.
    xhrSetup: (xhr) => { xhr.withCredentials = false; },
    // -1 = let hls.js start from the bitrate it can actually sustain and ramp
    // up. A hardcoded high start level just causes a stall on a cold cache.
    startLevel: -1,
  });

  hls.loadSource(url);
  hls.attachMedia(video);

  return {
    hls,
    destroy: () => hls.destroy(),

    /** Heights hls.js knows about, descending. */
    heights() {
      return [...new Set(hls.levels.map((l) => l.height).filter(Boolean))].sort((a, b) => b - a);
    },

    /**
     * Pin playback to a height. `0`/undefined hands control back to hls.js
     * (automatic adaptation). Returns true if a matching level was found.
     */
    setQuality(height) {
      if (!height) {
        hls.currentLevel = -1;
        hls.nextLevel = -1;
        return true;
      }
      const index = hls.levels.findIndex((l) => l.height === Number(height));
      if (index === -1) return false;
      hls.currentLevel = index;
      return true;
    },
  };
}

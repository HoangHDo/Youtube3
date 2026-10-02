/**
 * The suggested feed shown under the player.
 *
 * Ships with a curated set of well-known, freely viewable videos so the app is
 * useful the moment it boots, even with no network. A user-supplied Atom feed
 * (a YouTube playlist RSS, for example) can replace it from the settings panel.
 */

export const CURATED = [
  { id: 'aqz-KE-bpKQ', title: 'Big Buck Bunny 60fps 4K', author: 'Blender', tag: 'OPEN MOVIE' },
  { id: 'eRsGyueVLvQ', title: 'Sintel', author: 'Blender', tag: 'OPEN MOVIE' },
  { id: 'R6MlUcmOul8', title: 'Tears of Steel', author: 'Blender Foundation', tag: 'OPEN MOVIE' },
  { id: 'jNQXAC9IVRw', title: 'Me at the zoo', author: 'jawed', tag: 'FIRST UPLOAD' },
  { id: 'M7lc1UVf-VE', title: 'YouTube API demo video', author: 'Google Developers', tag: 'DEMO' },
  { id: '5qap5aO4i9A', title: 'lofi hip hop radio', author: 'Lofi Girl', tag: 'LIVE 24/7' },
  { id: 'YQHsXMglC9A', title: 'Hello', author: 'Adele', tag: 'MUSIC' },
  { id: 'kJQP7kiw5Fk', title: 'Despacito', author: 'Luis Fonsi', tag: 'MUSIC' },
  { id: '9bZkp7q19f0', title: 'Gangnam Style', author: 'officialpsy', tag: 'MUSIC' },
  { id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', author: 'Rick Astley', tag: 'MUSIC' },
  { id: 'ZbZSe6N_BXs', title: 'Happy - Pharrell Williams', author: 'Pharrell Williams', tag: 'MUSIC' },
];

// Entries without a real 11-character id are still rendered - the UI draws a
// styled placeholder card, which is the same fallback used when a thumbnail
// 404s.
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

function decorate(entry) {
  const id = ID_RE.test(entry.id) ? entry.id : null;
  return {
    id,
    title: entry.title,
    author: entry.author,
    tag: entry.tag || '',
    // Same-origin so the browser can render and canvas-read it.
    thumbnail: id ? `/api/thumb?v=${id}&k=mqdefault` : '',
    loadable: Boolean(id),
  };
}

export function localCatalog() {
  return CURATED.map(decorate);
}

/**
 * Parse a YouTube playlist/channel Atom feed into catalog entries. Returns an
 * empty array rather than throwing so the caller can fall back to local.
 */
export function parseAtomFeed(xml) {
  const entries = [];
  const blocks = String(xml).match(/<entry>[\s\S]*?<\/entry>/g) || [];

  for (const block of blocks) {
    const videoId =
      pick(block, /yt:videoId[^>]*>([^<]+)</) ||
      pick(block, /<yt:videoId>([^<]+)<\/yt:videoId>/) ||
      (pick(block, /<link[^>]*rel="alternate"[^>]*href="([^"]+)"/) || '')
        .match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1];
    if (!videoId || !ID_RE.test(videoId)) continue;

    entries.push({
      id: videoId,
      title: decodeEntities(pick(block, /<title>([\s\S]*?)<\/title>/) || 'Untitled'),
      author: decodeEntities(
        pick(block, /<author>[\s\S]*?<name>([\s\S]*?)<\/name>/) || 'Unknown',
      ),
      tag: 'FEED',
      thumbnail: `/api/thumb?v=${videoId}&k=mqdefault`,
      loadable: true,
    });
  }

  return entries;
}

async function fetchCatalogFeed(url, { timeout = 12_000, limit = 24 } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; Cyberstream/1.0)', accept: 'application/atom+xml, application/xml, text/xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`feed ${res.status}`);
  const entries = parseAtomFeed(await res.text());
  if (!entries.length) throw new Error('feed contained no videos');
  return entries.slice(0, limit);
}

function pick(text, re) {
  const m = text.match(re);
  return m ? m[1] : null;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export { fetchCatalogFeed };

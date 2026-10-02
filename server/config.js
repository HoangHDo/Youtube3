import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

/**
 * Minimal .env loader - avoids pulling in a dependency for something this
 * small. Existing environment variables always win.
 */
function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  dataDir: path.join(ROOT, 'data'),
  stateFile: path.join(ROOT, 'data', 'state.json'),

  port: int(process.env.PORT, 5173),
  host: process.env.HOST || '0.0.0.0',

  // Signing key for proxy URLs. A random key per boot is fine: links are
  // re-issued by the API on every resolve, and the cache keeps them valid
  // for CACHE_TTL_MS.
  proxySecret: process.env.PROXY_SECRET || randomBytes(32).toString('hex'),
  proxySecretIsEphemeral: !process.env.PROXY_SECRET,

  maxQuality: int(process.env.MAX_QUALITY, 1080),
  cacheTtlMs: int(process.env.CACHE_TTL_MS, 5 * 60 * 1000),
  upstreamTimeoutMs: int(process.env.UPSTREAM_TIMEOUT_MS, 20_000),
  proxyTimeoutMs: int(process.env.PROXY_TIMEOUT_MS, 120_000),
  stateMaxItems: 200,

  // Left empty by default: the resolver probes ./bin/yt-dlp and then PATH, so a
  // container build can vendor the binary without any env var at all.
  ytdlpPath: process.env.YTDLP_PATH || '',

  userAgent:
    process.env.UPSTREAM_UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',

  /**
   * The proxy is only ever allowed to fetch these hosts. Everything else is
   * rejected, which turns /api/proxy into a YouTube-only relay instead of an
   * open proxy / SSRF gadget.
   */
  allowedProxyHosts: [
    'googlevideo.com',
    'youtube.com',
    'youtubevideo.com',
    'ytimg.com',
    'ggpht.com',
    'googleapis.com',
    'googleusercontent.com',
    'gvt1.com',
    'gvt2.com',
    'gvt3.com',
  ],
};

export function isAllowedProxyHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/:\d+$/, '');
  return config.allowedProxyHosts.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

import { chmod, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Self-provisioning yt-dlp.
 *
 * The single most common deployment failure is a host with no yt-dlp: the
 * pure-JS @distube/ytdl-core fallback no longer parses YouTube, so the app can
 * show metadata (via oEmbed) but can never play video. Rather than requiring
 * everyone to build from the Dockerfile, we can fetch the official standalone
 * binary into ./bin at boot.
 *
 * Opt out with YTDLP_AUTOINSTALL=0.
 */

const RELEASE_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const MIRROR = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

const assetName = () =>
  process.platform === 'win32'
    ? 'yt-dlp.exe'
    : process.arch === 'arm64'
      ? 'yt-dlp_linux_aarch64'
      : 'yt-dlp_linux';

function targetPath() {
  return path.join(config.root, 'bin', assetName());
}

/**
 * @param {{timeout?: number, log?: (msg: string) => void}} [options]
 * @returns {Promise<{installed: boolean, path?: string, reason?: string, version?: string}>}
 */
export async function ensureYtdlp({ timeout = 120_000, log = console.warn } = {}) {
  if (process.env.YTDLP_AUTOINSTALL === '0') {
    return { installed: false, reason: 'disabled via YTDLP_AUTOINSTALL=0' };
  }
  // Downloading a binary into a runtime dir is surprising on a workstation, and
  // developers have yt-dlp already - so only self-install where it is missing.
  if (!process.env.CI && process.platform !== 'linux') {
    return { installed: false, reason: 'not needed on a local dev machine' };
  }

  const target = targetPath();
  if (fs.existsSync(target)) {
    return { installed: false, path: target, reason: 'already present' };
  }

  const filename = assetName();

  try {
    await mkdir(path.dirname(target), { recursive: true });

    // Resolve the real asset through the API so the URL stays correct as the
    // release asset names change over time.
    let url = `${MIRROR}/${filename}`;
    try {
      const meta = await fetch(RELEASE_API, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': config.userAgent,
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (meta.ok) {
        const release = await meta.json();
        const asset = release.assets?.find((a) => a.name === filename);
        if (asset?.browser_download_url) url = asset.browser_download_url;
      }
    } catch {
      // Fall back to the predictable /latest/download URL.
    }

    log(`[yt-dlp] not found - downloading ${filename} ...`);

    const res = await fetch(url, {
      headers: { 'user-agent': config.userAgent },
      signal: AbortSignal.timeout(timeout),
    });

    if (!res.ok) throw new Error(`download HTTP ${res.status}`);

    const bytes = Buffer.from(await res.arrayBuffer());

    // A redirect to an HTML error page is the classic way this silently
    // produces a file that cannot execute. Real payloads are either a Windows
    // PE ("MZ"), a shebang script ("#!"), or a PyInstaller bundle ("MEI" at
    // offset 0x2C - which is why an MZ-only check produced a false alarm).
    const isElf = bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
    const head2 = bytes.subarray(0, 2).toString('latin1');
    const pyinstaller = bytes.subarray(0x2c, 0x2f).toString('latin1') === 'MEI';
    const looksExecutable = head2 === 'MZ' || head2 === '#!' || isElf || pyinstaller;

    if (!looksExecutable) {
      throw new Error(
        `unexpected payload (starts with ${JSON.stringify(bytes.subarray(0, 8).toString('latin1'))}) - not a binary`,
      );
    }
    if (bytes.length < 1_000_000) {
      throw new Error(`suspiciously small (${bytes.length} bytes)`);
    }

    // Write then rename so a crashed download never leaves a broken binary
    // that a later boot would trust.
    const tmp = `${target}.download`;
    await writeFile(tmp, bytes);
    await chmod(tmp, 0o755);
    await rename(tmp, target);

    const { stdout } = await runVersion(target);
    log(`[yt-dlp] installed ${filename} -> ${target}`);
    return { installed: true, path: target, version: String(stdout).trim() };
  } catch (error) {
    try {
      await unlink(target);
    } catch {
      /* nothing to clean */
    }
    const reason = String(error?.message || error);
    log(`[yt-dlp] auto-install failed: ${reason}`);
    return { installed: false, reason };
  }
}

async function runVersion(bin) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  return promisify(execFile)(bin, ['--version'], {
    timeout: 20_000,
    windowsHide: true,
  });
}

/** Best-effort check that a vendored binary is still present and executable. */
export async function inspectVendored() {
  const target = targetPath();
  try {
    const info = await stat(target);
    return { path: target, bytes: info.size, executable: true };
  } catch {
    return { path: target, bytes: 0, executable: false };
  }
}
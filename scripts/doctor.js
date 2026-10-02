#!/usr/bin/env node
/**
 * Environment check. Runs on postinstall and via `npm run doctor`.
 * Explains exactly what is and is not available, and how to fix it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const rows = [];

rows.push(['node', process.version, Number(process.versions.node.split('.')[0]) >= 18]);

const candidates = ['yt-dlp', 'yt-dlp.exe', 'youtube-dl', 'youtube-dl.exe'];
let ytdlpVersion = null;
for (const bin of candidates) {
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 6000, windowsHide: true });
    ytdlpVersion = `${bin} ${String(stdout).trim()}`;
    break;
  } catch {
    /* keep looking */
  }
}
rows.push(['yt-dlp', ytdlpVersion || 'not installed', Boolean(ytdlpVersion)]);

let ytdlCore = null;
try {
  await import('@distube/ytdl-core');
  ytdlCore = 'installed';
} catch {
  ytdlCore = 'not installed';
}
// Marked as a warning, not a success: it is present but cannot parse current
// YouTube responses, so it is not a usable fallback.
rows.push(['ytdl-core', ytdlCore === 'installed' ? `${ytdlCore} (unreliable)` : ytdlCore, false]);

rows.push(['express', existsSync(path.join(root, 'node_modules', 'express')) ? 'installed' : 'not installed', existsSync(path.join(root, 'node_modules', 'express'))]);

console.log('');
for (const [name, value, ok] of rows) {
  console.log(`  ${name.padEnd(11)} ${ok ? green('OK') : yellow('!!')}  ${dim(String(value))}`);
}
console.log('');

if (!ytdlpVersion && ytdlCore !== 'installed') {
  console.log(red('  No stream resolver available - video playback will not work.'));
  console.log('');
  console.log('  Install one of:');
  console.log(dim('    winget install yt-dlp.yt-dlp'));
  console.log(dim('    pip install -U yt-dlp'));
  console.log(dim('    npm install @distube/ytdl-core'));
  console.log('');
} else if (!ytdlpVersion) {
  console.log(yellow('  Running on ytdl-core. Installing the yt-dlp binary is recommended,'));
  console.log(dim('  it handles YouTube changes more reliably.'));
  console.log('');
} else if (!existsSync(path.join(root, 'node_modules', 'express'))) {
  console.log(yellow('  express is missing - run `npm install`.'));
  console.log('');
} else {
  console.log(green('  Ready. Run `npm start`.'));
  console.log(dim('  note: ytdl-core is installed but no longer usable - yt-dlp is what matters.'));
  console.log('');
}

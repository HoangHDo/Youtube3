#!/usr/bin/env node
/**
 * Install-time runtime preparation.
 *
 * The app needs the yt-dlp binary. On a developer machine that is already
 * present; on a host that just ran `npm ci` (Render, Fly, Railway with the Node
 * runtime) it usually is not, and the only symptom is "No stream available".
 * Vendoring it here means the binary is on disk before the server ever boots.
 *
 * Never fatal: if the download fails we still start, and server/install.js
 * retries at boot.
 */
const isCloud =
  Boolean(process.env.CI) ||
  Boolean(process.env.RENDER) ||
  process.platform === 'linux';

if (!isCloud) {
  process.exit(0);
}

// Must never fail the install. This runs as a postinstall hook, and a
// throw here breaks `npm ci` on every host - including image builds where the
// source tree may not be present yet.
let ensureYtdlp;
try {
  ({ ensureYtdlp } = await import('../server/install.js'));
} catch (error) {
  console.log(
    `[prepare-runtime] skipped: server/install.js unavailable (${String(error?.code || error)}). ` +
      'The app retries at boot.',
  );
  process.exit(0);
}

try {
  const result = await ensureYtdlp({
    timeout: 180_000,
    log: (msg) => console.log(`[prepare-runtime] ${msg}`),
  });

  if (result.installed) {
    console.log(`[prepare-runtime] yt-dlp ready: ${result.path}`);
  } else {
    console.log(
      `[prepare-runtime] yt-dlp not installed (${result.reason}) - the app will retry at boot`,
    );
  }
} catch (error) {
  console.log(`[prepare-runtime] failed (${String(error?.message || error)}) - non-fatal`);
}

process.exit(0);
/**
 * Small UI primitives: toasts, the status pill, the settings dialog and the
 * transport icon set. Kept separate from app.js so the wiring stays readable.
 */

const toastHost = document.getElementById('toasts');
const statusPill = document.getElementById('statusPill');
const statusLabel = document.getElementById('statusLabel');

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

const TOAST_ICON = {
  info: '',
  success: '✓',
  warn: '!',
  error: '!',
};

export function toast(message, { type = 'info', timeout = 3600 } = {}) {
  if (!toastHost) return () => {};

  const node = document.createElement('div');
  node.className = `toast toast--${type}`;
  node.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const dot = document.createElement('span');
  dot.className = 'toast__dot';
  node.append(dot);

  if (TOAST_ICON[type]) {
    const icon = document.createElement('span');
    icon.textContent = TOAST_ICON[type];
    icon.style.color = 'var(--fg-dim)';
    icon.style.fontSize = '11px';
    node.append(icon);
  }

  const text = document.createElement('span');
  text.textContent = message;
  node.append(text);

  toastHost.append(node);

  // Keep the stack shallow.
  while (toastHost.children.length > 4) toastHost.firstElementChild.remove();

  const dismiss = () => {
    if (!node.isConnected || node.classList.contains('is-leaving')) return;
    node.classList.add('is-leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 400);
  };

  const timer = setTimeout(dismiss, timeout);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    dismiss();
  });

  return dismiss;
}

/* ------------------------------------------------------------------ *
 * Status pill
 * ------------------------------------------------------------------ */

const STATUS_TEXT = {
  idle: 'READY',
  ready: 'READY',
  loading: 'LOADING',
  playing: 'PLAYING',
  buffering: 'BUFFERING',
  paused: 'PAUSED',
  ended: 'ENDED',
  error: 'ERROR',
};

export function setStatus(state, label) {
  if (!statusPill) return;
  const key = STATUS_TEXT[state] ? state : 'idle';
  statusPill.dataset.state = key;
  statusLabel.textContent = label || STATUS_TEXT[key] || key.toUpperCase();
}

/* ------------------------------------------------------------------ *
 * Transport icons
 * ------------------------------------------------------------------ */

/** Swap the power button between play and pause glyphs. */
export function setPlayGlyph(button, isPlaying) {
  button.dataset.state = isPlaying ? 'playing' : 'paused';
  button.title = isPlaying ? 'Pause' : 'Play';
  button.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');

  const svg = button.querySelector('svg');
  if (!svg) return;

  if (isPlaying) {
    svg.innerHTML = '<path d="M9 5.5h2.2v13H9zM12.8 5.5H15v13h-2.2z" fill="currentColor"/>';
  } else {
    svg.innerHTML =
      '<path d="M12 4.5v7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>' +
      '<path d="M7.6 7.4a6.5 6.5 0 1 0 8.8 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>';
  }
}

export function setMuteGlyph(button, { muted, volume = 1 }) {
  const svg = button.querySelector('svg');
  if (!svg) return;

  const loud = !muted && volume > 0.05;
  button.title = muted ? 'Unmute' : 'Mute';
  button.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');

  const body = '<path d="M5 9.5h3.2L13 5.4v13.2L8.2 14.5H5z" fill="currentColor"/>';
  if (muted) {
    svg.innerHTML =
      `${body}<path d="M16 9.8l4.4 4.4M20.4 9.8 16 14.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
  } else if (loud) {
    svg.innerHTML =
      `${body}<path d="M16 9.8a3.4 3.4 0 0 1 0 4.4M18.6 7.2a7 7 0 0 1 0 9.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`;
  } else {
    svg.innerHTML = `${body}<path d="M16 9.8l4.4 4.4M20.4 9.8 16 14.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
  }
}

export function setSaveGlyph(button, isSaved) {
  button.setAttribute('aria-pressed', String(isSaved));
  button.title = isSaved ? 'Remove from saved' : 'Save video';
  const svg = button.querySelector('svg');
  if (!svg) return;
  svg.innerHTML = isSaved
    ? '<path d="M7 4h10a1 1 0 0 1 1 1v15l-6-3.4L6 20V5a1 1 0 0 1 1-1Z" fill="currentColor"/>'
    : '<path d="M7 4h10a1 1 0 0 1 1 1v15l-6-3.4L6 20V5a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>';
}

/* ------------------------------------------------------------------ *
 * Clipboard
 * ------------------------------------------------------------------ */

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatCount(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

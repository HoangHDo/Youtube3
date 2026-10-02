import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

/**
 * Tiny JSON-file store for the dashboard's persistent bits: watch history,
 * saved videos and preferences. Single-user app, so a file is plenty - and it
 * survives a restart without pulling in a database.
 */

const DEFAULTS = {
  history: [],
  saved: [],
  preferences: {
    quality: 0, // 0 = "auto", picks the best the server offers
    autoplay: true,
    volume: 1,
    catalogSource: 'local',
    catalogFeed: '',
  },
};

let state = structuredClone(DEFAULTS);
let writeChain = Promise.resolve();

function ensureDir() {
  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }
}

export function loadState() {
  try {
    ensureDir();
    if (fs.existsSync(config.stateFile)) {
      const parsed = JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
      state = {
        ...structuredClone(DEFAULTS),
        ...parsed,
        preferences: { ...DEFAULTS.preferences, ...(parsed.preferences || {}) },
      };
      for (const key of ['history', 'saved']) {
        if (!Array.isArray(state[key])) state[key] = [];
        state[key] = state[key].slice(0, config.stateMaxItems);
      }
    }
  } catch (error) {
    // A corrupt state file must never stop the server from booting.
    console.warn('[store] could not read state, starting fresh:', error.message);
    state = structuredClone(DEFAULTS);
  }
  return state;
}

/** Serialise writes so concurrent requests cannot interleave. */
function persist() {
  writeChain = writeChain.then(async () => {
    try {
      ensureDir();
      const tmp = path.join(config.dataDir, `state.${process.pid}.tmp`);
      await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
      await fsp.rename(tmp, config.stateFile);
    } catch (error) {
      console.error('[store] write failed:', error.message);
    }
  });
  return writeChain;
}

export function getState() {
  return state;
}

export function getPreferences() {
  return state.preferences;
}

export function updatePreferences(patch = {}) {
  const allowed = Object.keys(DEFAULTS.preferences);
  for (const key of allowed) {
    if (key in patch) state.preferences[key] = patch[key];
  }
  persist();
  return state.preferences;
}

/** A history entry: the minimum needed to render the list. */
function toEntry(video) {
  return {
    id: video.id,
    title: video.title,
    author: video.author,
    duration: video.duration || 0,
    thumbnail: video.thumbnail || '',
    at: Date.now(),
  };
}

export function pushHistory(video) {
  if (!video?.id) return state.history;
  state.history = [
    toEntry(video),
    ...state.history.filter((item) => item.id !== video.id),
  ].slice(0, config.stateMaxItems);
  persist();
  return state.history;
}

export function clearHistory() {
  state.history = [];
  persist();
  return state.history;
}

export function removeHistory(id) {
  state.history = state.history.filter((item) => item.id !== id);
  persist();
  return state.history;
}

export function isSaved(id) {
  return state.saved.some((item) => item.id === id);
}

export function toggleSaved(video) {
  if (!video?.id) return state.saved;
  if (isSaved(video.id)) {
    state.saved = state.saved.filter((item) => item.id !== video.id);
  } else {
    state.saved = [toEntry(video), ...state.saved].slice(0, config.stateMaxItems);
  }
  persist();
  return state.saved;
}

export function removeSaved(id) {
  state.saved = state.saved.filter((item) => item.id !== id);
  persist();
  return state.saved;
}

export function resetState() {
  state = structuredClone(DEFAULTS);
  persist();
  return state;
}

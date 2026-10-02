import { api } from './api.js';
import { formatDuration } from './catalog.js';

/**
 * Queue / History / Saved.
 *
 * The queue is session-only and lives in memory. History and Saved are owned
 * by the server (data/state.json) so they follow you across reloads and
 * browsers. A localStorage mirror keeps the UI instant on first paint and
 * covers the case where the server write failed.
 */

const STORAGE_KEY = 'cyberstream:library:v1';
const MAX_QUEUE = 50;

const listTemplate = document.getElementById('listItemTemplate');

export class Library extends EventTarget {
  constructor() {
    super();
    this.queue = [];
    this.history = [];
    this.saved = [];
    this.preferences = {};
    this.activeId = null;
  }

  /* ---------------- persistence ---------------- */

  #readMirror() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  #writeMirror() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ history: this.history, saved: this.saved, preferences: this.preferences }),
      );
    } catch {
      // Private mode / quota - the server copy is still authoritative.
    }
  }

  /** Paint from the mirror immediately, then reconcile with the server. */
  hydrate() {
    const mirror = this.#readMirror();
    if (mirror) {
      this.history = Array.isArray(mirror.history) ? mirror.history : [];
      this.saved = Array.isArray(mirror.saved) ? mirror.saved : [];
      this.preferences = mirror.preferences || {};
    }
    this.#emit('change');
    return this.#syncFromServer();
  }

  async #syncFromServer() {
    try {
      const data = await api.state();
      this.history = data.history || [];
      this.saved = data.saved || [];
      this.preferences = { ...this.preferences, ...(data.preferences || {}) };
      this.#writeMirror();
      this.#emit('change');
    } catch {
      // Offline or server restarting: the mirror is good enough.
    }
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /* ---------------- queue ---------------- */

  addToQueue(video, { play = false } = {}) {
    if (!video?.id) return;
    if (this.queue.some((item) => item.id === video.id)) {
      if (play) this.#emit('play-requested', { video });
      return;
    }
    this.queue.push(toEntry(video));
    if (this.queue.length > MAX_QUEUE) this.queue.shift();
    this.#emit('change');
    if (play) this.#emit('play-requested', { video });
  }

  playNextInQueue() {
    if (!this.queue.length) return null;
    const next = this.queue.shift();
    this.#emit('change');
    return next;
  }

  playPrevInQueue() {
    if (!this.queue.length) return null;
    return this.queue[this.queue.length - 1];
  }

  removeFromQueue(id) {
    this.queue = this.queue.filter((item) => item.id !== id);
    this.#emit('change');
  }

  clearQueue() {
    this.queue = [];
    this.#emit('change');
  }

  /* ---------------- history ---------------- */

  async pushHistory(video) {
    const entry = toEntry(video);
    this.history = [entry, ...this.history.filter((item) => item.id !== entry.id)].slice(0, 200);
    this.#writeMirror();
    this.#emit('change');
    try {
      const data = await api.watch({ id: entry.id, ...entry });
      this.history = data.history || this.history;
      this.#writeMirror();
      this.#emit('change');
    } catch {
      /* mirror already updated */
    }
  }

  async clearHistory() {
    this.history = [];
    this.#writeMirror();
    this.#emit('change');
    try {
      this.history = await api.history('clear');
    } catch {
      /* mirror already cleared */
    }
    this.#writeMirror();
    this.#emit('change');
  }

  async removeFromHistory(id) {
    this.history = this.history.filter((item) => item.id !== id);
    this.#writeMirror();
    this.#emit('change');
    try {
      this.history = await api.history('remove', id);
      this.#writeMirror();
      this.#emit('change');
    } catch {
      /* mirror already updated */
    }
  }

  /* ---------------- saved ---------------- */

  isSaved(id) {
    return this.saved.some((item) => item.id === id);
  }

  async toggleSaved(video) {
    if (!video?.id) return false;

    // Optimistic flip so the bookmark responds instantly.
    const wasSaved = this.isSaved(video.id);
    if (wasSaved) this.saved = this.saved.filter((item) => item.id !== video.id);
    else this.saved = [toEntry(video), ...this.saved];

    this.#writeMirror();
    this.#emit('change');

    try {
      const data = await api.watch({ id: video.id, ...toEntry(video), saved: !wasSaved });
      this.saved = data.saved || this.saved;
      this.history = data.history || this.history;
    } catch {
      // Revert on failure so the UI never lies about what is stored.
      if (wasSaved) this.saved = [toEntry(video), ...this.saved];
      else this.saved = this.saved.filter((i) => i.id !== video.id);
    }

    this.#writeMirror();
    this.#emit('change');
    return !wasSaved;
  }

  async removeSaved(id) {
    this.saved = this.saved.filter((item) => item.id !== id);
    this.#writeMirror();
    this.#emit('change');
    try {
      this.saved = await api.saved('remove', id);
      this.#writeMirror();
      this.#emit('change');
    } catch {
      /* mirror already updated */
    }
  }

  /* ---------------- preferences ---------------- */

  setPreference(key, value) {
    this.preferences = { ...this.preferences, [key]: value };
    this.#writeMirror();
    api.savePreferences({ [key]: value }).catch(() => {});
  }

  /* ---------------- rendering ---------------- */

  /**
   * Render one rail panel.
   * @param {'queue'|'history'|'saved'} which
   */
  renderPanel(which, listEl, emptyEl) {
    const items = which === 'queue' ? this.queue : which === 'history' ? this.history : this.saved;
    const fragment = document.createDocumentFragment();

    for (const item of items) {
      fragment.append(buildRow(item, which, this.activeId));
    }

    listEl.replaceChildren(fragment);
    emptyEl.hidden = items.length > 0;
  }
}

function toEntry(video) {
  return {
    id: video.id,
    title: video.title,
    author: video.author,
    duration: video.duration || 0,
    thumbnail: video.thumbnail || '',
  };
}

function buildRow(item, which, activeId) {
  const node = listTemplate.content.firstElementChild.cloneNode(true);
  const img = node.querySelector('.list__thumb');
  const thumbFallback = () => {
    img.removeAttribute('src');
    img.style.background = 'linear-gradient(140deg,#1c1c22,#141418)';
  };

  node.querySelector('.list__title').textContent = item.title || item.id;
  node.querySelector('.list__sub').textContent = [
    item.author,
    formatDuration(item.duration),
    which === 'queue' ? 'in queue' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  if (item.thumbnail) {
    img.addEventListener('error', thumbFallback, { once: true });
    img.src = item.thumbnail;
  } else {
    thumbFallback();
  }

  if (item.id === activeId) node.classList.add('is-active');

  node.addEventListener('click', (event) => {
    if (event.target.closest('.list__remove')) return;
    node.dispatchEvent(
      new CustomEvent('library:play', { bubbles: true, detail: { item, which } }),
    );
  });

  const remove = node.querySelector('.list__remove');
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    node.dispatchEvent(
      new CustomEvent('library:remove', { bubbles: true, detail: { id: item.id, which } }),
    );
  });

  return node;
}

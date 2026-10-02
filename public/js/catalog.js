import { api } from './api.js';

/**
 * The suggested feed under the player.
 *
 * Card markup is cloned from a <template> so we never build DOM by hand, and
 * every thumbnail gets an error handler that swaps in the grey placeholder -
 * which keeps the rail looking right when a thumbnail 404s or the CDN is
 * unreachable.
 */

const cardTemplate = document.getElementById('feedCardTemplate');

/** Give a thumbnail this long to arrive before showing the placeholder. */
const THUMBNAIL_TIMEOUT_MS = 6000;

export class Catalog {
  /**
   * @param {HTMLElement} rail
   * @param {(item: object) => void} onPick
   */
  constructor(rail, onPick) {
    this.rail = rail;
    this.onPick = onPick;
    this.items = [];
    this.source = 'local';
    this.feedUrl = '';
    this.query = '';
    this.shuffleSeed = 0;
  }

  async load({ source = 'local', url = '' } = {}) {
    const data = await api.catalog({ source, url, limit: 24 });
    this.items = Array.isArray(data.items) ? data.items : [];
    this.source = data.source;
    this.feedUrl = data.feed || '';
    this.shuffleSeed += 1;
    this.render();
    return data;
  }

  /** Items after the search filter, before shuffling. */
  #filtered() {
    const query = this.query.trim().toLowerCase();
    const base = query
      ? this.items.filter((item) =>
          `${item.title} ${item.author} ${item.tag}`.toLowerCase().includes(query),
        )
      : [...this.items];

    // Deterministic rotation on shuffle so the order does not jump on re-render.
    if (this.shuffleSeed > 0 && base.length > 1) {
      const offset = this.shuffleSeed % base.length;
      return [...base.slice(offset), ...base.slice(0, offset)];
    }
    return base;
  }

  render() {
    const items = this.#filtered();
    this.rail.replaceChildren();

    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'feed__empty';
      empty.textContent = this.query
        ? `Nothing in the catalog matches “${this.query}”.`
        : 'The catalog is empty.';
      Object.assign(empty.style, {
        gridColumn: '1 / -1',
        color: 'var(--fg-dim)',
        fontSize: '12px',
        padding: '18px 0',
        textAlign: 'center',
      });
      this.rail.append(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of items) fragment.append(this.#buildCard(item));
    this.rail.append(fragment);
  }

  #buildCard(item) {
    const node = cardTemplate.content.firstElementChild.cloneNode(true);
    const img = node.querySelector('.card__img');
    const thumb = node.querySelector('.card__thumb');

    node.querySelector('.card__title').textContent = item.title || item.id || 'Untitled';
    node.querySelector('.card__author').textContent = item.author || 'Unknown';
    node.querySelector('.card__badge').textContent = item.tag || '';
    node.querySelector('.card__dur').textContent = formatDuration(item.duration);

    if (item.thumbnail) {
      // A thumbnail can 404 (fires `error`) or simply hang when the network
      // is blocked (fires nothing). Guard both, or the card stays blank.
      const fallback = () => {
        clearTimeout(timer);
        img.classList.add('is-broken');
        thumb.classList.add('is-placeholder');
      };
      img.addEventListener('error', fallback, { once: true });
      img.addEventListener('load', () => clearTimeout(timer), { once: true });
      const timer = setTimeout(fallback, THUMBNAIL_TIMEOUT_MS);
      img.src = item.thumbnail;
    } else {
      thumb.classList.add('is-placeholder');
    }

    if (!item.loadable) {
      node.style.opacity = '0.55';
      node.title = 'This entry has no video ID and cannot be loaded';
    } else {
      node.title = `Play ${item.title}`;
      const activate = () => this.onPick(item);
      node.addEventListener('click', activate);
      node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      });
    }

    return node;
  }

  setQuery(query) {
    this.query = query;
    this.render();
  }

  shuffle() {
    this.shuffleSeed += 1;
    this.render();
    this.rail.scrollTo({ left: 0, behavior: 'smooth' });
  }

  /** Find a catalog entry by id, so a deep link can show its title instantly. */
  find(id) {
    return this.items.find((item) => item.id === id) || null;
  }
}

export function formatDuration(seconds) {
  const total = Math.floor(Number(seconds) || 0);
  if (total <= 0) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

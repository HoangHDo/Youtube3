import { api } from './api.js';
import { Catalog, formatDuration } from './catalog.js';
import { Library } from './library.js';
import { Player } from './player.js';
import {
  copyText,
  formatClock,
  formatCount,
  setMuteGlyph,
  setPlayGlyph,
  setSaveGlyph,
  setStatus,
  toast,
} from './ui.js';

/* ================================================================== *
 * Element handles
 * ================================================================== */

const $ = (id) => document.getElementById(id);

const el = {
  app: $('app'),
  loadForm: $('loadForm'),
  urlInput: $('urlInput'),
  loadBtn: $('loadBtn'),
  settingsBtn: $('settingsBtn'),
  stageFullscreenBtn: $('stageFullscreenBtn'),

  railCount: $('railCount'),
  panels: {
    queue: { list: $('queueList'), empty: $('queueEmpty') },
    history: { list: $('historyList'), empty: $('historyEmpty') },
    saved: { list: $('savedList'), empty: $('savedEmpty') },
  },

  catalogSearch: $('catalogSearch'),
  catalogSearchClear: $('catalogSearchClear'),
  catalogSourceLabel: $('catalogSourceLabel'),
  configureBtn: $('configureBtn'),

  stage: $('stage'),
  stageGlow: $('stageGlow'),
  player: $('player'),
  noSignal: $('noSignal'),
  noSignalHint: $('noSignalHint'),
  orbPlay: $('orbPlay'),
  tryDemoBtn: $('tryDemoBtn'),
  pasteUrlBtn: $('pasteUrlBtn'),

  loaderOverlay: $('loaderOverlay'),
  loaderText: $('loaderText'),

  errorBox: $('errorBox'),
  errorTitle: $('errorTitle'),
  errorBody: $('errorBody'),
  errorRetryBtn: $('errorRetryBtn'),
  errorDismissBtn: $('errorDismissBtn'),

  stageOverlay: $('stageOverlay'),
  hoverTime: $('hoverTime'),
  nowTitle: $('nowTitle'),
  nowSub: $('nowSub'),
  prevBtn: $('prevBtn'),
  playBtn: $('playBtn'),
  nextBtn: $('nextBtn'),
  theaterBtn: $('theaterBtn'),
  saveBtn: $('saveBtn'),
  shareBtn: $('shareBtn'),
  qualitySelect: $('qualitySelect'),
  muteBtn: $('muteBtn'),
  volumeRange: $('volumeRange'),

  feedRail: $('feedRail'),
  feedTag: $('feedTag'),
  feedShuffleBtn: $('feedShuffleBtn'),

  settingsModal: $('settingsModal'),
  feedUrlInput: $('feedUrlInput'),
  feedApplyBtn: $('feedApplyBtn'),
  feedResetBtn: $('feedResetBtn'),
  feedNote: $('feedNote'),
  maxQualityValue: $('maxQualityValue'),
  autoplayToggle: $('autoplayToggle'),
  diagResolver: $('diagResolver'),
  diagCore: $('diagCore'),
  diagQuality: $('diagQuality'),
  diagUptime: $('diagUptime'),
  refreshResolverBtn: $('refreshResolverBtn'),
  clearDataBtn: $('clearDataBtn'),
};

/** Big Buck Bunny - a permanently free, always-available test video. */
const DEMO = { id: 'aqz-KE-bpKQ', title: 'Big Buck Bunny 60fps 4K' };

/* ================================================================== *
 * State
 * ================================================================== */

const state = {
  current: null,        // resolved video payload
  quality: 0,           // 0 = auto
  autoplay: true,
  busy: false,
  lastInput: '',        // what the user typed, for RETRY
  activePanel: 'queue',
};

const player = new Player(el.player, { onState: onPlayerState });
const library = new Library();
const catalog = new Catalog(el.feedRail, (item) => playCatalogItem(item));

/* ================================================================== *
 * Boot
 * ================================================================== */

init();

async function init() {
  wireTopbar();
  wireStage();
  wireTransport();
  wireRail();
  wireFeed();
  wireSettings();
  wirePlayerEvents();
  wireKeyboard();

  renderEmptyState();
  setStatus('idle');
  setPlayGlyph(el.playBtn, false);
  setMuteGlyph(el.muteBtn, { muted: false, volume: 1 });

  // The catalog is what the empty screen points at, so load it first.
  await loadCatalog();
  library.hydrate();
  restorePreferences();
  applyDeepLink();

  // Surface resolver health without blocking the UI.
  api.health().then(showDiagnostics).catch(() => {});
}

function wireTopbar() {
  el.loadForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = el.urlInput.value.trim();
    if (!value) {
      el.loadForm.classList.add('is-invalid');
      el.urlInput.focus();
      setTimeout(() => el.loadForm.classList.remove('is-invalid'), 1600);
      toast('Paste a YouTube URL or video ID first.', { type: 'warn' });
      return;
    }
    play(value, { source: 'input' });
  });

  el.settingsBtn.addEventListener('click', openSettings);
  el.stageFullscreenBtn.addEventListener('click', () => player.toggleFullscreen(el.stage));
}

function wireStage() {
  el.orbPlay.addEventListener('click', () => play(DEMO.id, { source: 'demo' }));
  el.tryDemoBtn.addEventListener('click', () => play(DEMO.id, { source: 'demo' }));

  el.pasteUrlBtn.addEventListener('click', () => {
    el.urlInput.focus();
    el.urlInput.select();
    toast('Paste a YouTube link into the bar above, then press LOAD.', { type: 'info' });
  });

  // The overlay sits on top of the video, so it is the click target for both
  // pausing and resuming. The bare video click is kept as a fallback for the
  // moments the overlay is not showing (e.g. keyboard focus on the stage).
  el.stageOverlay.addEventListener('click', (event) => {
    event.stopPropagation();
    if (state.current) player.toggle();
  });

  el.player.addEventListener('click', () => {
    if (state.current && el.stageOverlay.hidden) player.toggle();
  });

  el.stageOverlay.addEventListener('mouseenter', () => el.stage.classList.add('is-hovered'));

  // Hover scrub preview.
  el.stage.addEventListener('mousemove', (event) => {
    if (!state.current || !player.duration) return;
    const rect = el.stage.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    el.hoverTime.textContent = formatClock(ratio * player.duration);
  });
  el.stage.addEventListener('mouseenter', () => el.stage.classList.add('is-hovered'));
  el.stage.addEventListener('mouseleave', () => el.stage.classList.remove('is-hovered'));
  el.stage.addEventListener('touchstart', () => el.stage.classList.add('is-hovered'), { passive: true });

  el.errorDismissBtn.addEventListener('click', hideError);
  el.errorRetryBtn.addEventListener('click', () => {
    const target = state.lastInput || state.current?.id;
    if (target) play(target, { source: 'retry', refresh: true });
  });
}

function wireTransport() {
  el.playBtn.addEventListener('click', () => {
    if (!state.current) {
      play(DEMO.id, { source: 'demo' });
      return;
    }
    player.toggle();
  });

  el.nextBtn.addEventListener('click', playNext);
  el.prevBtn.addEventListener('click', playPrev);

  el.theaterBtn.addEventListener('click', () => {
    const on = el.app.classList.toggle('is-theater');
    el.theaterBtn.setAttribute('aria-pressed', String(on));
    if (on) el.stage.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  el.saveBtn.addEventListener('click', async () => {
    if (!state.current) {
      toast('Load a video first.', { type: 'warn' });
      return;
    }
    const nowSaved = await library.toggleSaved(state.current);
    setSaveGlyph(el.saveBtn, nowSaved);
    toast(nowSaved ? 'Saved to your library.' : 'Removed from saved.', {
      type: nowSaved ? 'success' : 'info',
    });
  });

  el.shareBtn.addEventListener('click', async () => {
    if (!state.current) {
      toast('Load a video first.', { type: 'warn' });
      return;
    }
    const url = `${location.origin}/?v=${state.current.id}`;
    history.replaceState(null, '', `?v=${state.current.id}`);
    const ok = await copyText(url);
    toast(ok ? 'Share link copied to clipboard.' : `Share link: ${url}`, {
      type: ok ? 'success' : 'info',
      timeout: ok ? 2600 : 8000,
    });
  });

  el.qualitySelect.addEventListener('change', () => {
    state.quality = Number(el.qualitySelect.value) || 0;
    library.setPreference('quality', state.quality);

    if (!state.current) return;

    // Switching quality inside an HLS master is a level switch, not a new
    // stream - do it in place so playback is not interrupted.
    if (player.sourceKind === 'hls' && state.quality) {
      if (player.setHlsQuality(state.quality)) {
        toast(`Switched to ${state.quality}p.`, { type: 'info', timeout: 1600 });
        return;
      }
    }
    play(state.current.id, { source: 'quality', refresh: false });
  });

  el.muteBtn.addEventListener('click', () => {
    player.muted = !player.muted;
    if (!player.muted && player.volume === 0) player.volume = state.lastVolume || 0.6;
  });

  el.volumeRange.addEventListener('input', () => {
    const value = Number(el.volumeRange.value) / 100;
    state.lastVolume = value;
    player.volume = value;
    if (value > 0) player.muted = false;
  });

  document.addEventListener('keydown', (event) => {
    if (event.code === 'KeyM' && !isTyping(event) && state.current) {
      player.muted = !player.muted;
    }
  });
}

function wireRail() {
  for (const tab of document.querySelectorAll('.rail__tab')) {
    tab.addEventListener('click', () => {
      const panel = tab.dataset.panel;
      state.activePanel = panel;

      for (const other of document.querySelectorAll('.rail__tab')) {
        const on = other === tab;
        other.classList.toggle('is-active', on);
        other.setAttribute('aria-selected', String(on));
      }
      for (const [name, refs] of Object.entries(el.panels)) {
        $(`panel-${name}`).classList.toggle('is-active', name === panel);
      }
      renderRail();
    });
  }

  el.catalogSearch.addEventListener('input', () => {
    const query = el.catalogSearch.value;
    el.catalogSearchClear.hidden = !query;
    catalog.setQuery(query);
  });

  el.catalogSearchClear.addEventListener('click', () => {
    el.catalogSearch.value = '';
    el.catalogSearchClear.hidden = true;
    catalog.setQuery('');
  });

  el.configureBtn.addEventListener('click', openSettings);

  // Delegated rail interactions.
  el.app.addEventListener('library:play', (event) => {
    const { item } = event.detail;
    if (item.id) play(item.id, { source: 'library' });
  });

  el.app.addEventListener('library:remove', (event) => {
    const { id, which } = event.detail;
    if (which === 'queue') library.removeFromQueue(id);
    if (which === 'history') library.removeFromHistory(id);
    if (which === 'saved') library.removeSaved(id);
  });

  library.addEventListener('change', () => {
    renderRail();
    updateSaveGlyph();
  });

  library.addEventListener('play-requested', (event) => {
    play(event.detail.video.id, { source: 'queue' });
  });
}

function wireFeed() {
  el.feedShuffleBtn.addEventListener('click', () => {
    catalog.shuffle();
    toast('Feed shuffled.', { type: 'info', timeout: 1800 });
  });
}

function wireSettings() {
  el.feedApplyBtn.addEventListener('click', async () => {
    const url = el.feedUrlInput.value.trim();
    if (!url) {
      note('Enter a feed URL first.', 'error');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      note('The URL must start with http:// or https://', 'error');
      return;
    }
    note('Loading feed...', '');
    const data = await loadCatalog({ source: 'feed', url });
    if (data?.warning) note(data.warning, 'error');
    else {
      note(`Loaded ${data.items.length} videos from the feed.`, 'ok');
      library.setPreference('catalogSource', 'feed');
      library.setPreference('catalogFeed', url);
    }
  });

  el.feedResetBtn.addEventListener('click', async () => {
    el.feedUrlInput.value = '';
    const data = await loadCatalog({ source: 'local' });
    note(`Back to the ${data.items.length}-video local catalog.`, 'ok');
    library.setPreference('catalogSource', 'local');
    library.setPreference('catalogFeed', '');
  });

  el.autoplayToggle.addEventListener('change', () => {
    state.autoplay = el.autoplayToggle.checked;
    library.setPreference('autoplay', state.autoplay);
  });

  el.refreshResolverBtn.addEventListener('click', async () => {
    el.refreshResolverBtn.disabled = true;
    try {
      const data = await api.reProbe();
      note(data.ytdlp?.ok ? `yt-dlp ${data.ytdlp.version} detected.` : 'yt-dlp still not found.', data.ytdlp?.ok ? 'ok' : 'error');
      showDiagnostics(await api.health());
    } finally {
      el.refreshResolverBtn.disabled = false;
    }
  });

  el.clearDataBtn.addEventListener('click', async () => {
    await library.clearHistory();
    await api.saved('reset').catch(() => {});
    library.saved = [];
    library.dispatchEvent(new Event('change'));
    toast('History and saved videos cleared.', { type: 'success' });
  });
}

function wirePlayerEvents() {
  player.addEventListener('timeupdate', () => {
    if (!state.current) return;
    el.hoverTime.textContent = `${formatClock(player.currentTime)} / ${formatClock(player.duration)}`;
  });

  player.addEventListener('loadedmetadata', () => {
    el.player.classList.add('is-visible');
  });

  player.addEventListener('pause', () => {
    if (!state.current) return;
    el.player.classList.add('is-paused');
    el.stage.classList.add('is-paused');
    el.stageOverlay.hidden = false;
    el.stageOverlay.setAttribute('aria-label', 'Resume playback');
  });

  player.addEventListener('play', () => {
    el.player.classList.remove('is-paused');
    el.stage.classList.remove('is-paused');
    el.stageOverlay.hidden = true;
  });

  player.addEventListener('error', (event) => {
    const detail = event.detail || {};
    showError('Playback error', [detail.message, detail.hint].filter(Boolean).join(' '));
  });

  player.addEventListener('ended', () => {
    if (state.autoplay) playNext({ auto: true });
  });

  player.addEventListener('volumechange', () => {
    el.volumeRange.value = String(Math.round(player.volume * 100));
    setMuteGlyph(el.muteBtn, { muted: player.muted, volume: player.volume });
  });
}

function wireKeyboard() {
  document.addEventListener('keydown', (event) => {
    if (isTyping(event)) {
      if (event.key === 'Escape') event.target.blur();
      return;
    }

    switch (event.key) {
      case ' ':
      case 'k':
        event.preventDefault();
        if (state.current) player.toggle();
        else play(DEMO.id, { source: 'demo' });
        break;
      case 'ArrowRight':
        if (state.current) { event.preventDefault(); player.skip(10); }
        break;
      case 'ArrowLeft':
        if (state.current) { event.preventDefault(); player.skip(-10); }
        break;
      case 'l':
        if (state.current) player.enterPictureInPicture();
        break;
      case 'f':
        player.toggleFullscreen(el.stage);
        break;
      case 't':
        el.theaterBtn.click();
        break;
      case 's':
        el.saveBtn.click();
        break;
      case 'n':
        playNext();
        break;
      case 'p':
        playPrev();
        break;
      case '/':
        event.preventDefault();
        el.catalogSearch.focus();
        break;
      case 'Escape':
        hideError();
        break;
      default:
        break;
    }
  });
}

function isTyping(event) {
  const target = event.target;
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  );
}

/* ================================================================== *
 * Playback
 * ================================================================== */

/**
 * Resolve an input (URL or id) and start playing it.
 * @param {string} input
 * @param {{source?: string, refresh?: boolean}} [options]
 */
async function play(input, { source = 'input', refresh = false } = {}) {
  if (state.busy) {
    // The LOAD button is disabled while busy, but Enter in the input still
    // submits. Say so rather than silently dropping the request.
    toast('Still loading the previous video - one moment.', { type: 'warn', timeout: 2200 });
    return;
  }

  state.lastInput = input;
  hideError();
  setBusy(true);
  setStatus('loading');
  el.loaderText.textContent =
    source === 'demo' ? 'Loading demo stream' : source === 'library' ? 'Loading from library' : 'Resolving stream';

  // Remember the optimistic title from the feed while we wait.
  const preview = catalog.find(extractId(input));
  if (preview) setNowPlaying(preview, { pending: true });

  const controller = new AbortController();

  try {
    const video = await api.resolve(input, {
      quality: state.quality,
      refresh,
      signal: controller.signal,
    });

    if (!video.playable) {
      showError(
        'No stream available',
        video.degraded
          ? 'Metadata loaded but no stream could be extracted, which almost always means the ' +
            'server has no working yt-dlp. Check the settings panel for the resolver status, ' +
            'and confirm the server log does not say "yt-dlp unavailable".'
          : 'This video has no downloadable stream (it may be private, region locked, or a live premiere).',
      );
      setStatus('error');
      return;
    }

    await player.load(video, { quality: state.quality, autoplay: state.autoplay });

    state.current = video;
    library.activeId = video.id;
    history.replaceState(null, '', `?v=${video.id}`);

    setNowPlaying(video);
    populateQuality(video);
    updateSaveGlyph();
    tintStage(video);
    library.pushHistory(video);
    library.addToQueue(video);
    el.noSignal.hidden = true;
    hideError();

    // The player emitted its state changes while `state.current` was still
    // null, so the pill never got the final value. Sync it now.
    onPlayerState(player.state);
  } catch (error) {
    if (error?.code === 'timeout' || error?.name === 'AbortError') return;
    showError('Stream unavailable', friendlyError(error));
    setStatus('error');
    if (preview) setNowPlaying(preview, { pending: true });
  } finally {
    setBusy(false);
  }
}

function playNext({ auto = false } = {}) {
  const next = library.playNextInQueue();
  if (!next) {
    if (auto) {
      setNowPlayingIdle();
      player.reset();
      el.player.classList.remove('is-visible');
      el.noSignal.hidden = false;
      el.noSignalHint.textContent = 'Queue is empty. Pick another video from the feed below.';
      setStatus('idle');
      el.stageOverlay.hidden = true;
      el.stage.classList.remove('is-paused');
    } else {
      toast('Nothing queued.', { type: 'info', timeout: 1800 });
    }
    return;
  }
  play(next.id, { source: 'queue' });
}

function playPrev() {
  const prev = library.playPrevInQueue();
  if (!prev) {
    // Nothing queued: nudge back 10s like a normal player.
    if (state.current) {
      player.seek(0);
      toast('Back to start.', { type: 'info', timeout: 1500 });
    }
    return;
  }
  play(prev.id, { source: 'queue' });
}

function playCatalogItem(item) {
  if (!item.loadable) {
    toast('That entry has no video ID, so it cannot be loaded.', { type: 'warn' });
    return;
  }
  play(item.id, { source: 'feed' });
}

/** Pull an 11-char id out of anything, for the optimistic preview lookup. */
function extractId(input) {
  const match = String(input || '').match(/[A-Za-z0-9_-]{11}/);
  return match ? match[0] : null;
}

/* ================================================================== *
 * Rendering
 * ================================================================== */

function setNowPlaying(video, { pending = false } = {}) {
  el.nowTitle.textContent = video.title || '— No video loaded —';
  const bits = [video.author];

  if (pending) bits.push('resolving...');
  else if (video.viewCount) bits.push(`${formatCount(video.viewCount)} views`);
  if (video.duration) bits.push(formatDuration(video.duration));
  if (video.live) bits.push('LIVE');

  const source = video.source ? `via ${video.source}` : '';
  if (source) bits.push(source);

  el.nowSub.textContent = bits.filter(Boolean).join(' · ');
  el.nowSub.classList.toggle('is-live', Boolean(video.live));
}

function setNowPlayingIdle() {
  el.nowTitle.textContent = '— No video loaded —';
  el.nowSub.textContent = 'Ready to play';
  el.nowSub.classList.remove('is-live');
  state.current = null;
  library.activeId = null;
}

/** Derive a stage glow colour from the thumbnail so each video feels distinct. */
function tintStage(video) {
  if (!video.thumbnail) {
    el.stageGlow.style.background = 'radial-gradient(circle at 50% 45%, rgba(224,30,43,.16), transparent 55%)';
    return;
  }

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = video.thumbnail;
  img.addEventListener('load', () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 8;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 8, 8);
      const { data } = ctx.getImageData(0, 0, 8, 8);

      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
      }
      const n = data.length / 4;
      r = Math.round(r / n);
      g = Math.round(g / n);
      b = Math.round(b / n);

      el.stageGlow.style.background =
        `radial-gradient(circle at 50% 45%, rgba(${r},${g},${b},0.30), transparent 58%)`;
    } catch {
      // Canvas tainted or unsupported - keep the default red glow.
    }
  }, { once: true });
}

function populateQuality(video) {
  const ladder = video.ladder || [];
  const options = [{ value: 0, label: 'AUTO' }];

  // YouTube's HLS ladder includes preview-sized renditions (27p, 45p, 90p...)
  // that are never worth offering a human. Keep the picker useful.
  const MIN_PICKABLE = 240;
  let heights = [...new Set(ladder.map((q) => q.height).filter(Boolean))]
    .filter((h) => h >= MIN_PICKABLE && h <= 1440)
    .sort((a, b) => b - a);

  // If this video has nothing that big, fall back to whatever it does have.
  if (!heights.length) {
    heights = [...new Set(ladder.map((q) => q.height).filter(Boolean))]
      .sort((a, b) => b - a)
      .slice(0, 4);
  }

  for (const height of heights) options.push({ value: height, label: `${height}P` });

  el.qualitySelect.replaceChildren();
  for (const option of options) {
    const node = document.createElement('option');
    node.value = String(option.value);
    node.textContent = option.label;
    el.qualitySelect.append(node);
  }
  el.qualitySelect.value = String(state.quality);
  el.qualitySelect.disabled = options.length <= 1;
}

function renderEmptyState() {
  el.nowTitle.textContent = '— No video loaded —';
  el.nowSub.textContent = 'Ready to play';
  el.noSignal.hidden = false;
  el.stageOverlay.hidden = true;
  el.stage.classList.remove('is-paused');
}

function renderRail() {
  const panel = el.panels[state.activePanel];
  if (!panel) return;

  library.renderPanel(state.activePanel, panel.list, panel.empty);

  const items =
    state.activePanel === 'queue'
      ? library.queue
      : state.activePanel === 'history'
        ? library.history
        : library.saved;
  el.railCount.textContent = items.length || '';
}

function updateSaveGlyph() {
  setSaveGlyph(el.saveBtn, Boolean(state.current && library.isSaved(state.current.id)));
}

function onPlayerState(next) {
  if (!state.current) {
    setStatus('idle');
    el.stageOverlay.hidden = true;
    el.stage.classList.remove('is-paused');
    return;
  }

  const isPlaying = next === 'playing';
  setPlayGlyph(el.playBtn, isPlaying);

  const map = {
    playing: 'playing',
    buffering: 'loading',
    paused: 'paused',
    ended: 'ended',
    error: 'error',
  };
  setStatus(map[next] || 'ready');

  el.player.classList.toggle('is-paused', !isPlaying);
  el.stage.classList.toggle('is-paused', !isPlaying);

  // Show the resume affordance whenever playback is not running. Ended counts
  // as paused so the video can be restarted by hand.
  el.stageOverlay.hidden = isPlaying;
  el.stageOverlay.setAttribute('aria-label', isPlaying ? 'Pause playback' : 'Resume playback');
}

/* ================================================================== *
 * Loading / errors
 * ================================================================== */

function setBusy(busy) {
  state.busy = busy;
  el.loaderOverlay.hidden = !busy;
  el.loadBtn.disabled = busy;
  el.loadBtn.textContent = busy ? 'LOADING' : 'LOAD';
}

function showError(title, body) {
  el.errorTitle.textContent = title;
  el.errorBody.textContent = body;
  el.errorBox.hidden = false;
  el.noSignal.hidden = true;
}

function hideError() {
  el.errorBox.hidden = true;
}

function friendlyError(error) {
  const map = {
    bad_video_reference: 'That is not a YouTube URL or video ID. Check the link and try again.',
    resolve_failed: 'Could not resolve this video. It may be private, deleted, or region locked.',
    timeout: 'The server took too long to respond. Check that it is running and try again.',
    network_error: 'Could not reach the CYBERSTREAM server. Is it running?',
  };
  const base = map[error?.code] || error?.message || 'Something went wrong.';

  // Surface the resolver's own diagnosis when we have one - it is usually
  // the difference between "install yt-dlp" and "try another video".
  if (error?.detail && /yt-dlp unavailable|no yt-dlp binary found/i.test(error.detail)) {
    return (
      'The server has no working yt-dlp, so nothing can be streamed. ' +
      'Install it (pip install -U yt-dlp), or deploy with the included Dockerfile / render.yaml ' +
      'which bakes the binary in.'
    );
  }
  return base;
}

function note(message, kind) {
  el.feedNote.textContent = message;
  el.feedNote.className = `field__note${kind ? ` is-${kind}` : ''}`;
}

/* ================================================================== *
 * Catalog / settings
 * ================================================================== */

async function loadCatalog(options) {
  try {
    const data = await catalog.load(options);
    el.catalogSourceLabel.textContent = data.source === 'feed' ? 'Custom feed' : 'Local catalog';
    el.feedTag.textContent = data.source === 'feed' ? 'FEED' : 'CURATED';
    el.feedUrlInput.value = data.feed || library.preferences.catalogFeed || '';
    return data;
  } catch (error) {
    toast(`Could not load the catalog: ${error.message}`, { type: 'error' });
    return null;
  }
}

async function openSettings() {
  if (typeof el.settingsModal.showModal === 'function') el.settingsModal.showModal();
  else el.settingsModal.setAttribute('open', '');

  api.health()
    .then(showDiagnostics)
    .catch(() => {
      el.diagResolver.textContent = 'unreachable';
      el.diagResolver.className = 'is-warn';
    });
}

function showDiagnostics(health) {
  const r = health?.resolver || {};
  const ytdlp = r.ytdlp;

  if (ytdlp) {
    el.diagResolver.textContent = `${ytdlp}${r.ytdlpBin ? ` (${shortBin(r.ytdlpBin)})` : ''}`;
    el.diagResolver.className = 'is-ok';
  } else {
    // The single most common deployment failure, so say exactly what to do.
    el.diagResolver.textContent = 'not installed';
    el.diagResolver.className = 'is-warn';
    el.diagResolver.title =
      r.ytdlpError ||
      'Install yt-dlp, or build via the provided Dockerfile which vendors it into ./bin.';
  }

  // Be honest rather than optimistic: this fallback no longer works.
  el.diagCore.textContent = 'unreliable (fails on most videos)';
  el.diagCore.className = 'is-warn';
  el.diagCore.title =
    '@distube/ytdl-core cannot parse current YouTube responses. yt-dlp is required.';

  el.diagQuality.textContent = `${health?.maxQuality ?? '?'}p`;
  el.maxQualityValue.textContent = `${health?.maxQuality ?? '?'}p`;
  el.diagUptime.textContent = formatClock(health?.uptimeSeconds ?? 0);
}

/** Keep a binary path readable in a narrow settings row. */
function shortBin(bin) {
  if (!bin) return '';
  // Handle both separators: a Windows path must not be left to run off the row.
  const parts = bin.split(/[\\/]/).filter(Boolean);
  return parts.length <= 1 ? bin : `…${parts.slice(-1).join('')}`;
}

function restorePreferences() {
  const prefs = library.preferences || {};
  state.autoplay = prefs.autoplay !== false;
  el.autoplayToggle.checked = state.autoplay;

  if (prefs.volume !== undefined) {
    const volume = Math.min(1, Math.max(0, Number(prefs.volume)));
    player.volume = volume;
    el.volumeRange.value = String(Math.round(volume * 100));
  }
  if (prefs.quality) {
    state.quality = Number(prefs.quality) || 0;
  }
}

function applyDeepLink() {
  const id = new URLSearchParams(location.search).get('v');
  if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) {
    el.urlInput.value = id;
    play(id, { source: 'deeplink' });
  }
}

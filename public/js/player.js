import { attachHls, nativeHlsSupported } from './player-hls.js';

/**
 * Wraps the <video> element and normalises the difference between the
 * progressive-MP4 and HLS paths.
 *
 * Playback priority:
 *   1. progressive MP4  - one signed URL, native playback, no library
 *   2. HLS              - adaptive, higher quality ceilings
 *
 * Switching sources always tears the old one down first, otherwise the media
 * element keeps buffering the previous playlist in the background.
 */
export class Player extends EventTarget {
  /**
   * @param {HTMLVideoElement} video
   * @param {{onState?: (state: string) => void}} [options]
   */
  constructor(video, { onState } = {}) {
    super();
    this.video = video;
    this.onState = onState || (() => {});

    this.current = null; // resolved video payload
    this.hlsHandle = null;
    this.sourceKind = null;
    this.autoplay = true;
    this.destroyed = false;

    this.#wireEvents();
  }

  #wireEvents() {
    const { video } = this;

    video.addEventListener('loadstart', () => this.#emit('loadstart'));
    video.addEventListener('loadedmetadata', () => {
      this.#emit('loadedmetadata');
      // A paused video that was already played should sit on its poster frame
      // rather than a black rectangle.
      this.#setState();
    });
    video.addEventListener('canplay', () => this.#emit('canplay'));
    video.addEventListener('play', () => {
      this.#setState();
      this.#emit('play');
    });
    video.addEventListener('pause', () => {
      this.#setState();
      this.#emit('pause');
    });
    video.addEventListener('waiting', () => {
      this.#setState();
      this.#emit('waiting');
    });
    video.addEventListener('playing', () => {
      this.#setState();
      this.#emit('playing');
    });
    video.addEventListener('timeupdate', () => this.#emit('timeupdate'));
    video.addEventListener('ended', () => {
      this.#setState();
      this.#emit('ended');
    });
    video.addEventListener('error', () => this.#emit('error', this.#describeError()));
    video.addEventListener('volumechange', () => this.#emit('volumechange'));
    video.addEventListener('enterpictureinpicture', () => this.#emit('pip'));
    video.addEventListener('leavepictureinpicture', () => this.#emit('pip'));
  }

  #setState() {
    this.onState(this.state);
  }

  get state() {
    if (!this.current) return 'idle';
    if (this.video.error) return 'error';
    if (this.video.ended) return 'ended';
    if (this.video.seeking) return 'buffering';
    if (this.#isBuffering()) return 'buffering';
    if (this.video.paused) return 'paused';
    return 'playing';
  }

  #isBuffering() {
    // readyState 2 = HAVE_CURRENT_DATA; below that we are stalled.
    return this.video.networkState === 2 && this.video.readyState < 2 && !this.video.paused;
  }

  #emit(type, detail) {
    if (this.destroyed) return;
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * Point the player at a resolved video.
   *
   * @param {object} video   payload from POST /api/resolve
   * @param {{quality?: 'auto'|number, autoplay?: boolean}} [options]
   */
  async load(video, { quality = 'auto', autoplay = true } = {}) {
    this.#teardownSource();

    this.current = video;
    this.autoplay = autoplay;

    if (!video.playable) {
      this.#setState();
      throw new Error('No playable stream was returned for this video.');
    }

    const kind = this.#chooseKind(quality);
    if (!kind) {
      this.#setState();
      throw new Error('This video has no stream at or below the selected quality.');
    }

    this.sourceKind = kind;

    if (kind === 'hls') {
      this.hlsHandle = await attachHls(this.video, video.streams.hls.url);
    } else {
      this.video.src = video.streams.progressive.url;
    }

    this.#setState();
    this.#emit('source', { kind, video });

    if (autoplay) {
      await this.play();
    }
  }

  /**
   * Decide between progressive and HLS. HLS is used when the user asked for a
   * height that progressive cannot reach, or when there is no progressive
   * stream at all.
   */
  #chooseKind(quality) {
    const { streams } = this.current;
    if (!streams) return null;

    if (quality === 'auto' || !Number(quality)) {
      if (streams.progressive) return 'progressive';
      return streams.hls ? 'hls' : null;
    }

    const wanted = Number(quality);
    const progressiveHeight = streams.progressive?.height || 0;

    if (streams.progressive && progressiveHeight >= wanted) return 'progressive';
    if (streams.hls && (streams.hls.height || 0) >= wanted) return 'hls';
    if (streams.progressive) return 'progressive';
    return streams.hls ? 'hls' : null;
  }

  /** Heights the active HLS source can switch between, descending. */
  hlsHeights() {
    return this.hlsHandle?.heights ? this.hlsHandle.heights() : [];
  }

  /**
   * Pin the active HLS source to a height, or pass 0 to return to automatic
   * adaptation. Returns false when the source cannot honour the request, so the
   * caller can fall back to re-resolving.
   */
  setHlsQuality(height) {
    if (!this.hlsHandle?.setQuality) return false;
    return this.hlsHandle.setQuality(height);
  }

  async play() {
    try {
      await this.video.play();
    } catch (error) {
      // Autoplay policies are normal, not a failure worth surfacing loudly.
      if (error?.name !== 'AbortError' && error?.name !== 'NotAllowedError') throw error;
    }
  }

  pause() {
    this.video.pause();
  }

  toggle() {
    if (this.video.paused || this.video.ended) this.play();
    else this.pause();
  }

  seek(seconds) {
    if (!Number.isFinite(seconds)) return;
    this.video.currentTime = Math.max(0, Math.min(seconds, this.duration || seconds));
  }

  skip(delta) {
    this.seek(this.video.currentTime + delta);
  }

  get duration() {
    return Number.isFinite(this.video.duration) ? this.video.duration : 0;
  }

  get currentTime() {
    return this.video.currentTime || 0;
  }

  get volume() {
    return this.video.volume;
  }

  set volume(value) {
    this.video.volume = Math.min(1, Math.max(0, value));
  }

  get muted() {
    return this.video.muted;
  }

  set muted(value) {
    this.video.muted = Boolean(value);
  }

  setPlaybackRate(rate) {
    this.video.playbackRate = rate;
  }

  async enterPictureInPicture() {
    if (!document.pictureInPictureEnabled) return false;
    if (this.video.disablePictureInPicture) return false;
    try {
      if (document.pictureInPictureElement === this.video) await document.exitPictureInPicture();
      else await this.video.requestPictureInPicture();
      return true;
    } catch {
      return false;
    }
  }

  /** Fullscreen the given element, falling back to the document. */
  async toggleFullscreen(element) {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return false;
      }
      await (element || this.video).requestFullscreen();
      return true;
    } catch {
      return false;
    }
  }

  #teardownSource() {
    if (this.hlsHandle) {
      try {
        this.hlsHandle.destroy?.();
      } catch {
        /* already gone */
      }
      this.hlsHandle = null;
    }
    try {
      this.video.pause();
    } catch {
      /* nothing playing */
    }
    this.video.removeAttribute('src');
    // Force the element to drop any buffered data so the next load starts clean.
    try {
      this.video.load();
    } catch {
      /* jsdom / older engines */
    }
    this.sourceKind = null;
  }

  /** Stop playback and forget the current video. */
  reset() {
    this.#teardownSource();
    this.current = null;
    this.#setState();
  }

  destroy() {
    this.destroyed = true;
    this.#teardownSource();
  }

  #describeError() {
    const error = this.video.error;
    if (!error) return { code: 'unknown', message: 'Unknown playback error' };

    const messages = {
      1: 'Playback was aborted.',
      2: 'A network error interrupted the stream.',
      3: 'The stream could not be decoded.',
      4: 'This video is not available, or the source failed.',
    };

    const hints = {
      2: 'The signed link may have expired - press RETRY to re-resolve.',
      4: 'Try a different quality, or the video may be region/age restricted.',
    };

    return {
      code: `media_${error.code}`,
      message: messages[error.code] || 'Playback failed.',
      hint: hints[error.code] || '',
    };
  }
}

export { nativeHlsSupported };

/* ============================================================
 * RESONANCE — clock.js
 * GameClock: gameplay time sourced from the audio playback clock.
 *   songTime = audioCtx.currentTime − scheduledStart + calibration
 * Animation frames only READ the clock; they never drive it.
 * ============================================================ */
(function () {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const RS = G.RS = G.RS || {};

  class GameClock {
    /* rawNow: () => seconds (audio-clock based, may be negative pre-start) */
    constructor(rawNow) {
      this.rawNow = rawNow;
      this.t = 0;
      this.paused = false;
      this._lastRaw = null;
    }
    now() { return this.t; }
    /* call once per animation frame */
    update() {
      if (this.paused) return this.t;
      const raw = this.rawNow();
      if (!isFinite(raw)) return this.t;
      if (this._lastRaw === null || Math.abs(raw - this.t) > 0.25) this.t = raw; /* snap after seeks */
      else this.t += (raw - this.t) * 0.55; /* light smoothing vs audio-thread jitter */
      this._lastRaw = raw;
      return this.t;
    }
    sync() { this.t = this.rawNow(); this._lastRaw = this.t; return this.t; }
  }

  RS.GameClock = GameClock;
  if (typeof module !== 'undefined' && module.exports) module.exports = GameClock;
})();

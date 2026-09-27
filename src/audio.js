/* ============================================================
 * RESONANCE — audio.js (browser only)
 * AudioEngine: Web Audio playback, latency-aware clock source,
 * live frequency bands for the reactive world, synthesized SFX.
 * ============================================================ */
(function () {
  'use strict';
  if (typeof window === 'undefined') return; /* Node tests skip this file */
  const RS = window.RS = window.RS || {};
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.musicGain = null;
      this.sfxGain = null;
      this.analyser = null;
      this.source = null;
      this.buffer = null;
      this.startAt = 0;       /* ctx time when song starts */
      this.playing = false;
      this.paused = false;
      this._bands = { bass: 0, mid: 0, high: 0, level: 0, beatPulse: 0 };
      this._freqData = null;
      this._endCb = null;
      this.settings = { volume: 0.85, sfx: true, sfxVolume: 0.5 };
    }
    ensureCtx() {
      if (this.ctx) return this.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = this.settings.volume;
      this.musicGain.connect(this.ctx.destination);
      /* gentle glue compressor + per-song trim keep every upload at a
         consistent, non-clipping level (chain: source → analyser → trim →
         compressor → musicGain → destination) */
      this.compressor = this.ctx.createDynamicsCompressor
        ? this.ctx.createDynamicsCompressor() : null;
      if (this.compressor) {
        this.compressor.threshold.value = -18;
        this.compressor.knee.value = 12;
        this.compressor.ratio.value = 4;
        this.compressor.attack.value = 0.004;
        this.compressor.release.value = 0.22;
        this.compressor.connect(this.musicGain);
      }
      this.trimGain = this.ctx.createGain();
      this.trimGain.gain.value = 1;
      this.trimGain.connect(this.compressor || this.musicGain);
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = this.settings.sfx ? this.settings.sfxVolume * 0.5 : 0;
      this.sfxGain.connect(this.ctx.destination);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.55;
      this.analyser.connect(this.trimGain);
      this._freqData = new Uint8Array(this.analyser.frequencyBinCount);
      return this.ctx;
    }

    /* per-song loudness trim: target ~ -20 dBFS RMS, clamped to sane range */
    setTrimForRms(rms) {
      if (!this.trimGain) return 1;
      const g = clamp(0.1 / Math.max(1e-4, rms), 0.5, 3.2);
      this.trimGain.gain.value = g;
      return g;
    }

    /* ---------- tap-test calibration beeps (routed via musicGain) ---------- */
    scheduleBeep(when, freq) {
      const ctx = this.ensureCtx();
      if (!ctx || !this.musicGain) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq || 880;
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(0.4, when + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0008, when + 0.12);
      o.connect(g); g.connect(this.musicGain);
      o.start(when); o.stop(when + 0.14);
    }
    async unlock() {
      const ctx = this.ensureCtx();
      if (ctx && ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { } }
    }
    async decode(arrayBuffer) {
      const ctx = this.ensureCtx();
      if (!ctx) throw new Error('Web Audio unavailable');
      if (ctx.decodeAudioData.length >= 1) {
        return await new Promise((resolve, reject) => {
          const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
          if (p && p.then) p.then(resolve, reject);
        });
      }
      return await ctx.decodeAudioData(arrayBuffer);
    }
    bufferFromSamples(samples, sampleRate) {
      const ctx = this.ensureCtx();
      const buf = ctx.createBuffer(1, samples.length, sampleRate);
      buf.getChannelData(0).set(samples);
      return buf;
    }
    /* returns ctx-time at which playback begins */
    play(buffer, leadSeconds) {
      const ctx = this.ensureCtx();
      this.stop();
      this.buffer = buffer;
      this.source = ctx.createBufferSource();
      this.source.buffer = buffer;
      this.source.connect(this.analyser);
      const lead = Math.max(0.05, leadSeconds || 0.1);
      this.startAt = ctx.currentTime + lead;
      this.source.start(this.startAt);
      this.playing = true;
      this.paused = false;
      /* wall-clock fallback bookkeeping (autoplay-blocked contexts) */
      this._wallT0 = performance.now() / 1000;
      this._wallPos = -lead;
      this._frozen = false;
      this._frozenFor = 0;
      this._lastCt = ctx.currentTime;
      this.source.onended = () => {
        if (this.playing && this._endCb && !this.paused) this._endCb();
      };
      return this.startAt;
    }

    /* call every frame while a song plays: detects an audio clock that is
       not advancing (context blocked/suspended by the browser) and falls
       back to wall time so the game stays playable — silently. */
    tickWatchdog(dt) {
      if (!this.playing || this.paused || !this.ctx) return;
      const ct = this.ctx.currentTime;
      if (ct > this._lastCt + 1e-4) {
        this._lastCt = ct;
        this._frozenFor = 0;
        this._frozen = false;
        return;
      }
      this._frozenFor += dt;
      if (this.ctx.state === 'suspended') { try { this.ctx.resume(); } catch (e) { } }
      if (this._frozenFor > 1.2) this._frozen = true;
    }
    onEnded(cb) { this._endCb = cb; }
    stop() {
      if (this.source) {
        try { this.source.onended = null; this.source.stop(); } catch (e) { }
        this.source.disconnect();
        this.source = null;
      }
      this.playing = false;
      this._frozen = false;
    }
    async pause() {
      if (!this.ctx || !this.playing || this.paused) return;
      this._wallPos = this.songTime(); /* capture position in either mode */
      this.paused = true;
      try { await this.ctx.suspend(); } catch (e) { }
    }
    async resume() {
      if (!this.ctx || !this.paused) return;
      this._wallT0 = performance.now() / 1000; /* rebase wall clock */
      try { await this.ctx.resume(); } catch (e) { }
      this.paused = false;
    }
    /* song position in seconds (audio clock; negative before start).
       Falls back to wall time when the audio clock is frozen. */
    songTime() {
      if (!this.ctx) return 0;
      if (this._frozen) return this._wallPos + (performance.now() / 1000 - this._wallT0);
      return this.ctx.currentTime - this.startAt;
    }
    latencySeconds() {
      if (!this.ctx) return 0;
      const l = (this.ctx.outputLatency || this.ctx.baseLatency || 0);
      return clamp(l, 0, 0.15);
    }
    setVolume(v) {
      this.settings.volume = v;
      if (this.musicGain) this.musicGain.gain.value = v;
    }
    setSfx(on, vol) {
      if (on !== undefined) this.settings.sfx = on;
      if (vol !== undefined) this.settings.sfxVolume = vol;
      if (this.sfxGain) this.sfxGain.gain.value = this.settings.sfx ? this.settings.sfxVolume * 0.5 : 0;
    }

    /* live bands for the reactive world (call each frame) */
    bands(dt) {
      const b = this._bands;
      if (!this.analyser || !this.playing) {
        b.bass *= 0.92; b.mid *= 0.92; b.high *= 0.92; b.level *= 0.92;
        return b;
      }
      this.analyser.getByteFrequencyData(this._freqData);
      const d = this._freqData;
      let bass = 0, mid = 0, high = 0;
      for (let i = 1; i < 5; i++) bass += d[i];
      for (let i = 5; i < 40; i++) mid += d[i];
      for (let i = 40; i < 100; i++) high += d[i];
      bass = bass / (4 * 255); mid = mid / (35 * 255); high = high / (60 * 255);
      const smooth = (prev, v) => v > prev ? v : prev * 0.88 + v * 0.12; /* fast attack, slow release */
      b.bass = smooth(b.bass, Math.min(1, bass * 1.5));
      b.mid = smooth(b.mid, Math.min(1, mid * 1.8));
      b.high = smooth(b.high, Math.min(1, high * 2.2));
      b.level = Math.min(1, (bass * 1.2 + mid + high) / 2.2);
      return b;
    }

    /* --------- synthesized SFX (no assets) --------- */
    sfx(name) {
      if (!this.ctx || !this.settings.sfx) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const osc = (type, f0, f1, dur, gain, shape) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = type;
        o.frequency.setValueAtTime(f0, t);
        if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(gain, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
        o.connect(g); g.connect(this.sfxGain);
        o.start(t); o.stop(t + dur + 0.02);
      };
      const noise = (dur, gain, cutoff) => {
        const len = Math.ceil(dur * ctx.sampleRate);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len);
        const src = ctx.createBufferSource(); src.buffer = buf;
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
        const g = ctx.createGain(); g.gain.value = gain;
        src.connect(f); f.connect(g); g.connect(this.sfxGain);
        src.start(t);
      };
      switch (name) {
        case 'perfect': osc('sine', 880, 1568, 0.09, 0.5); break;
        case 'great': osc('sine', 660, 880, 0.07, 0.4); break;
        case 'good': osc('sine', 440, 520, 0.06, 0.32); break;
        case 'miss': noise(0.12, 0.5, 300); osc('sine', 130, 70, 0.12, 0.4); break;
        case 'hazard': osc('square', 110, 82, 0.14, 0.3); noise(0.1, 0.3, 500); break;
        case 'dodge': noise(0.16, 0.25, 1800); break;
        case 'orb': osc('sine', 1568, 2093, 0.08, 0.28); break;
        case 'peak': osc('sine', 523, 523, 0.3, 0.3); osc('sine', 659, 659, 0.32, 0.26); osc('sine', 784, 784, 0.34, 0.22); break;
        case 'chain': osc('sine', 1047, 1568, 0.12, 0.4); break;
        case 'ui': osc('sine', 900, 700, 0.035, 0.2); break;
        case 'count': osc('sine', 600, 600, 0.06, 0.3); break;
        case 'go': osc('sine', 880, 880, 0.16, 0.4); break;
        case 'chime': osc('sine', 987, 987, 0.2, 0.18); break;
      }
    }
  }

  RS.AudioEngine = AudioEngine;
})();

/* ============================================================
 * RESONANCE — utils.js
 * Shared helpers: math, RNG, formatting, safe storage.
 * Plain script (no imports) so it can run in browser AND Node tests.
 * ============================================================ */
(function () {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const RS = G.RS = G.RS || {};

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
  const easeInCubic = (t) => Math.pow(clamp(t, 0, 1), 3);
  const easeOutBack = (t) => { t = clamp(t, 0, 1); const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

  /* Deterministic 32-bit RNG (mulberry32) */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* FNV-1a 32-bit string/object hash → hex */
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0);
  }
  const hex = (n, w) => (n >>> 0).toString(16).padStart(w || 8, '0');

  /* Pick from weighted list [[item, weight], ...] with rng */
  function weightedPick(rng, pairs) {
    let total = 0;
    for (const p of pairs) total += p[1];
    let r = rng() * total;
    for (const p of pairs) { r -= p[1]; if (r <= 0) return p[0]; }
    return pairs[pairs.length - 1][0];
  }

  /* Format seconds → m:ss */
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return m + ':' + String(ss).padStart(2, '0');
  }
  function fmtScore(n) {
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* Color helpers: '#rrggbb' ↔ {r,g,b}, lerp */
  function hexToRgb(h) {
    return { r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) };
  }
  function rgbToCss(c, a) {
    return a === undefined ? `rgb(${c.r | 0},${c.g | 0},${c.b | 0})` : `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${a})`;
  }
  function lerpRgb(a, b, t) {
    return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
  }
  function mixHex(h1, h2, t) {
    return rgbToCss(lerpRgb(hexToRgb(h1), hexToRgb(h2), clamp(t, 0, 1)));
  }

  /* Statistics helpers */
  function percentile(arr, p) {
    if (!arr.length) return 0;
    const a = Array.prototype.slice.call(arr).sort((x, y) => x - y);
    const idx = clamp(Math.round((a.length - 1) * p), 0, a.length - 1);
    return a[idx];
  }
  function mean(arr) {
    if (!arr.length) return 0;
    let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }
  function stdev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    let s = 0; for (let i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
    return Math.sqrt(s / (arr.length - 1));
  }

  /* Box-filter smoothing for Float32Array via prefix sums. radius in samples. */
  function smoothF32(arr, radius) {
    if (radius < 1 || !arr.length) return Float32Array.from(arr);
    const n = arr.length, out = new Float32Array(n);
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + arr[i];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - radius), b = Math.min(n - 1, i + radius);
      out[i] = (pre[b + 1] - pre[a]) / (b - a + 1);
    }
    return out;
  }

  /* Safe localStorage wrapper (sandboxed iframes / private mode can throw) */
  const memStore = {};
  const safeStore = {
    get(key, fallback) {
      try {
        const raw = G.localStorage && G.localStorage.getItem(key);
        if (raw !== null && raw !== undefined) return JSON.parse(raw);
      } catch (e) { /* opaque origin etc. */ }
      return (key in memStore) ? memStore[key] : fallback;
    },
    set(key, value) {
      memStore[key] = value;
      try { if (G.localStorage) G.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    }
  };

  /* Small event emitter */
  class Emitter {
    constructor() { this._l = {}; }
    on(ev, fn) { (this._l[ev] = this._l[ev] || []).push(fn); return this; }
    off(ev, fn) { const l = this._l[ev]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } return this; }
    emit(ev, ...args) { const l = this._l[ev]; if (l) for (let i = 0; i < l.length; i++) l[i].apply(null, args); }
  }

  RS.util = {
    TAU, clamp, lerp, smoothstep, easeOutCubic, easeInCubic, easeOutBack,
    mulberry32, fnv1a, hex, weightedPick, fmtTime, fmtScore,
    hexToRgb, rgbToCss, lerpRgb, mixHex,
    percentile, mean, stdev, smoothF32, safeStore, Emitter
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = RS.util;
})();

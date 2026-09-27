/* ============================================================
 * RESONANCE — analyzer.js  (STANDALONE — no external deps)
 *
 * Client-side audio analysis pipeline:
 *   mono samples → resample → STFT → log-band spectral flux
 *   → onset detection → BPM (autocorrelation) → beat tracking (PLL)
 *   → downbeats → energy curves → sections → peaks/drops → fingerprint
 *
 * Runs inside a Web Worker (built from this same source) with a
 * main-thread async fallback that yields between chunks.
 *
 * analyze(mono: Float32Array, sampleRate: number, opts?) → Promise<Analysis>
 *   opts.onProgress(fraction, stageLabel)
 *   opts.yieldFn  — async barrier used on the main thread to keep UI alive
 * ============================================================ */
(function () {
  'use strict';
  const G = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : self);

  /* ---------- tiny local helpers (no external deps!) ---------- */
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);

  function percentileOf(sorted, p) {
    if (!sorted.length) return 0;
    const idx = clamp(Math.round((sorted.length - 1) * p), 0, sorted.length - 1);
    return sorted[idx];
  }
  function sortCopy(arr) {
    const a = Float32Array.from(arr);
    return a.sort();
  }
  function boxSmooth(arr, radius) {
    const n = arr.length;
    if (radius < 1 || n === 0) return Float32Array.from(arr);
    const out = new Float32Array(n), pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + arr[i];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - radius), b = Math.min(n - 1, i + radius);
      out[i] = (pre[b + 1] - pre[a]) / (b - a + 1);
    }
    return out;
  }
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }

  /* ---------- FFT (iterative radix-2, in-place, precomputed tables) ---------- */
  function makeFFT(n) {
    const levels = Math.log2(n) | 0;
    if (2 ** levels !== n) throw new Error('FFT size must be power of two');
    const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0, x = i;
      for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    return function fft(re, im) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const tre = re[l] * cos[k] + im[l] * sin[k];
            const tim = -re[l] * sin[k] + im[l] * cos[k];
            re[l] = re[j] - tre; im[l] = im[j] - tim;
            re[j] += tre; im[j] += tim;
          }
        }
      }
    };
  }

  const FR = 1024, HOP = 256, M = FR >> 1;
  const fftM = makeFFT(M);
  const _re = new Float32Array(M), _im = new Float32Array(M);
  const win = new Float32Array(FR);
  for (let i = 0; i < FR; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FR);

  const specMag = new Float32Array(M + 1);
  function frameSpectrum(x, off) {
    for (let k = 0; k < M; k++) {
      _re[k] = win[k << 1] * x[off + (k << 1)];
      _im[k] = win[(k << 1) + 1] * x[off + (k << 1) + 1];
    }
    fftM(_re, _im);
    for (let k = 0; k <= M; k++) {
      const km = k % M, kmc = (M - k) % M;
      const hkr = _re[km], hki = _im[km];
      const hcr = _re[kmc], hci = -_im[kmc];
      const er = (hkr + hcr) / 2, ei = (hki + hci) / 2;
      const or_ = (hki - hci) / 2, oi = -(hkr - hcr) / 2;
      const wr = Math.cos(Math.PI * k / M), wi = -Math.sin(Math.PI * k / M);
      const xr = er + (wr * or_ - wi * oi);
      const xi = ei + (wr * oi + wi * or_);
      specMag[k] = Math.sqrt(xr * xr + xi * xi) * (2 / FR);
    }
  }

  /* ============================ MAIN ============================ */
  async function analyze(mono, sampleRate, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress || function () {};
    const yieldFn = opts.yieldFn || null;
    let lastYieldP = -1;
    const barrier = async function (p) {
      if (yieldFn && p - lastYieldP > 0.02) { lastYieldP = p; await yieldFn(); }
    };
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    /* ---------- 0) resample to analysis rate ---------- */
    const ASR = 22050;
    let x = mono, rate = sampleRate;
    if (sampleRate !== ASR) {
      const n = Math.max(1, Math.floor(mono.length * ASR / sampleRate));
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const p = i * sampleRate / ASR, i0 = p | 0, f = p - i0;
        const a = mono[i0] || 0, b = mono[i0 + 1] !== undefined ? mono[i0 + 1] : a;
        y[i] = a + (b - a) * f;
      }
      x = y; rate = ASR;
    }
    const N = x.length;
    const duration = N / rate;
    const fps = rate / HOP;
    const nFrames = Math.max(1, Math.floor((N - FR) / HOP) + 1);
    onProgress(0.02, 'Scanning spectrum');

    /* ---------- 1) STFT → band energies + grouped spectral flux ---------- */
    const binHz = rate / FR;
    /* 4 macro groups: bass / low-mid / mid / high. Bass is the tactus anchor:
       group fluxes are normalized by their own p95 so broadband events (hats)
       cannot drown out narrowband events (kicks). */
    const GRP_HZ = [180, 800, 2500];
    const grpOf = new Int8Array(M + 1);
    for (let k = 1; k <= M; k++) {
      const hz = k * binHz;
      grpOf[k] = hz < GRP_HZ[0] ? 0 : hz < GRP_HZ[1] ? 1 : hz < GRP_HZ[2] ? 2 : 3;
    }
    const NG = 4;
    const grpW = [1.5, 1.0, 0.9, 0.8];

    const grpFlux = [];
    for (let g = 0; g < NG; g++) grpFlux.push(new Float32Array(nFrames));
    const subFlux = new Float32Array(nFrames); /* deep bass < 140 Hz */
    const rmsArr = new Float32Array(nFrames);
    const bassEng = new Float32Array(nFrames), midEng = new Float32Array(nFrames), highEng = new Float32Array(nFrames);
    const prevV = new Float32Array(M + 1);
    const COMP = 400;
    const frameTime = (f) => (f * HOP + FR / 2) / rate;

    for (let f = 0; f < nFrames; f++) {
      const off = f * HOP;
      frameSpectrum(x, off);
      let rs = 0;
      for (let i = 0; i < FR; i += 4) { const s = x[off + i]; rs += s * s; }
      rmsArr[f] = Math.sqrt(rs / (FR / 4));
      let sBass = 0, sMid = 0, sHigh = 0;
      for (let k = 1; k <= M; k++) {
        const m = specMag[k];
        const hz = k * binHz;
        if (hz < 400) sBass += m; else if (hz < 2000) sMid += m; else sHigh += m;
        const v = Math.log(1 + m * COMP);
        const d = v - prevV[k];
        if (d > 0) {
          grpFlux[grpOf[k]][f] += d;
          if (hz < 140) subFlux[f] += d;
        }
        prevV[k] = v;
      }
      bassEng[f] = sBass; midEng[f] = sMid; highEng[f] = sHigh;
      if ((f & 1023) === 0) await barrier(0.02 + 0.45 * (f / nFrames));
    }

    /* per-group normalization → balanced flux */
    const grpP95 = [];
    let maxP95 = 1e-9;
    for (let g = 0; g < NG; g++) {
      const p = percentileOf(sortCopy(grpFlux[g]), 0.95);
      grpP95.push(p);
      if (p > maxP95) maxP95 = p;
    }
    const fluxBal = new Float32Array(nFrames), bassOnset = new Float32Array(nFrames), highOnset = new Float32Array(nFrames);
    for (let g = 0; g < NG; g++) {
      /* scale down groups that are near-silent in this song */
      const rel = Math.min(1, grpP95[g] / (0.12 * maxP95));
      const norm = Math.max(grpP95[g], 1e-9);
      const w = grpW[g] * rel;
      /* subtract a noise floor (typical flux) so beds like vinyl/rain don't
         swamp quiet drum transients */
      const floor = percentileOf(sortCopy(grpFlux[g]), 0.4) * 0.8;
      const arr = grpFlux[g];
      for (let f = 0; f < nFrames; f++) {
        const v = Math.max(0, arr[f] - floor) / norm * w;
        fluxBal[f] += v;
        if (g === 0) bassOnset[f] += v;
        if (g === 3) highOnset[f] += v;
      }
    }
    /* deep-bass (<140 Hz) onset envelope — kick discriminator */
    const subNorm = percentileOf(sortCopy(subFlux), 0.95) || 1e-9;
    const subFloor = percentileOf(sortCopy(subFlux), 0.4) * 0.8;
    const subOnset = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) subOnset[f] = Math.max(0, subFlux[f] - subFloor) / subNorm;
    /* beat envelope: balanced flux + bass emphasis (kick = tactus anchor) */
    const beatEnvRaw = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) beatEnvRaw[f] = 0.55 * fluxBal[f] + 0.45 * bassOnset[f];
    const env = boxSmooth(fluxBal, 1);          /* for onset picking */
    const beatEnv = boxSmooth(beatEnvRaw, 1);   /* for phase + PLL  */
    onProgress(0.5, 'Finding onsets');

    /* ---------- 2) onset detection (adaptive threshold) ---------- */
    const rEnv = Math.max(1, Math.round(0.35 * fps));
    const envMean = boxSmooth(env, rEnv);
    const p90env = percentileOf(sortCopy(env), 0.9) || 1e-6;
    const onsets = [];
    let lastOnsetT = -1;
    for (let f = 2; f < nFrames - 2; f++) {
      const norm = env[f] / (envMean[f] + 1e-4);
      if (norm > 1.55 && env[f] >= env[f - 1] && env[f] >= env[f + 1] && env[f] > env[f - 2] && env[f] > env[f + 2]) {
        const t = frameTime(f);
        const s = clamp((norm - 1) / 2.2, 0.06, 1) * clamp(env[f] / p90env, 0.15, 1);
        if (t - lastOnsetT >= 0.055) {
          onsets.push({ t, s: clamp(s, 0.03, 1) });
          lastOnsetT = t;
        } else if (onsets.length && s > onsets[onsets.length - 1].s) {
          onsets[onsets.length - 1] = { t, s: clamp(s, 0.03, 1) };
          lastOnsetT = t;
        }
      }
    }

    /* silence / activity */
    const rmsSorted = sortCopy(rmsArr);
    const p10rms = percentileOf(rmsSorted, 0.1), p95rms = percentileOf(rmsSorted, 0.95);
    const activeMask = new Uint8Array(nFrames);
    for (let f = 0; f < nFrames; f++) activeMask[f] = rmsArr[f] > Math.max(p10rms * 1.6, p95rms * 0.06, 1e-4) ? 1 : 0;
    let activeFrames = 0; for (let f = 0; f < nFrames; f++) activeFrames += activeMask[f];
    const activeSec = activeFrames / fps;
    const onsetDensity = activeSec > 1 ? onsets.length / activeSec : onsets.length / Math.max(1, duration);

    if (onsets.length < 4 || duration < 3) {
      return buildFallback(x, rate, duration, fps, rmsArr, bassEng, midEng, highEng, 'not enough onsets');
    }
    onProgress(0.6, 'Estimating tempo');
    await barrier(0.6);

    /* ---------- 3) BPM via autocorrelation of balanced onset envelope ---------- */
    let mu = 0; for (let f = 0; f < nFrames; f++) mu += env[f]; mu /= nFrames;
    const ec = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) ec[f] = env[f] - mu;
    const LMIN = Math.max(4, Math.round(fps * 60 / 208)), LMAX = Math.max(LMIN + 2, Math.round(fps * 60 / 58));
    const AC = new Float32Array(Math.ceil(LMAX * 4) + 5);
    for (let L = LMIN; L <= LMAX; L++) {
      let s = 0;
      for (let i = 0; i + L < nFrames; i++) s += ec[i] * ec[i + L];
      AC[L] = s / (nFrames - L);
    }
    const prior = (L) => {
      const bpm = 60 * fps / L;
      return Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 1.15, 2));
    };
    const scoreOf = (L) => (L >= LMIN && L <= LMAX) ? AC[Math.round(L)] * prior(L) : -Infinity;
    let bestL = LMIN, bestScore = -Infinity;
    for (let L = LMIN; L <= LMAX; L++) {
      const sc = scoreOf(L);
      if (sc > bestScore) { bestScore = sc; bestL = L; }
    }
    /* parabolic refine */
    {
      const a = AC[bestL - 1], b = AC[bestL], c = AC[bestL + 1];
      const den = a - 2 * b + c;
      if (Math.abs(den) > 1e-12) bestL = bestL + clamp(0.5 * (a - c) / den, -0.5, 0.5);
    }
    let T = bestL / fps;
    onProgress(0.68, 'Tracking beats');
    await barrier(0.68);

    /* ---------- 4) beat phase + PLL tracking ---------- */
    let r0 = 0, r1 = Math.min(duration, 20);
    if (duration > 24) {
      const winS = Math.round(20 * fps); let best = -1;
      for (let s = 0; s + winS <= nFrames; s += Math.round(2 * fps)) {
        let acc = 0;
        for (let i = s; i < s + winS; i += 4) acc += rmsArr[i];
        if (acc > best) { best = acc; r0 = frameTime(s); r1 = r0 + 20; }
      }
    }
    const envAt = (t) => {
      if (t < 0) return 0;
      const f = clamp(Math.round((t * rate - FR / 2) / HOP), 0, nFrames - 1);
      return beatEnv[f];
    };
    const bassEnvAt = (t) => {
      if (t < 0) return 0;
      const f = clamp(Math.round((t * rate - FR / 2) / HOP), 0, nFrames - 1);
      return subOnset[f];
    };
    const gridStart = (ph, from, period) => ph + Math.ceil((from - ph) / period) * period;
    const phaseSearch = (period) => {
      let bph = 0, bsc = -1;
      const STEPS = 64;
      for (let pi = 0; pi < STEPS; pi++) {
        const ph = (pi / STEPS) * period;
        let sc = 0, cnt = 0;
        for (let t = gridStart(ph, r0, period); t < r1 - 0.05; t += period) {
          sc += Math.max(envAt(t - 0.012), envAt(t), envAt(t + 0.012));
          cnt++;
        }
        if (cnt && sc / cnt > bsc) { bsc = sc / cnt; bph = ph; }
      }
      return { phase: bph, score: bsc };
    };
    /* Phase φ and φ+T/2 can tie when the half-time level is fully populated
       (kick / hat alternation). Disambiguate with bass onsets: the tactus
       carries the kick. */
    const bassAlign = (ph, period) => {
      let s = 0, c = 0;
      for (let t = gridStart(ph, r0, period); t < r1 - 0.05; t += period) {
        s += Math.max(bassEnvAt(t - 0.012), bassEnvAt(t), bassEnvAt(t + 0.012));
        c++;
      }
      return c ? s / c : 0;
    };
    const fixHalfPhase = (period, ph) => {
      const alt = (ph + period / 2) % period;
      return bassAlign(alt, period) > bassAlign(ph, period) * 1.15 ? alt : ph;
    };
    let { phase: bestPhase } = phaseSearch(T);
    bestPhase = fixHalfPhase(T, bestPhase);

    /* ---- Octave refinement, driven by musical evidence ----
       gridEO() splits the fast grid into on-beats (even) and off-beats (odd).
       • Halve a fast detection when off-beats are soft, bass-less subdivisions
         (classical arpeggios) — the tactus is the slower level.
       • Double a slow detection when off-beats carry real events (D&B snares,
         rock backbeats) — the tactus is the faster level. */
    const gridEO = (period) => {
      let eE = 0, eO = 0, bE = 0, bO = 0, n = 0;
      for (let t = gridStart(bestPhase, r0, period); t < r1 - 0.05; t += period) {
        const ev = Math.max(envAt(t - 0.012), envAt(t), envAt(t + 0.012));
        const bv = Math.max(bassEnvAt(t - 0.012), bassEnvAt(t), bassEnvAt(t + 0.012));
        if (n % 2 === 0) { eE += ev; bE += bv; } else { eO += ev; bO += bv; }
        n++;
      }
      const h = Math.max(1, n >> 1);
      return { evenE: eE / h, oddE: eO / h, evenB: bE / h, oddB: bO / h, n };
    };
    const rephase = () => {
      const r = phaseSearch(T);
      bestPhase = fixHalfPhase(T, r.phase);
    };
    if (60 / T >= 100) {
      const Lh = 2 * T * fps;
      if (Lh <= LMAX && scoreOf(Lh) > 0.9 * bestScore) {
        const g = gridEO(T);
        const ratio = g.oddE / Math.max(1e-9, g.evenE);
        const bassRatio = g.oddB / Math.max(1e-9, g.evenB);
        if (g.n >= 8 && ratio > 0.2 && ratio < 0.85 && bassRatio < 0.5) {
          T *= 2;
          rephase();
        }
      }
    } else {
      const Lf = (T / 2) * fps;
      if (Lf >= LMIN && scoreOf(Lf) > 0.7 * bestScore) {
        const g = gridEO(T);
        if (g.n >= 8 && g.oddE > 0.4 * g.evenE) {
          T /= 2;
          rephase();
        }
      }
    }
    const bpm = 60 / T;
    let acMax = 0, acMed = 0;
    const acSorted = sortCopy(AC.subarray(LMIN, LMAX + 1));
    acMax = percentileOf(acSorted, 1); acMed = percentileOf(acSorted, 0.5);
    const bpmConfidence = clamp((AC[Math.round(T * fps)] - acMed) / (acMax - acMed + 1e-9), 0, 1);

    /* PLL walk over the whole song — snaps only to DETECTED onsets
       (adaptive-threshold peaks), so quiet beds can't derail the grid. */
    const beats = [];
    const Tg = T;
    const gapLo = Tg * 0.92, gapHi = Tg * 1.08;
    const minGap = Math.min(0.24, T * 0.9);
    const strengths = [];
    const p90beat = percentileOf(sortCopy(beatEnv), 0.9) || 1e-6;
    let t = gridStart(bestPhase, 0.3, T);
    if (t < 0.3) t += T;
    let Tr = T, lastT = -9, oi = 0;
    while (t < duration - 0.05 && beats.length < 4000) {
      const w0 = t - Tr * 0.11, w1 = t + Tr * 0.11;
      while (oi < onsets.length && onsets[oi].t < w0) oi++;
      let bOnset = null;
      for (let j = oi; j < onsets.length && onsets[j].t <= w1; j++) {
        if (!bOnset || onsets[j].s > bOnset.s) bOnset = onsets[j];
      }
      let tBeat, sBeat;
      if (bOnset && bOnset.s > 0.1 && bOnset.t - lastT >= minGap) {
        tBeat = bOnset.t;
        sBeat = clamp((0.5 * bOnset.s + 0.5 * clamp(beatEnv[Math.round((bOnset.t * rate - FR / 2) / HOP)] / p90beat, 0, 1)), 0.05, 1);
      } else {
        tBeat = t;
        sBeat = clamp(envAt(t) / p90beat, 0.02, 0.35);
      }
      if (tBeat - lastT < minGap * 0.75) tBeat = lastT + minGap;
      if (tBeat >= duration - 0.05) break;
      if (bOnset && bOnset.s > 0.1 && beats.length) {
        Tr = clamp(Tr + 0.1 * (tBeat - lastT - Tr), gapLo, gapHi);
      }
      lastT = tBeat;
      strengths.push(sBeat);
      beats.push({ time: tBeat, strength: sBeat, energy: 0, bass: 0, downbeat: false, section: 'verse', silent: sBeat < 0.08 });
      t = tBeat + Tr;
    }
    if (beats.length < 8) {
      return buildFallback(x, rate, duration, fps, rmsArr, bassEng, midEng, highEng, 'beat tracking failed');
    }
    const sMax = percentileOf(sortCopy(Float32Array.from(strengths)), 0.95) || 1;
    for (const b of beats) b.strength = clamp(b.strength / sMax, 0.05, 1);

    const gaps = [];
    for (let i = 1; i < beats.length; i++) gaps.push(beats[i].time - beats[i - 1].time);
    const gMean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : T;
    let gVar = 0; for (const g of gaps) gVar += (g - gMean) * (g - gMean);
    const gSd = Math.sqrt(gVar / Math.max(1, gaps.length));
    const tempoStability = clamp(1 - (gSd / gMean - 0.015) / 0.14, 0, 1);

    onProgress(0.78, 'Reading structure');
    await barrier(0.78);

    /* ---------- 5) energy curves ---------- */
    const normalizeBy = (arr, p) => {
      const v = percentileOf(sortCopy(arr), p) || 1;
      const out = new Float32Array(arr.length);
      for (let i = 0; i < arr.length; i++) out[i] = clamp(arr[i] / v, 0, 1);
      return out;
    };
    const energyCurve = normalizeBy(boxSmooth(rmsArr, Math.round(0.5 * fps)), 0.95);
    const bassE = normalizeBy(boxSmooth(bassEng, Math.round(0.12 * fps)), 0.95);
    const midE = normalizeBy(boxSmooth(midEng, Math.round(0.12 * fps)), 0.95);
    const highE = normalizeBy(boxSmooth(highEng, Math.round(0.12 * fps)), 0.95);
    const curveAt = (cur, t) => cur[clamp(Math.round(t * fps), 0, cur.length - 1)];
    for (const b of beats) { b.energy = curveAt(energyCurve, b.time); b.bass = curveAt(bassE, b.time); }

    /* ---------- 6) downbeats (meter 4 vs 3) ---------- */
    let meter = 4, bestMeterScore = -1, bestPhaseIdx = 0;
    for (const m of [4, 3]) {
      for (let p = 0; p < m; p++) {
        let sc = 0, cnt = 0;
        for (let i = p; i < beats.length; i += m) {
          sc += 0.55 * beats[i].bass + 0.45 * beats[i].strength; cnt++;
        }
        if (!cnt) continue;
        const norm = sc / cnt * (m === 4 ? 1.06 : 1);
        if (norm > bestMeterScore) { bestMeterScore = norm; meter = m; bestPhaseIdx = p; }
      }
    }
    const downbeats = [];
    for (let i = bestPhaseIdx; i < beats.length; i += meter) { beats[i].downbeat = true; downbeats.push(beats[i].time); }

    /* ---------- 7) sections ---------- */
    const stride = Math.max(1, Math.round(fps / 2)); /* 2 Hz features */
    const nF = Math.floor(nFrames / stride);
    const feat = [];
    const onsetCount = (t0, t1) => {
      let c = 0;
      for (const o of onsets) { if (o.t >= t0 && o.t < t1) c++; else if (o.t >= t1) break; }
      return c;
    };
    const odArr = new Float32Array(Math.max(1, nF));
    for (let i = 0; i < nF; i++) odArr[i] = onsetCount(i * 0.5, (i + 1) * 0.5);
    const maxOD = Math.max(1, percentileOf(sortCopy(odArr), 0.9));
    for (let i = 0; i < nF; i++) {
      const f0 = i * stride, f1 = Math.min(nFrames, f0 + stride);
      let e = 0, b = 0, mm = 0, h = 0;
      for (let f = f0; f < f1; f++) { e += energyCurve[f]; b += bassE[f]; mm += midE[f]; h += highE[f]; }
      const n = Math.max(1, f1 - f0);
      e /= n; b /= n; mm /= n; h /= n;
      const tt = (f0 + stride / 2) / fps;
      feat.push({ t: tt, e, d: odArr[i] / maxOD, b: b / (b + mm + h + 1e-6), br: h / (mm + h + 1e-6) });
    }
    const W = 8; /* 4 s at 2 Hz */
    const nov = [];
    for (let i = 0; i < feat.length; i++) {
      const a0 = Math.max(0, i - W), a1 = i, b0 = i, b1 = Math.min(feat.length, i + W);
      const na2 = a1 - a0 || 1, nb2 = b1 - b0 || 1;
      let sa = 0, sb = 0, ca = 0, cb = 0;
      for (let j = a0; j < a1; j++) { sa += feat[j].e; ca += feat[j].d; }
      for (let j = b0; j < b1; j++) { sb += feat[j].e; cb += feat[j].d; }
      nov.push(Math.abs(sb / nb2 - sa / na2) + 0.5 * Math.abs(cb / nb2 - ca / na2));
    }
    const novMean = nov.reduce((a, b) => a + b, 0) / Math.max(1, nov.length);
    const novSd = Math.sqrt(nov.reduce((a, b) => a + (b - novMean) * (b - novMean), 0) / Math.max(1, nov.length));
    const bounds = [0];
    let lastB = -99;
    for (let i = 1; i < nov.length - 1; i++) {
      const tt = feat[i].t;
      if (nov[i] > novMean + 0.7 * novSd && nov[i] >= nov[i - 1] && nov[i] >= nov[i + 1] && tt - lastB > 8 && tt > 3 && tt < duration - 5) {
        bounds.push(tt); lastB = tt;
      }
    }
    bounds.push(duration);
    let sections = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      if (bounds[i + 1] - bounds[i] > 0.5) sections.push({ start: bounds[i], end: bounds[i + 1] });
    }
    if (!sections.length) sections = [{ start: 0, end: duration }];
    const merged = [sections[0]];
    for (let i = 1; i < sections.length; i++) {
      const s = sections[i];
      if (s.end - s.start < 6) merged[merged.length - 1].end = s.end;
      else merged.push(s);
    }
    sections = merged;
    const finalSecs = [];
    for (const s of sections) {
      if (s.end - s.start > 50) {
        let bi = -1, bv = -1;
        for (let i = 0; i < feat.length; i++) { const tt = feat[i].t; if (tt > s.start + 10 && tt < s.end - 10 && nov[i] > bv) { bv = nov[i]; bi = i; } }
        const mid = bi >= 0 ? feat[bi].t : (s.start + s.end) / 2;
        finalSecs.push({ start: s.start, end: mid }, { start: mid, end: s.end });
      } else finalSecs.push(s);
    }
    sections = finalSecs;
    const secStats = sections.map((s) => {
      let e = 0, d = 0, b = 0, n = 0;
      for (const f of feat) { if (f.t >= s.start && f.t < s.end) { e += f.e; d += f.d; b += f.b; n++; } }
      n = n || 1;
      return { e: e / n, d: d / n, b: b / n, slope: curveAt(energyCurve, s.end - 0.5) - curveAt(energyCurve, s.start + 0.5) };
    });
    const eRanks = secStats.map((s) => s.e).map((v) => secStats.filter((o) => o.e < v).length / Math.max(1, secStats.length - 1));
    const bSorted = secStats.map((s) => s.b).slice().sort((a, b) => a - b);
    const bassMed = bSorted.length ? bSorted[Math.floor(bSorted.length / 2)] : 0.5;
    sections.forEach((s, i) => {
      const relE = eRanks[i], st = secStats[i];
      let type;
      if (sections.length === 1) type = st.e > 0.55 ? 'chorus' : 'verse';
      else if (i === 0 && relE < 0.5 && st.e < 0.45) type = 'intro';
      else if (i === sections.length - 1 && relE < 0.5 && st.slope <= 0.05) type = 'outro';
      else if (st.e < 0.22) type = 'break';
      else if (st.slope > 0.18 && relE < 0.92) type = 'build';
      else if (relE > 0.66 && st.b >= bassMed * 0.96 && st.e > 0.42 && st.d > 0.5 && onsetDensity > 2.6 && (s.end - s.start) <= 26) type = 'drop';
      else if (relE > 0.5) type = 'chorus';
      else type = 'verse';
      s.type = type;
      s.intensity = clamp(st.e, 0, 1);
      s.bassRatio = st.b;
    });
    if (sections[0] && sections[0].type === 'drop' && sections.length > 1) sections[0].type = 'chorus';
    for (const s of sections) if (s.type === 'drop' && (s.end - s.start) > 26) s.type = 'chorus';
    for (const b of beats) {
      let lo = 0, hi = sections.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (sections[mid].end <= b.time) lo = mid + 1; else hi = mid; }
      b.section = sections[lo] ? sections[lo].type : 'verse';
    }

    /* ---------- 8) peaks & drops ---------- */
    onProgress(0.9, 'Finding peaks');
    const slowE = boxSmooth(energyCurve, Math.round(1.5 * fps));
    const peaks = [];
    const minSep = 8;
    const stepF = Math.round(0.25 * fps);
    for (let f = Math.round(2 * fps); f < nFrames - Math.round(2 * fps); f += stepF) {
      const v = slowE[f];
      let isMax = true;
      for (let g = f - Math.round(6 * fps); g <= f + Math.round(6 * fps) && isMax; g += stepF) {
        if (g >= 0 && g < nFrames && g !== f && slowE[g] > v) isMax = false;
      }
      if (isMax && v > 0.5) {
        if (!peaks.length || frameTime(f) - peaks[peaks.length - 1].time >= minSep) peaks.push({ time: frameTime(f), value: v });
        else if (v > peaks[peaks.length - 1].value) peaks[peaks.length - 1] = { time: frameTime(f), value: v };
      }
    }
    peaks.sort((a, b) => b.value - a.value);
    const topPeaks = peaks.slice(0, 10).sort((a, b) => a.time - b.time);
    const drops = [];
    for (const s of sections) if (s.type === 'drop') drops.push({ time: s.start, duration: s.end - s.start });
    for (let f = Math.round(4 * fps); f < nFrames - Math.round(2 * fps); f += stepF) {
      const t = frameTime(f);
      const now = slowE[f], past = slowE[Math.max(0, f - Math.round(1.5 * fps))], far = slowE[Math.max(0, f - Math.round(4 * fps))];
      if (now - past > 0.17 && past - far > 0.05 && bassE[f] > 0.45) {
        if (!drops.length || t - drops[drops.length - 1].time > 10) drops.push({ time: t, duration: 4 });
      }
    }
    drops.sort((a, b) => a.time - b.time);

    /* ---------- 9) fingerprint & wave peaks ---------- */
    let fpStr = `${Math.round(bpm * 4)}|${Math.round(duration * 10)}|${beats.length}|${topPeaks.map((p) => p.time.toFixed(1)).join(',')}|`;
    for (let i = 0; i < 48; i++) fpStr += Math.round(curveAt(energyCurve, (i / 48) * duration) * 12) + ',';
    const fingerprint = fnv1a(fpStr).toString(16).padStart(8, '0');
    const NP = 512;
    const wavePeaks = new Float32Array(NP * 2);
    const bs = N / NP;
    for (let i = 0; i < NP; i++) {
      let mn = 0, mx = 0;
      const s0 = Math.floor(i * bs), s1 = Math.min(N, Math.floor((i + 1) * bs));
      for (let j = s0; j < s1; j += 4) { const v = x[j]; if (v < mn) mn = v; else if (v > mx) mx = v; }
      wavePeaks[i * 2] = mn; wavePeaks[i * 2 + 1] = mx;
    }

    onProgress(1, 'Done');
    const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    return {
      duration, sampleRate: rate, fps, analyzerMs: Math.round(t1 - t0),
      bpm: Math.round(bpm * 10) / 10, bpmConfidence, tempoStability,
      beats, downbeats,
      energyCurve, bassEnergy: bassE, midEnergy: midE, highEnergy: highE,
      peaks: topPeaks, drops, sections,
      intensity: clamp(percentileOf(sortCopy(energyCurve), 0.9), 0, 1),
      onsetDensity, fingerprint, wavePeaks,
      fallback: false
    };
  }

  /* Fallback: grid at fallback BPM, flat curves — game remains playable. */
  function buildFallback(x, rate, duration, fps, rmsArr, bassEng, midEng, highEng) {
    const bpm = 120, T = 60 / bpm;
    const beats = [];
    for (let t = 0.5; t < duration - 0.2; t += T) {
      beats.push({ time: t, strength: 0.4, energy: 0.4, bass: 0.4, downbeat: Math.round(t / T) % 4 === 0, section: 'verse', silent: false });
    }
    const nFrames = rmsArr.length;
    const energyCurve = new Float32Array(nFrames), bassE = new Float32Array(nFrames),
      midE = new Float32Array(nFrames), highE = new Float32Array(nFrames);
    let mv = 1e-6; for (let f = 0; f < nFrames; f++) mv = Math.max(mv, rmsArr[f]);
    for (let f = 0; f < nFrames; f++) {
      energyCurve[f] = clamp(rmsArr[f] / mv, 0, 1);
      bassE[f] = clamp(bassEng[f] / (mv || 1), 0, 1);
      midE[f] = clamp(midEng[f] / (mv || 1), 0, 1);
      highE[f] = clamp(highEng[f] / (mv || 1), 0, 1);
    }
    const NP = 512, N = x.length, wavePeaks = new Float32Array(NP * 2), bs = N / NP;
    for (let i = 0; i < NP; i++) {
      let mn = 0, mx = 0;
      const s0 = Math.floor(i * bs), s1 = Math.min(N, Math.floor((i + 1) * bs));
      for (let j = s0; j < s1; j += 4) { const v = x[j]; if (v < mn) mn = v; else if (v > mx) mx = v; }
      wavePeaks[i * 2] = mn; wavePeaks[i * 2 + 1] = mx;
    }
    return {
      duration, sampleRate: rate, fps, analyzerMs: 0,
      bpm, bpmConfidence: 0, tempoStability: 0.5,
      beats, downbeats: beats.filter((b) => b.downbeat).map((b) => b.time),
      energyCurve, bassEnergy: bassE, midEnergy: midE, highEnergy: highE,
      peaks: [], drops: [], sections: [{ start: 0, end: duration, type: 'verse', intensity: 0.4, bassRatio: 0.4 }],
      intensity: 0.4, onsetDensity: 2, fingerprint: fnv1a('fallback' + duration.toFixed(1)).toString(16).padStart(8, '0'),
      wavePeaks, fallback: true, fallbackReason: arguments[8] || ''
    };
  }

  const RSAnalyzer = { analyze };
  G.RSAnalyzer = RSAnalyzer;
  if (typeof module !== 'undefined' && module.exports) module.exports = RSAnalyzer;
})();

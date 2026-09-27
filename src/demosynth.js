/* ============================================================
 * RESONANCE — demosynth.js
 * Procedural demo-track synthesis (pure math, no Web Audio needed).
 * Works in Node (tests) and browser. Produces 44.1 kHz mono buffers
 * that feed the exact same analysis + gameplay pipeline as uploads.
 * ============================================================ */
(function () {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const RS = G.RS = G.RS || {};
  const SR = 44100;
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const mf = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

  /* ---------------- deterministic RNG ----------------
     Demos must render identically every time so the analysis
     (and therefore the chart) is stable across sessions. */
  let _rs = 1;
  function seedRng(seed) { _rs = (seed >>> 0) || 1; }
  function rnd() { /* mulberry32 */
    _rs = (_rs + 0x6D2B79F5) >>> 0;
    let t = _rs;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function seedFrom(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }

  /* ---------------- voices (additive writes into buf at off) ---------------- */
  const TAU = Math.PI * 2;

  function kick(buf, off, vel) {
    const dur = 0.3;
    let phase = 0;
    for (let i = 0; i < dur * SR; i++, off++) {
      if (off >= buf.length) return;
      const t = i / SR;
      const f = 45 + 115 * Math.exp(-t * 32);
      phase += TAU * f / SR;
      const click = t < 0.004 ? (rnd() * 2 - 1) * 0.25 * (1 - t / 0.004) : 0;
      buf[off] += vel * (Math.exp(-t * 13) * Math.sin(phase) * 0.95 + click);
    }
  }
  function snare(buf, off, vel, rim) {
    const dur = rim ? 0.08 : 0.22;
    let lp = 0, lp2 = 0, phase = 0;
    for (let i = 0; i < dur * SR; i++, off++) {
      if (off >= buf.length) return;
      const t = i / SR;
      const n = rnd() * 2 - 1;
      lp += 0.42 * (n - lp);           /* LP ~3.5k */
      lp2 += 0.09 * (lp - lp2);        /* LP ~600  */
      const band = lp - lp2;           /* band ~ snare body */
      const f = 205 * Math.exp(-t * 22);
      phase += TAU * f / SR;
      const tone = rim ? 0 : Math.sin(phase) * Math.exp(-t * 26) * 0.5;
      const nz = rim ? band * Math.exp(-t * 90) * 1.4 : band * Math.exp(-t * 17);
      buf[off] += vel * (tone + nz * 0.85);
    }
  }
  function hat(buf, off, vel, open) {
    const dur = open ? 0.28 : 0.055;
    let lp = 0, hp = 0;
    for (let i = 0; i < dur * SR; i++, off++) {
      if (off >= buf.length) return;
      const t = i / SR;
      const n = rnd() * 2 - 1;
      lp += 0.62 * (n - lp);           /* LP ~6k  */
      hp += 0.86 * (lp - hp);          /* HP-ish ~10k */
      buf[off] += vel * 0.5 * Math.exp(-t * (open ? 14 : 95)) * (lp - hp + n * 0.15);
    }
  }
  function clap(buf, off, vel) {
    for (let b = 0; b < 3; b++) snare(buf, off + Math.round(b * 0.011 * SR), vel * (b === 2 ? 1 : 0.5), false);
    snare(buf, off + Math.round(0.03 * SR), vel * 0.7, false);
  }
  function sub(buf, off, vel, f0, dur) {
    let p1 = 0, p2 = 0;
    const rel = 0.05;
    for (let i = 0; i < (dur + rel) * SR; i++, off++) {
      if (off >= buf.length) return;
      const t = i / SR;
      let a = 1;
      if (t < 0.004) a = t / 0.004;
      const relT = t - dur;
      if (relT > 0) a *= Math.exp(-relT * 60);
      p1 += TAU * f0 / SR; p2 += TAU * f0 * 2.002 / SR;
      buf[off] += vel * 0.55 * a * (Math.sin(p1) + 0.28 * Math.sin(p2));
    }
  }
  function pluck(buf, off, vel, f0, dur, dark) {
    let ph1 = 0, ph2 = 0, lp = 0;
    const rel = 0.08, decay = dark ? 5 : 8;
    for (let i = 0; i < (dur + rel) * SR; i++, off++) {
      if (off >= buf.length) return;
      const t = i / SR;
      let a = Math.exp(-t * decay);
      if (t < 0.003) a *= t / 0.003;
      const relT = t - dur;
      if (relT > 0) a *= Math.exp(-relT * 30);
      ph1 += TAU * f0 / SR; ph2 += TAU * f0 * 1.005 / SR;
      const saw = 2 * ((ph1 / TAU) % 1) - 1;
      const saw2 = 2 * ((ph2 / TAU) % 1) - 1;
      const cut = (dark ? 0.10 : 0.34) * (0.3 + 0.7 * Math.exp(-t * 6));
      lp += cut * ((saw + saw2 * 0.6) - lp);
      buf[off] += vel * 0.4 * a * lp;
    }
  }
  function pad(buf, off, vel, notes, dur, cutoff) {
    const rel = 0.5, att = 0.25;
    const n = notes.length;
    for (let ni = 0; ni < n; ni++) {
      const f0 = mf(notes[ni]);
      let p1 = 0, p2 = 0, lp = 0;
      const start = off;
      for (let i = 0; i < (dur + rel) * SR; i++) {
        const o = start + i;
        if (o >= buf.length) break;
        const t = i / SR;
        let a = Math.min(1, t / att);
        const relT = t - dur;
        if (relT > 0) a *= Math.exp(-relT * 3);
        p1 += TAU * f0 * 0.997 / SR; p2 += TAU * f0 * 1.004 / SR;
        const s1 = 2 * ((p1 / TAU) % 1) - 1, s2 = 2 * ((p2 / TAU) % 1) - 1;
        lp += (cutoff || 0.05) * ((s1 + s2) - lp);
        buf[o] += vel * 0.16 * a * lp / Math.sqrt(n);
      }
    }
  }
  function piano(buf, off, vel, f0, dur) {
    const rel = 0.6;
    const harms = [1, 0.55, 0.32, 0.2, 0.12, 0.07];
    for (let i = 0; i < (dur + rel) * SR; i++, off++) {
      if (off >= buf.length) return;
      const t = i / SR;
      let a = Math.exp(-t * (1.4 + 220 / f0));
      if (t < 0.003) a *= t / 0.003;
      const relT = t - dur;
      if (relT > 0) a *= Math.exp(-relT * 6);
      let s = 0, ph = 0;
      for (let k = 0; k < harms.length; k++) {
        ph += TAU * f0 * (1 + k * 0.0007) / SR;
        s += Math.sin(ph) * harms[k] * Math.exp(-t * k * 0.5);
      }
      buf[off] += vel * 0.34 * a * s;
    }
  }
  function lead(buf, off, vel, f0, dur) {
    /* rock lead: saw+square through drive */
    let p1 = 0, lp = 0;
    const rel = 0.1;
    for (let i = 0; i < (dur + rel) * SR; i++, off++) {
      if (off >= buf.length) return;
      const t = i / SR;
      let a = Math.min(1, t / 0.01) * (0.8 + 0.2 * Math.sin(t * 22));
      const relT = t - dur;
      if (relT > 0) a *= Math.exp(-relT * 25);
      p1 += TAU * f0 / SR;
      const saw = 2 * ((p1 / TAU) % 1) - 1;
      const sq = Math.sin(p1) > 0 ? 0.7 : -0.7;
      lp += 0.28 * (saw * 0.6 + sq * 0.4 - lp);
      buf[off] += vel * 0.3 * a * Math.tanh(2.2 * lp);
    }
  }
  function chordVoice(buf, off, vel, notes, dur, type) {
    for (const m of notes) {
      const f0 = mf(m);
      if (type === 'pluckchord') pluck(buf, off, vel * 0.75, f0, dur, false);
      else if (type === 'power') lead(buf, off, vel, f0 * 0.5, dur);
      else piano(buf, off, vel, f0, dur);
    }
  }
  function riser(buf, off, dur, vel) {
    let lp = 0;
    for (let i = 0; i < dur * SR; i++, off++) {
      if (off >= buf.length) return;
      const t = i / SR, p = t / dur;
      const n = rnd() * 2 - 1;
      const cut = 0.006 + 0.3 * Math.pow(p, 2.2);
      lp += cut * (n - lp);
      buf[off] += vel * 0.24 * Math.pow(p, 1.6) * lp;
    }
  }
  function impact(buf, off, vel) {
    let p = 0, lp = 0;
    for (let i = 0; i < 0.9 * SR; i++, off++) {
      if (off >= buf.length) return;
      const t = i / SR;
      const f = 30 + 70 * Math.exp(-t * 7);
      p += TAU * f / SR;
      lp += 0.05 * ((rnd() * 2 - 1) - lp);
      buf[off] += vel * (Math.exp(-t * 4) * Math.sin(p) * 0.8 + Math.exp(-t * 9) * lp * 0.6);
    }
  }
  function noiseBed(buf, off, dur, level, kind) {
    let lp = 0, lp2 = 0;
    let nextCrackle = 0.05 + rnd() * 0.4;
    let crackleEnv = 0;
    for (let i = 0; i < dur * SR; i++, off++) {
      if (off >= buf.length) return;
      const n = rnd() * 2 - 1;
      if (kind === 'vinyl') {
        lp += 0.18 * (n - lp);        /* light mid hiss */
        nextCrackle -= 1 / SR;
        if (nextCrackle <= 0) { nextCrackle = 0.08 + rnd() * 0.7; crackleEnv = 0.5 + rnd() * 0.5; }
        crackleEnv *= 0.9992;
        buf[off] += level * 0.024 * lp + level * crackleEnv * (rnd() * 2 - 1) * 0.022;
      } else { /* rain */
        lp += 0.12 * (n - lp); lp2 += 0.4 * (lp - lp2);
        buf[off] += level * 0.05 * lp2;
      }
    }
  }

  /* ---------------- sequencer ---------------- */
  const VELMAP = { X: 1, x: 0.62, o: 0.4, '.': 0 };
  function stepTime(baseStep, step, stepDur, swing) {
    let t = baseStep + step * stepDur;
    if (swing > 0 && (step % 4) === 2) t += swing * stepDur; /* swung 8th offbeats */
    return t;
  }

  function renderSong(def) {
    seedRng(seedFrom('rs1|' + def.id));
    const bpm = def.bpm, barDur = 4 * 60 / bpm, stepDur = barDur / 16;
    const swing = def.swing || 0;
    let totalBars = 0;
    for (const s of def.sections) totalBars += s.bars;
    const total = Math.ceil((totalBars * barDur + 2.2) * SR);
    const buf = new Float32Array(total);
    let bar0 = 0;
    for (const sec of def.sections) {
      const velMul = sec.vel || 1;
      for (let bar = 0; bar < sec.bars; bar++) {
        const barStartStep = (bar0 + bar) * 16;
        for (const track of sec.tracks) {
          const kind = track.t;
          if (kind === 'noise') {
            noiseBed(buf, Math.round((bar0 + bar) * barDur * SR), barDur, track.level * velMul, track.kind);
            continue;
          }
          if (kind === 'riser') {
            if (bar === sec.bars - Math.max(1, Math.round(track.bars || 1))) {
              riser(buf, Math.round((bar0 + bar) * barDur * SR), barDur * (track.bars || 1), (track.vel || 0.8) * velMul);
            }
            continue;
          }
          if (kind === 'impact') {
            if (bar === 0) impact(buf, Math.round((bar0 + bar) * barDur * SR), (track.vel || 0.9) * velMul);
            continue;
          }
          if (kind === 'drum') {
            const pat = (track.alt && bar % 2 === 1) ? track.alt : track.pat;
            for (let st = 0; st < 16; st++) {
              const v = VELMAP[pat[st]] || 0;
              if (!v) continue;
              const swingDelay = (swing > 0 && st % 4 === 2) ? swing * stepDur : 0;
              const sampleOff = Math.round(((bar0 + bar) * barDur + st * stepDur + swingDelay) * SR);
              if (track.d === 'kick') kick(buf, sampleOff, v * (track.vel || 1) * velMul);
              else if (track.d === 'snare') snare(buf, sampleOff, v * (track.vel || 1) * velMul, false);
              else if (track.d === 'rim') snare(buf, sampleOff, v * (track.vel || 1) * velMul, true);
              else if (track.d === 'hat') hat(buf, sampleOff, v * (track.vel || 1) * velMul, false);
              else if (track.d === 'openhat') hat(buf, sampleOff, v * (track.vel || 1) * velMul, true);
              else if (track.d === 'clap') clap(buf, sampleOff, v * (track.vel || 1) * velMul);
            }
            continue;
          }
          if (kind === 'notes') { /* [[step, midi, lenSteps, vel], ...] per bar (or bar-long cycle) */
            for (const nt of track.notes) {
              const [st, midi, len, v] = nt;
              if (track.perBar === false && bar !== 0 && track.notesOnce) continue;
              const t = ((bar0 + bar) * barDur) + stepTime(0, st, stepDur, swing);
              const off = Math.round(t * SR);
              const d = len * stepDur;
              const vel = (v === undefined ? 0.8 : v) * (track.vel || 1) * velMul;
              if (track.v === 'sub') sub(buf, off, vel, mf(midi), d);
              else if (track.v === 'pluck') pluck(buf, off, vel, mf(midi), d, track.dark);
              else if (track.v === 'piano') piano(buf, off, vel, mf(midi), d);
              else if (track.v === 'lead') lead(buf, off, vel, mf(midi), d);
            }
            continue;
          }
          if (kind === 'chord') { /* [[step, [midis], lenSteps, vel], ...] */
            for (const c of track.hits) {
              const [st, midis, len, v] = c;
              const t = ((bar0 + bar) * barDur) + st * stepDur;
              const off = Math.round(t * SR);
              chordVoice(buf, off, (v === undefined ? 0.8 : v) * (track.vel || 1) * velMul, midis, len * stepDur, track.v || 'pluckchord');
            }
            continue;
          }
          if (kind === 'padchord') {
            for (const c of track.hits) {
              const [st, midis, len, v] = c;
              const t = ((bar0 + bar) * barDur) + st * stepDur;
              const off = Math.round(t * SR);
              pad(buf, off, (v === undefined ? 0.7 : v) * (track.vel || 1) * velMul, midis, len * stepDur, track.cutoff);
            }
            continue;
          }
          if (kind === 'arp') {
            const everyN = track.every || 2;
            let idx = (bar * 16) / everyN;
            for (let st = 0; st < 16; st += everyN) {
              const note = track.notes[idx % track.notes.length];
              idx++;
              const t = ((bar0 + bar) * barDur) + stepTime(0, st, stepDur, swing);
              const off = Math.round(t * SR);
              const v = (track.vel || 0.4) * velMul * (track.accent && (idx % 4 === 1) ? 1.25 : 1);
              if (track.v === 'piano') piano(buf, off, v, mf(note), stepDur * everyN * 1.1);
              else pluck(buf, off, v, mf(note), stepDur * everyN * 1.1, track.dark);
            }
            continue;
          }
        }
      }
      bar0 += sec.bars;
    }
    /* master: soft clip + normalize */
    let mx = 1e-9;
    for (let i = 0; i < total; i++) { buf[i] = Math.tanh(buf[i] * 1.15); const a = Math.abs(buf[i]); if (a > mx) mx = a; }
    const g = 0.88 / mx;
    for (let i = 0; i < total; i++) buf[i] *= g;
    return { samples: buf, meta: { id: def.id, title: def.title, style: def.style, bpm, duration: total / SR, color: def.color } };
  }

  /* ---------------- demo catalog ---------------- */
  const catalog = [
    {
      id: 'neon', title: 'Neon Circuit', style: 'Electronic', bpm: 128, color: '#00e5ff',
      sections: [
        { type: 'intro', bars: 4, tracks: [
          { t: 'padchord', vel: 0.9, hits: [[0, [57, 60, 64, 69], 8, 0.55], [8, [53, 57, 60, 65], 8, 0.5]] },
          { t: 'arp', every: 4, vel: 0.16, dark: true, notes: [69, 72, 76] }
        ] },
        { type: 'build', bars: 4, tracks: [
          { t: 'drum', d: 'kick', vel: 0.75, pat: 'X...X...X...X...' },
          { t: 'drum', d: 'hat', vel: 0.3, pat: '..x...x...x...x.' },
          { t: 'drum', d: 'snare', vel: 0.6, alt: 'xXxXxXxXxXxXxXxX', pat: '................' },
          { t: 'notes', v: 'sub', notes: [[0, 33, 2, 0.7], [4, 33, 2, 0.5], [8, 33, 2, 0.7], [12, 31, 2, 0.5]] },
          { t: 'riser', bars: 2, vel: 0.8 },
          { t: 'arp', every: 2, vel: 0.2, notes: [57, 64, 69, 72] }
        ] },
        { type: 'drop', bars: 8, tracks: [
          { t: 'drum', d: 'kick', vel: 1, pat: 'X...X...X...X...' },
          { t: 'drum', d: 'clap', vel: 0.65, pat: '....X.......X...' },
          { t: 'drum', d: 'openhat', vel: 0.3, pat: '..o...o...o...o.' },
          { t: 'notes', v: 'sub', notes: [[0, 33, 2, 0.9], [2, 33, 2, 0.55], [4, 33, 2, 0.9], [6, 36, 2, 0.55], [8, 33, 2, 0.9], [10, 33, 2, 0.55], [12, 29, 2, 0.9], [14, 31, 2, 0.55]] },
          { t: 'arp', every: 1, vel: 0.42, accent: true, notes: [57, 64, 69, 72, 76, 72, 69, 64] },
          { t: 'chord', v: 'pluckchord', vel: 0.5, hits: [[0, [57, 60, 64], 2, 0.55], [8, [53, 57, 60], 2, 0.5]] }
        ] },
        { type: 'break', bars: 4, tracks: [
          { t: 'noise', kind: 'vinyl', level: 0.5 },
          { t: 'padchord', vel: 0.8, cutoff: 0.03, hits: [[0, [57, 60, 64, 69], 8, 0.5], [8, [53, 57, 60, 65], 8, 0.5]] },
          { t: 'arp', every: 2, vel: 0.2, dark: true, notes: [69, 72, 76, 72] },
          { t: 'notes', v: 'sub', notes: [[0, 33, 14, 0.5]] }
        ] },
        { type: 'drop', bars: 8, tracks: [
          { t: 'drum', d: 'kick', vel: 1, pat: 'X...X...X...X...' },
          { t: 'drum', d: 'clap', vel: 0.65, pat: '....X.......X...' },
          { t: 'drum', d: 'openhat', vel: 0.3, pat: '..o...o...o...o.' },
          { t: 'notes', v: 'sub', notes: [[0, 33, 2, 0.9], [2, 33, 2, 0.55], [4, 33, 2, 0.9], [6, 36, 2, 0.55], [8, 33, 2, 0.9], [10, 33, 2, 0.55], [12, 29, 2, 0.9], [14, 31, 2, 0.55]] },
          { t: 'arp', every: 1, vel: 0.4, accent: true, notes: [57, 64, 69, 72, 76, 72, 69, 64] },
          { t: 'notes', v: 'lead', vel: 0.5, notes: [[0, 76, 4, 0.5], [4, 74, 2, 0.42], [6, 72, 2, 0.42], [8, 69, 5, 0.5], [13, 72, 3, 0.4]] }
        ] },
        { type: 'outro', bars: 4, tracks: [
          { t: 'drum', d: 'kick', vel: 0.5, pat: 'X...X...X...X...' },
          { t: 'padchord', vel: 0.6, hits: [[0, [57, 60, 64, 69], 16, 0.4]] },
          { t: 'arp', every: 4, vel: 0.18, dark: true, notes: [69, 72, 76] }
        ] }
      ]
    },
    {
      id: 'boombap', title: 'Boom Bap Galaxy', style: 'Hip-Hop', bpm: 88, swing: 0.14, color: '#b06bff',
      sections: [
        { type: 'intro', bars: 2, tracks: [
          { t: 'noise', kind: 'vinyl', level: 0.6 },
          { t: 'chord', v: 'pluckchord', vel: 0.5, hits: [[0, [50, 53, 57, 60], 3, 0.45], [8, [50, 53, 57, 60], 3, 0.3]] }
        ] },
        { type: 'verse', bars: 6, tracks: [
          { t: 'noise', kind: 'vinyl', level: 0.5 },
          { t: 'drum', d: 'kick', vel: 0.95, pat: 'X...x..X..x.x...', alt: 'X.....X...x..x..' },
          { t: 'drum', d: 'snare', vel: 0.85, pat: '....X.......X...' },
          { t: 'drum', d: 'hat', vel: 0.3, pat: '..x...x...x...x.', alt: '..x.x.x...x...x.' },
          { t: 'notes', v: 'sub', notes: [[0, 38, 3, 0.8], [6, 38, 2, 0.55], [8, 41, 3, 0.8], [14, 45, 2, 0.5]] }
        ] },
        { type: 'chorus', bars: 8, tracks: [
          { t: 'noise', kind: 'vinyl', level: 0.4 },
          { t: 'drum', d: 'kick', vel: 1, pat: 'X...x..X..x.x...' },
          { t: 'drum', d: 'snare', vel: 0.9, pat: '....X.......X...' },
          { t: 'drum', d: 'hat', vel: 0.32, pat: '..x...x...x...x.' },
          { t: 'notes', v: 'sub', notes: [[0, 38, 3, 0.85], [6, 38, 2, 0.6], [8, 41, 3, 0.85], [14, 45, 2, 0.55]] },
          { t: 'chord', v: 'pluckchord', vel: 0.55, hits: [[0, [50, 53, 57, 60], 2, 0.55], [6, [46, 50, 53, 58], 2, 0.5], [8, [48, 52, 55, 60], 2, 0.55], [14, [45, 48, 53, 57], 2, 0.5]] },
          { t: 'notes', v: 'pluck', vel: 0.4, notes: [[0, 74, 3, 0.4], [4, 72, 2, 0.32], [8, 69, 4, 0.4], [12, 65, 2, 0.3], [14, 67, 2, 0.3]] }
        ] },
        { type: 'break', bars: 2, tracks: [
          { t: 'noise', kind: 'vinyl', level: 0.6 },
          { t: 'padchord', vel: 0.7, cutoff: 0.035, hits: [[0, [50, 53, 57, 60], 16, 0.45]] }
        ] },
        { type: 'chorus', bars: 6, tracks: [
          { t: 'drum', d: 'kick', vel: 1, pat: 'X...x..X..x.x...' },
          { t: 'drum', d: 'snare', vel: 0.9, pat: '....X.......X...' },
          { t: 'drum', d: 'hat', vel: 0.32, pat: '..x.x.x.x.x.x.x.' },
          { t: 'notes', v: 'sub', notes: [[0, 38, 3, 0.85], [6, 38, 2, 0.6], [8, 41, 3, 0.85], [14, 45, 2, 0.55]] },
          { t: 'chord', v: 'pluckchord', vel: 0.55, hits: [[0, [50, 53, 57, 60], 2, 0.55], [6, [46, 50, 53, 58], 2, 0.5], [8, [48, 52, 55, 60], 2, 0.55], [14, [45, 48, 53, 57], 2, 0.5]] },
          { t: 'notes', v: 'pluck', vel: 0.42, notes: [[0, 77, 2, 0.42], [4, 74, 2, 0.34], [6, 72, 2, 0.34], [10, 69, 4, 0.42]] }
        ] },
        { type: 'outro', bars: 2, tracks: [
          { t: 'noise', kind: 'vinyl', level: 0.7 },
          { t: 'chord', v: 'pluckchord', vel: 0.4, hits: [[0, [50, 53, 57, 60], 6, 0.4]] }
        ] }
      ]
    },
    {
      id: 'rainy', title: 'Rainy Tape', style: 'Lo-Fi', bpm: 72, swing: 0.12, color: '#7fd4a8',
      sections: [
        { type: 'intro', bars: 2, tracks: [
          { t: 'noise', kind: 'rain', level: 0.35 },
          { t: 'noise', kind: 'vinyl', level: 0.45 },
          { t: 'padchord', vel: 0.7, cutoff: 0.03, hits: [[0, [53, 57, 60, 64], 16, 0.42]] }
        ] },
        { type: 'verse', bars: 8, tracks: [
          { t: 'noise', kind: 'rain', level: 0.3 },
          { t: 'noise', kind: 'vinyl', level: 0.4 },
          { t: 'drum', d: 'kick', vel: 0.6, pat: 'X.......X.X.....' },
          { t: 'drum', d: 'rim', vel: 0.75, pat: '....x.......x...' },
          { t: 'drum', d: 'hat', vel: 0.2, pat: '..x...x...x...x.' },
          { t: 'padchord', vel: 0.75, cutoff: 0.032, hits: [[0, [53, 57, 60, 64], 14, 0.4]] },
          { t: 'notes', v: 'sub', notes: [[0, 41, 12, 0.5]] },
          { t: 'notes', v: 'piano', vel: 0.4, notes: [[0, 72, 5, 0.34], [8, 69, 3, 0.28], [12, 67, 3, 0.26]] }
        ] },
        { type: 'break', bars: 2, tracks: [
          { t: 'noise', kind: 'rain', level: 0.4 },
          { t: 'noise', kind: 'vinyl', level: 0.5 },
          { t: 'padchord', vel: 0.7, cutoff: 0.028, hits: [[0, [52, 55, 59, 62], 16, 0.4]] }
        ] },
        { type: 'verse', bars: 8, vel: 1.1, tracks: [
          { t: 'noise', kind: 'rain', level: 0.3 },
          { t: 'noise', kind: 'vinyl', level: 0.4 },
          { t: 'drum', d: 'kick', vel: 0.62, pat: 'X.....x.X.X.....' },
          { t: 'drum', d: 'rim', vel: 0.48, pat: '....x.......x...' },
          { t: 'drum', d: 'hat', vel: 0.22, pat: '..x...x...x...x.', alt: '..x...x.x.x...x.' },
          { t: 'padchord', vel: 0.8, cutoff: 0.034, hits: [[0, [53, 57, 60, 64], 14, 0.42]] },
          { t: 'notes', v: 'sub', notes: [[0, 41, 12, 0.52]] },
          { t: 'notes', v: 'piano', vel: 0.45, notes: [[0, 72, 4, 0.36], [4, 74, 3, 0.3], [8, 76, 4, 0.36], [12, 72, 3, 0.3]] }
        ] },
        { type: 'outro', bars: 2, tracks: [
          { t: 'noise', kind: 'rain', level: 0.45 },
          { t: 'padchord', vel: 0.6, cutoff: 0.026, hits: [[0, [53, 57, 60, 64], 16, 0.38]] }
        ] }
      ]
    },
    {
      id: 'voltage', title: 'Voltage', style: 'Rock', bpm: 140, color: '#ff6b5e',
      sections: [
        { type: 'intro', bars: 2, tracks: [
          { t: 'impact', vel: 0.7 },
          { t: 'drum', d: 'hat', vel: 0.3, pat: 'x.x.x.x.x.x.x.x.' },
          { t: 'chord', v: 'power', vel: 0.55, hits: [[0, [40, 47], 1, 0.5], [2, [40, 47], 1, 0.3], [4, [40, 47], 1, 0.5], [6, [40, 47], 1, 0.3], [8, [40, 47], 1, 0.5], [10, [40, 47], 1, 0.3], [12, [40, 47], 1, 0.5], [14, [40, 47], 1, 0.3]] }
        ] },
        { type: 'verse', bars: 8, tracks: [
          { t: 'drum', d: 'kick', vel: 0.9, pat: 'X..X....X.X.....' },
          { t: 'drum', d: 'snare', vel: 0.9, pat: '....X.......X...' },
          { t: 'drum', d: 'hat', vel: 0.3, pat: 'x.x.x.x.x.x.x.x.' },
          { t: 'chord', v: 'power', vel: 0.6, hits: [[0, [40, 47], 1, 0.45], [2, [40, 47], 1, 0.28], [4, [40, 47], 1, 0.45], [6, [40, 47], 1, 0.28], [8, [43, 50], 1, 0.45], [10, [43, 50], 1, 0.28], [12, [45, 52], 1, 0.45], [14, [45, 52], 1, 0.28]] },
          { t: 'notes', v: 'sub', notes: [[0, 28, 4, 0.7], [4, 28, 4, 0.5], [8, 31, 4, 0.7], [12, 33, 4, 0.5]] }
        ] },
        { type: 'chorus', bars: 8, tracks: [
          { t: 'drum', d: 'kick', vel: 1, pat: 'X...X...X...X...' },
          { t: 'drum', d: 'snare', vel: 0.95, pat: '....X.......X...' },
          { t: 'drum', d: 'hat', vel: 0.32, pat: 'x.x.x.x.x.x.x.x.' },
          { t: 'drum', d: 'openhat', vel: 0.35, pat: 'o...............', alt: '................' },
          { t: 'chord', v: 'power', vel: 0.75, hits: [[0, [40, 47, 52], 6, 0.7], [8, [43, 50, 55], 6, 0.65]] },
          { t: 'notes', v: 'sub', notes: [[0, 28, 6, 0.8], [8, 31, 6, 0.75]] },
          { t: 'notes', v: 'lead', vel: 0.42, notes: [[0, 71, 3, 0.42], [4, 67, 2, 0.34], [6, 64, 2, 0.34], [8, 67, 4, 0.42], [12, 71, 3, 0.36]] }
        ] },
        { type: 'break', bars: 2, tracks: [
          { t: 'drum', d: 'kick', vel: 0.8, pat: 'X.......X.......' },
          { t: 'drum', d: 'snare', vel: 0.5, pat: '........X.......' },
          { t: 'padchord', vel: 0.6, cutoff: 0.03, hits: [[0, [40, 47, 52, 55], 16, 0.4]] },
          { t: 'riser', bars: 1, vel: 0.6 }
        ] },
        { type: 'chorus', bars: 8, vel: 1.05, tracks: [
          { t: 'drum', d: 'kick', vel: 1, pat: 'X...X...X...X...' },
          { t: 'drum', d: 'snare', vel: 0.95, pat: '....X.......X...' },
          { t: 'drum', d: 'hat', vel: 0.34, pat: 'x.x.x.x.x.x.x.x.' },
          { t: 'chord', v: 'power', vel: 0.8, hits: [[0, [40, 47, 52], 6, 0.72], [8, [45, 52, 57], 6, 0.68]] },
          { t: 'notes', v: 'sub', notes: [[0, 28, 6, 0.82], [8, 33, 6, 0.78]] },
          { t: 'notes', v: 'lead', vel: 0.46, notes: [[0, 76, 4, 0.45], [4, 74, 2, 0.36], [6, 71, 2, 0.36], [8, 74, 6, 0.45]] }
        ] },
        { type: 'outro', bars: 2, tracks: [
          { t: 'impact', vel: 0.5 },
          { t: 'chord', v: 'power', vel: 0.4, hits: [[0, [40, 47], 3, 0.4], [8, [40, 47], 8, 0.3]] },
          { t: 'drum', d: 'kick', vel: 0.6, pat: 'X...............' }
        ] }
      ]
    },
    {
      id: 'moonlight', title: 'Moonlight Machine', style: 'Classical', bpm: 76, color: '#cfd8ff',
      sections: [
        { type: 'intro', bars: 2, tracks: [
          { t: 'notes', v: 'piano', vel: 0.42, notes: [[0, 69, 8, 0.32], [8, 64, 8, 0.26]] }
        ] },
        { type: 'verse', bars: 6, tracks: [
          { t: 'arp', v: 'piano', every: 2, vel: 0.36, notes: [45, 52, 57, 60, 64, 60, 57, 52] },
          { t: 'notes', v: 'piano', vel: 0.5, notes: [[0, 76, 4, 0.42], [6, 74, 2, 0.32], [8, 72, 4, 0.38], [14, 71, 2, 0.3]] }
        ] },
        { type: 'chorus', bars: 6, vel: 1.15, tracks: [
          { t: 'arp', v: 'piano', every: 2, vel: 0.42, notes: [41, 48, 53, 57, 60, 57, 53, 48] },
          { t: 'notes', v: 'piano', vel: 0.55, notes: [[0, 72, 4, 0.46], [4, 74, 2, 0.36], [6, 76, 3, 0.42], [10, 77, 3, 0.4], [13, 76, 3, 0.36]] }
        ] },
        { type: 'drop', bars: 6, vel: 1.3, tracks: [
          { t: 'arp', v: 'piano', every: 1, vel: 0.4, notes: [45, 52, 57, 60, 64, 60, 57, 52] },
          { t: 'notes', v: 'piano', vel: 0.6, notes: [[0, 88, 4, 0.4], [4, 86, 2, 0.3], [6, 84, 2, 0.3], [8, 81, 6, 0.42]] }
        ] },
        { type: 'outro', bars: 2, tracks: [
          { t: 'chord', v: 'pianochord', vel: 0.5, hits: [[0, [45, 52, 57, 64, 71], 16, 0.42]] }
        ] }
      ]
    },
    {
      id: 'hyperdrive', title: 'Hyperdrive', style: 'Drum & Bass', bpm: 174, color: '#ff4fd8',
      sections: [
        { type: 'intro', bars: 4, tracks: [
          { t: 'padchord', vel: 0.8, cutoff: 0.04, hits: [[0, [53, 56, 60], 16, 0.4]] },
          { t: 'notes', v: 'sub', notes: [[0, 29, 8, 0.5]] },
          { t: 'drum', d: 'hat', vel: 0.18, pat: '..x...x...x...x.' }
        ] },
        { type: 'build', bars: 4, tracks: [
          { t: 'drum', d: 'kick', vel: 0.85, pat: 'X.........x.....' },
          { t: 'drum', d: 'snare', vel: 0.8, pat: '....X.......X...' },
          { t: 'drum', d: 'hat', vel: 0.24, pat: 'x.x.x.x.x.x.x.x.' },
          { t: 'notes', v: 'sub', notes: [[0, 29, 2, 0.7], [2, 29, 2, 0.45], [4, 29, 2, 0.7], [6, 41, 2, 0.45], [8, 29, 2, 0.7], [10, 36, 2, 0.45], [12, 29, 2, 0.7], [14, 34, 2, 0.45]] },
          { t: 'riser', bars: 2, vel: 0.85 },
          { t: 'drum', d: 'snare', vel: 0.55, alt: 'xXxXxXxXxXxXxXxX', pat: '................' }
        ] },
        { type: 'drop', bars: 8, tracks: [
          { t: 'drum', d: 'kick', vel: 1, pat: 'X.........x.....' },
          { t: 'drum', d: 'snare', vel: 0.95, pat: '....X..x....X...' },
          { t: 'drum', d: 'hat', vel: 0.2, pat: 'xxxxxxxxxxxxxxxx' },
          { t: 'notes', v: 'sub', notes: [[0, 29, 2, 0.9], [2, 29, 2, 0.55], [4, 29, 2, 0.9], [6, 41, 2, 0.55], [8, 29, 2, 0.9], [10, 36, 2, 0.55], [12, 29, 2, 0.9], [14, 34, 2, 0.55]] },
          { t: 'arp', every: 1, vel: 0.38, accent: true, notes: [56, 63, 68, 72, 75, 72, 68, 63] }
        ] },
        { type: 'break', bars: 4, tracks: [
          { t: 'noise', kind: 'vinyl', level: 0.4 },
          { t: 'padchord', vel: 0.8, cutoff: 0.03, hits: [[0, [53, 56, 60], 16, 0.4]] },
          { t: 'arp', every: 2, vel: 0.2, dark: true, notes: [68, 72, 75, 72] },
          { t: 'notes', v: 'sub', notes: [[0, 29, 14, 0.45]] }
        ] },
        { type: 'drop', bars: 8, vel: 1.05, tracks: [
          { t: 'drum', d: 'kick', vel: 1, pat: 'X.........x.....' },
          { t: 'drum', d: 'snare', vel: 0.95, pat: '....X..x....X...' },
          { t: 'drum', d: 'hat', vel: 0.22, pat: 'xxxxxxxxxxxxxxxx' },
          { t: 'notes', v: 'sub', notes: [[0, 29, 2, 0.9], [2, 29, 2, 0.55], [4, 29, 2, 0.9], [6, 41, 2, 0.55], [8, 29, 2, 0.9], [10, 36, 2, 0.55], [12, 29, 2, 0.9], [14, 34, 2, 0.55]] },
          { t: 'arp', every: 1, vel: 0.36, accent: true, notes: [56, 63, 68, 72, 75, 72, 68, 63] },
          { t: 'chord', v: 'pluckchord', vel: 0.5, hits: [[0, [53, 56, 60], 1, 0.5], [8, [58, 62, 65], 1, 0.45]] }
        ] },
        { type: 'outro', bars: 2, tracks: [
          { t: 'notes', v: 'sub', notes: [[0, 29, 14, 0.5]] },
          { t: 'padchord', vel: 0.6, cutoff: 0.03, hits: [[0, [53, 56, 60], 16, 0.35]] }
        ] }
      ]
    }
  ];

  RS.DemoSynth = { catalog, renderSong, SR };
  if (typeof module !== 'undefined' && module.exports) module.exports = RS.DemoSynth;
})();

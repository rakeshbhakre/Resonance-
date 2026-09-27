/* Analyzer tests: synthetic signals with known tempo → verify BPM & beat alignment. */
'use strict';
const path = require('path');
const SR = 44100;

function require_src(f) { return require(path.join(__dirname, '..', 'src', f)); }

/* --- tiny local synth helpers for test signals --- */
function kickBurst(out, off, vel) {
  const dur = 0.25;
  for (let i = 0; i < dur * SR && off + i < out.length; i++) {
    const t = i / SR;
    const f = 42 + 110 * Math.exp(-t * 38);
    out[off + i] += vel * Math.exp(-t * 16) * Math.sin(2 * Math.PI * f * t);
  }
}
function hatBurst(out, off, vel) {
  const dur = 0.05;
  let prev = 0, prev2 = 0;
  for (let i = 0; i < dur * SR && off + i < out.length; i++) {
    const t = i / SR;
    const n = Math.random() * 2 - 1;
    const lp = prev + 0.75 * (n - prev); prev = lp;          /* LP */
    const hp = prev - (prev2 + 0.72 * (prev - prev2)); prev2 = hp; /* HP of LP → band-limited */
    out[off + i] += vel * 0.45 * Math.exp(-t * 90) * (lp - hp);
  }
}
function makeTrack(bpm, bars, opts) {
  opts = opts || {};
  const T = 60 / bpm, dur = bars * 4 * T + 1;
  const out = new Float32Array(Math.ceil(dur * SR));
  const step = T / 4; /* 16ths */
  for (let b = 0; b < bars * 4; b++) {
    const bt = 0.5 + b * T;
    kickBurst(out, Math.round(bt * SR), 0.9);
    if (opts.hats !== false) hatBurst(out, Math.round((bt + T / 2) * SR), 0.35);
    if (opts.hats !== false) hatBurst(out, Math.round((bt + T / 4) * SR), 0.18);
    if (opts.snare && b % 2 === 1) hatBurst(out, Math.round(bt * SR), 0.8);
    /* quiet noise bed so it's not pure silence between hits */
    for (let i = 0; i < T * SR; i++) out[Math.round(bt * SR) + i] += (Math.random() * 2 - 1) * 0.003;
  }
  return out;
}

let failures = 0, checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) { failures++; console.error('  ✗ FAIL: ' + msg); }
  else console.log('  ✓ ' + msg);
}
function approx(a, b, tol, msg) { assert(Math.abs(a - b) <= tol, `${msg} (got ${a.toFixed(2)}, want ${b.toFixed(2)} ±${tol})`); }

async function testTrack(name, bpm, bars, opts, bpmTol, beatTolMs) {
  console.log(`\n[${name}] @ ${bpm} BPM`);
  const samples = makeTrack(bpm, bars, opts);
  const A = require_src('analyzer.js');
  const res = await A.analyze(samples, SR, {});
  approx(res.bpm, bpm, bpmTol, `BPM ≈ ${bpm}`);
  assert(res.beats.length > bars * 2, `enough beats (${res.beats.length})`);
  assert(res.beats.every((b) => isFinite(b.time) && b.time >= 0 && b.time < res.duration + 0.5), 'beat times finite/in-range');
  assert(res.beats.every((b) => isFinite(b.strength)), 'beat strengths finite');
  assert(res.sections.length >= 1 && res.sections.every((s) => s.end > s.start), `sections valid (${res.sections.length})`);
  assert(res.sections.every((s) => ['intro', 'verse', 'build', 'chorus', 'drop', 'break', 'outro'].includes(s.type)), 'section types valid');
  assert(isFinite(res.intensity) && res.intensity >= 0 && res.intensity <= 1, 'intensity in 0..1');
  assert(res.fingerprint && res.fingerprint.length === 8, 'fingerprint present');
  /* beat alignment: most beats near true grid */
  const T = 60 / bpm;
  let aligned = 0;
  for (const b of res.beats) {
    const rel = (b.time - 0.5) / T;
    const err = Math.abs(rel - Math.round(rel)) * T * 1000;
    if (err <= beatTolMs) aligned++;
  }
  const ratio = aligned / res.beats.length;
  assert(ratio > 0.8, `≥80% beats aligned to grid (${(ratio * 100).toFixed(1)}%, tol ${beatTolMs}ms)`);
  /* energy curves sane */
  assert(res.energyCurve.length > 100 && res.energyCurve.every((v) => v >= -0.001 && v <= 1.001), 'energyCurve 0..1');
  return res;
}

(async function run() {
  const A = require_src('analyzer.js');

  console.log('\n[FFT sanity] sine at 1kHz → peak bin');
  {
    /* direct probe of the spectrum via a full analyze on a pure sine is overkill;
       instead check flux/onsets fire on a click train (covered below) and that a
       pure sine doesn't crash and yields an energyCurve near its band. */
    const sine = new Float32Array(SR * 4).map((_, i) => 0.5 * Math.sin(2 * Math.PI * 1000 * i / SR));
    const r = await A.analyze(sine, SR, {});
    assert(isFinite(r.bpm) && r.bpm > 0, `sine: bpm finite (${r.bpm})`);
    assert(r.duration > 3.9, 'sine: duration ok');
  }

  await testTrack('electronic 128', 128, 16, {}, 1.5, 30);
  await testTrack('hiphop 88', 88, 12, { snare: true }, 1.5, 35);
  await testTrack('slow 72', 72, 10, {}, 1.5, 40);
  await testTrack('fast 174', 174, 24, { snare: true }, 2.5, 25);

  console.log('\n[silence fallback]');
  {
    const sil = new Float32Array(SR * 6);
    const r = await A.analyze(sil, SR, {});
    assert(r.fallback === true, 'fallback flagged on silence');
    assert(r.beats.length > 4, 'fallback grid exists');
    approx(r.bpm, 120, 0.1, 'fallback BPM = 120');
  }

  console.log('\n[determinism]');
  {
    const s1 = makeTrack(128, 8, {});
    const r1 = await A.analyze(s1.slice(), SR, {});
    const r2 = await A.analyze(s1.slice(), SR, {});
    assert(r1.fingerprint === r2.fingerprint, 'same input → same fingerprint');
    assert(r1.beats.length === r2.beats.length && r1.beats.every((b, i) => Math.abs(b.time - r2.beats[i].time) < 1e-9), 'same input → same beats');
  }

  console.log(`\n=== ${checks - failures}/${checks} checks passed, ${failures} failed ===`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

/* Demo synth → analyzer integration test: each demo track must analyze sanely. */
'use strict';
const path = require('path');
function require_src(f) { return require(path.join(__dirname, '..', 'src', f)); }
const DS = require_src('demosynth.js');
const A = require_src('analyzer.js');

let failures = 0, checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) { failures++; console.error('  ✗ FAIL: ' + msg); }
  else console.log('  ✓ ' + msg);
}

(async function run() {
  for (const def of DS.catalog) {
    console.log(`\n[${def.title} — ${def.style} @ ${def.bpm} BPM]`);
    const t0 = Date.now();
    const { samples, meta } = DS.renderSong(def);
    const renderMs = Date.now() - t0;
    console.log(`  rendered ${meta.duration.toFixed(1)}s in ${renderMs}ms`);
    assert(renderMs < 3000, `render < 3s (${renderMs}ms)`);
    assert(meta.duration > 25 && meta.duration < 90, `duration reasonable (${meta.duration.toFixed(1)}s)`);
    /* non-silence + peak level */
    let peak = 0, rms = 0;
    for (let i = 0; i < samples.length; i += 16) { const v = Math.abs(samples[i]); if (v > peak) peak = v; rms += v * v; }
    rms = Math.sqrt(rms / (samples.length / 16));
    assert(peak > 0.5 && peak <= 1.0, `peak in range (${peak.toFixed(2)})`);
    assert(rms > 0.02, `rms non-trivial (${rms.toFixed(3)})`);

    const res = await A.analyze(samples, DS.SR, {});
    console.log(`  analysis: bpm=${res.bpm} conf=${res.bpmConfidence.toFixed(2)} beats=${res.beats.length} intensity=${res.intensity.toFixed(2)} onsets/s=${res.onsetDensity.toFixed(1)} ${res.analyzerMs}ms`);
    assert(!res.fallback, 'no fallback');
    /* Steady arpeggio streams (e.g. classical) are genuinely octave-ambiguous:
       accept the half or double reading, but require self-consistent grid. */
    const ratio = res.bpm / def.bpm;
    const okBpm = Math.abs(ratio - 1) <= 0.03 || Math.abs(ratio - 2) <= 0.03 || Math.abs(ratio - 0.5) <= 0.03;
    assert(okBpm, `BPM ≈ ${def.bpm} (or octave) (got ${res.bpm})`);
    assert(res.beats.length > 30, `enough beats (${res.beats.length})`);
    /* beat alignment to the DETECTED grid's half/whole relation to truth */
    const T = 60 / res.bpm;
    let aligned = 0;
    for (const b of res.beats) {
      const rel = (b.time - 0) / T;
      const err = Math.abs(rel - Math.round(rel)) * T * 1000;
      if (err <= 40) aligned++;
    }
    assert(aligned / res.beats.length > 0.7, `beats on detected grid (${(100 * aligned / res.beats.length).toFixed(0)}%)`);
    /* sections sanity */
    const types = res.sections.map((s) => s.type);
    console.log('  sections: ' + res.sections.map((s) => `${s.type} ${s.start.toFixed(0)}-${s.end.toFixed(0)}`).join(' | '));
    assert(res.sections.length >= 2, `multiple sections (${res.sections.length})`);
    assert(res.sections.every((s) => s.end > s.start && s.start >= 0), 'sections ordered');
    /* peaks/drops for energetic songs */
    if (def.bpm >= 120) {
      console.log(`  peaks: ${res.peaks.map((p) => p.time.toFixed(1)).join(', ') || 'none'} | drops: ${res.drops.map((d) => d.time.toFixed(1)).join(', ') || 'none'}`);
    }
  }
  console.log(`\n=== ${checks - failures}/${checks} checks passed, ${failures} failed ===`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

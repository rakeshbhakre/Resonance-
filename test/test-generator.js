/* Generator tests: determinism, constraints, mode/difficulty behavior. */
'use strict';
const path = require('path');
function require_src(f) { return require(path.join(__dirname, '..', 'src', f)); }
require_src('utils.js');
const DS = require_src('demosynth.js');
const A = require_src('analyzer.js');
const GEN = require_src('generator.js');

let failures = 0, checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) { failures++; console.error('  ✗ FAIL: ' + msg); }
  else console.log('  ✓ ' + msg);
}

(async function run() {
  /* build analyses once for all demo songs */
  const songs = [];
  for (const def of DS.catalog) {
    const { samples, meta } = DS.renderSong(def);
    const an = await A.analyze(samples, DS.SR, {});
    songs.push({ def, meta, an, samples });
  }

  console.log('\n[difficulty estimation reflects song character]');
  for (const s of songs) {
    const est = GEN.estimateDifficulty(s.an);
    console.log(`  ${s.def.title}: bpm=${s.an.bpm} density=${s.an.onsetDensity.toFixed(1)}/s → ${est.key} (${est.score.toFixed(2)})`);
  }
  const lofi = songs.find(s => s.def.id === 'rainy');
  const dnb = songs.find(s => s.def.id === 'hyperdrive');
  assert(GEN.estimateDifficulty(lofi.an).score < GEN.estimateDifficulty(dnb.an).score, 'lo-fi estimates easier than D&B');

  console.log('\n[generation: constraints + stats per song/mode/difficulty]');
  for (const s of songs) {
    for (const mode of ['rhythm', 'flow', 'zen']) {
      const { events, meta: gm } = GEN.generate(s.an, { mode, difficulty: 'normal' });
      const v = gm.stats;
      assert(v.problemCount === 0, `${s.def.title}/${mode}: no constraint problems ${v.problems.join(';')}`);
      assert(events.every(e => isFinite(e.time) && e.time >= 0), `${s.def.title}/${mode}: times finite`);
      assert(events.every(e => e.type !== 'HAZARD' || mode === 'rhythm'), `${s.def.title}/${mode}: hazards only in rhythm`);
      const first = events.find(e => e.type !== 'ORB');
      if (first) assert(first.time >= gm.leadIn - 0.01, `${s.def.title}/${mode}: first event after lead-in`);
      const counted = events.filter(e => e.type !== 'ORB');
      console.log(`  ${s.def.title}/${mode}: ${counted.length} events (${gm.eventsPerSec.toFixed(1)}/s) approach=${gm.approach.toFixed(2)}s`);
    }
  }

  console.log('\n[determinism]');
  {
    const s = songs.find(x => x.def.id === 'neon');
    const g1 = GEN.generate(s.an, { mode: 'rhythm', difficulty: 'hard' });
    const g2 = GEN.generate(s.an, { mode: 'rhythm', difficulty: 'hard' });
    assert(g1.meta.seed === g2.meta.seed, 'same seed');
    assert(g1.events.length === g2.events.length, 'same event count');
    assert(g1.events.every((e, i) => e.time === g2.events[i].time && e.type === g2.events[i].type && e.lane === g2.events[i].lane), 'identical timelines');
    const g3 = GEN.generate(s.an, { mode: 'rhythm', difficulty: 'easy' });
    assert(g3.meta.seed !== g1.meta.seed || g3.events.length !== g1.events.length, 'different difficulty → different timeline');
    const g4 = GEN.generate(s.an, { mode: 'zen', difficulty: 'hard' });
    assert(!g4.events.some(e => e.type === 'HAZARD'), 'zen never has hazards');
  }

  console.log('\n[event richness: every song has specials/holds/peaks where music supports them]');
  for (const s of songs) {
    const { events } = GEN.generate(s.an, { mode: 'rhythm', difficulty: 'hard' });
    const types = {};
    for (const e of events) types[e.type] = (types[e.type] || 0) + 1;
    console.log(`  ${s.def.title}: ` + Object.entries(types).map(([k, v]) => `${k}×${v}`).join(' '));
    assert(types.TAP > 20, `${s.def.title}: has taps`);
    if (s.def.id !== 'moonlight') assert((types.SPECIAL || 0) > 3, `${s.def.title}: has special targets`);
    if (s.def.id === 'neon' || s.def.id === 'hyperdrive') assert((types.PEAK || 0) >= 1, `${s.def.title}: has peak events`);
  }

  console.log('\n[density scales with difficulty]');
  {
    const s = songs.find(x => x.def.id === 'neon');
    const counts = {};
    for (const d of ['easy', 'normal', 'hard', 'extreme']) {
      const { events } = GEN.generate(s.an, { mode: 'rhythm', difficulty: d });
      counts[d] = events.filter(e => e.type !== 'ORB').length;
    }
    console.log(`  neon: ${JSON.stringify(counts)}`);
    assert(counts.easy < counts.normal && counts.normal < counts.hard && counts.hard <= counts.extreme + 8, 'monotonic-ish density');
  }

  console.log('\n[hazard separation from targets]');
  {
    const s = songs.find(x => x.def.id === 'hyperdrive');
    const { events } = GEN.generate(s.an, { mode: 'rhythm', difficulty: 'extreme' });
    const hazards = events.filter(e => e.type === 'HAZARD');
    const targets = events.filter(e => e.type === 'TAP' || e.type === 'SPECIAL' || e.type === 'HOLD');
    let conflicts = 0;
    for (const h of hazards) {
      for (const t of targets) {
        if (t.lane === h.lane && Math.abs(t.time - h.time) < 0.55) conflicts++;
      }
    }
    console.log(`  hyperdrive extreme: ${hazards.length} hazards, ${conflicts} conflicts`);
    assert(conflicts === 0, 'hazards never share a lane with targets within 0.55s');
  }

  console.log(`\n=== ${checks - failures}/${checks} checks passed, ${failures} failed ===`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

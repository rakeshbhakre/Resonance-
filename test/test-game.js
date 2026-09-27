/* Full headless playthrough: stubs DOM/canvas/audio, a "perfect bot" plays
 * generated levels end-to-end through the real GameEngine. */
'use strict';

/* ---- stubs (before requiring modules) ---- */
const fakeGradient = { addColorStop() { } };
function fakeCtx() {
  const noop = () => { };
  return new Proxy({}, {
    get(t, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => fakeGradient;
      if (k === 'canvas') return { width: 960, height: 540 };
      return noop;
    },
    set() { return true; }
  });
}
global.document = global.document || {
  createElement() { return { width: 0, height: 0, getContext: () => fakeCtx() }; }
};

const path = require('path');
function require_src(f) { return require(path.join(__dirname, '..', 'src', f)); }
require_src('utils.js');
require_src('entities.js');
require_src('world.js');
require_src('clock.js');
require_src('scoring.js');
const DS = require_src('demosynth.js');
const A = require_src('analyzer.js');
const GEN = require_src('generator.js');
const GameEngine = require_src('engine.js');

let failures = 0, checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) { failures++; console.error('  ✗ FAIL: ' + msg); }
  else console.log('  ✓ ' + msg);
}

/* fake audio engine driven by test time */
function fakeAudio() {
  return {
    t: -10, playing: false, _freqData: null,
    songTime() { return this.t; },
    latencySeconds() { return 0; },
    bands() { return { bass: 0.4, mid: 0.4, high: 0.3, level: 0.4 }; },
    sfx() { }, pause() { }, resume() { }, stop() { }
  };
}

function makeSong(id, mode, difficulty) {
  const def = DS.catalog.find(d => d.id === id);
  const { samples, meta } = DS.renderSong(def);
  return A.analyze(samples, DS.SR, {}).then(an => {
    const timeline = GEN.generate(an, { mode, difficulty });
    return { analysis: an, timeline, title: meta.title, subtitle: meta.style, samples };
  });
}

/* perfect-bot player over the timeline */
function runBot(engine, audio, song, opts) {
  opts = opts || {};
  const events = song.timeline.events;
  const done = new Set();
  const held = new Set();
  const dt = 1 / 60;
  const countdown = 3 * Math.min(1, Math.max(0.55, 2 * 60 / song.analysis.bpm)) + 0.3;
  let finishRes = null, hudCount = 0, sectionCount = 0;
  engine.hooks.onFinish = (r) => { finishRes = r; };
  engine.hooks.onHUD = () => { hudCount++; };
  engine.hooks.onSection = () => { sectionCount++; };
  engine.setCanvas(fakeCtx());
  engine.setAudio(audio);
  engine.load(song);
  engine.start();
  const chaos = opts.chaos;
  let rng = opts.rngSeed ? (() => { let s = opts.rngSeed; return () => (s = (s * 16807) % 2147483647) / 2147483647; })() : null;
  for (let t = -countdown; t < song.analysis.duration + 2.5; t += dt) {
    audio.t = t;
    engine.update(t, dt);
    engine.render();
    if (engine.state === 'finished') break;
    if (engine.state === 'playing' && !chaos) {
      for (const ev of events) {
        if (done.has(ev.id)) continue;
        if (ev.type === 'ORB') { done.add(ev.id); continue; }
        if (ev.type === 'HAZARD') {
          /* avoid pressing the hazard lane near its time */
          if (Math.abs(t - ev.time) < 0.4) done.add(ev.id);
          continue;
        }
        if (ev.type === 'PEAK') {
          if (t >= ev.time - 0.006) { engine.pressSpace(t); done.add(ev.id); }
          continue;
        }
        if (ev.type === 'GATE' || ev.type === 'WALL') { done.add(ev.id); continue; }
        if (ev.type === 'HOLD') {
          if (t >= ev.time - 0.006 && t < ev.time + 0.02 && !held.has(ev.id)) {
            engine.pressLane(ev.lane, t); held.add(ev.id);
          } else if (held.has(ev.id) && t >= ev.time + ev.dur - 0.004) {
            engine.releaseLane(ev.lane, t); done.add(ev.id);
          }
          continue;
        }
        if (t >= ev.time - 0.006 && t < ev.time + 0.02) { engine.pressLane(ev.lane, t); done.add(ev.id); }
      }
      /* also release held keys for holds we may have missed */
      for (const ev of events) {
        if (ev.type === 'HOLD' && held.has(ev.id) && done.has(ev.id)) engine.pressedLanes[ev.lane] = false;
      }
    } else if (engine.state === 'playing' && chaos && rng) {
      if (rng() < 0.3) engine.pressLane(Math.floor(rng() * 4), t);
      if (rng() < 0.02) engine.pressSpace(t);
      if (rng() < 0.1) engine.pointerDown(200 + rng() * 500, 300 + rng() * 200, t);
    }
  }
  /* force-finish if the loop ended first */
  if (!finishRes) engine.finish();
  return { finishRes, hudCount, sectionCount };
}

(async function run() {
  console.log('\n[perfect bot: rhythm/normal on Neon Circuit]');
  {
    const song = await makeSong('neon', 'rhythm', 'normal');
    const engine = new GameEngine({});
    const res = runBot(engine, fakeAudio(), song);
    const r = res.finishRes;
    assert(!!r, 'game finished with results');
    assert(r.score > 3000, `substantial score (${r.score})`);
    assert(r.accuracy > 0.9, `high accuracy (${(r.accuracy * 100).toFixed(1)}%)`);
    assert(r.maxCombo > 40, `big combo (${r.maxCombo})`);
    assert(r.judged > 50, `many judgments (${r.judged})`);
    assert(r.completed, 'marked completed');
    assert(Number.isFinite(r.avgOffsetMs) && Number.isFinite(r.offsetStdMs), 'offset stats finite');
    assert(res.hudCount > 10, `HUD updated (${res.hudCount})`);
    assert(res.sectionCount >= 1, `section events fired (${res.sectionCount})`);
    console.log(`  → score=${r.score} acc=${(r.accuracy * 100).toFixed(1)}% combo=${r.maxCombo} grade=${r.grade} stars=${r.stars} avgOff=${r.avgOffsetMs.toFixed(1)}ms`);
  }

  console.log('\n[determinism: identical play → identical score]');
  {
    const song = await makeSong('neon', 'rhythm', 'hard');
    const e1 = new GameEngine({}); const r1 = runBot(e1, fakeAudio(), song).finishRes;
    const e2 = new GameEngine({}); const r2 = runBot(e2, fakeAudio(), song).finishRes;
    assert(r1.score === r2.score && r1.accuracy === r2.accuracy, `same bot → same outcome (${r1.score} vs ${r2.score})`);
  }

  console.log('\n[chaos bot: spammy input never crashes or NaNs]');
  {
    const song = await makeSong('hyperdrive', 'rhythm', 'extreme');
    const engine = new GameEngine({});
    const res = runBot(engine, fakeAudio(), song, { chaos: true, rngSeed: 42 });
    const r = res.finishRes;
    assert(Number.isFinite(r.score), `finite score under chaos (${r.score})`);
    assert(r.hazardHits + r.counts.miss > 0, 'chaos produces misses/hits (judgment paths exercised)');
  }

  console.log('\n[all modes × all songs: complete without errors]');
  for (const id of ['neon', 'boombap', 'rainy', 'voltage', 'moonlight', 'hyperdrive']) {
    for (const mode of ['rhythm', 'flow', 'zen']) {
      const song = await makeSong(id, mode, 'normal');
      const engine = new GameEngine({});
      let err = null;
      try {
        const res = runBot(engine, fakeAudio(), song, mode === 'flow' ? {} : {});
        assert(res.finishRes && Number.isFinite(res.finishRes.score), `${id}/${mode}: finished, score=${res.finishRes.score}`);
      } catch (e) { err = e; }
      assert(!err, `${id}/${mode}: no exception ${err && err.message}`);
    }
  }

  console.log('\n[flow bot: steering via pointer reaches gates]');
  {
    const song = await makeSong('voltage', 'flow', 'normal');
    const engine = new GameEngine({});
    const events = song.timeline.events;
    const dt = 1 / 60;
    const countdown = 3 * 0.86 + 0.3;
    const audio = fakeAudio();
    let finishRes = null;
    engine.hooks.onFinish = r => finishRes = r;
    engine.setCanvas(fakeCtx());
    engine.setAudio(audio);
    engine.load(song);
    engine.start();
    let gatesDone = 0, gatesTotal = events.filter(e => e.type === 'GATE').length;
    for (let t = -countdown; t < song.analysis.duration + 2.5; t += dt) {
      audio.t = t;
      engine.update(t, dt);
      engine.render();
      if (engine.state === 'finished') break;
      if (engine.state === 'playing') {
        /* steer to the next un-passed gate */
        let next = null;
        for (const ev of events) {
          if (ev.type === 'GATE' && ev.time > t - 0.02) { next = ev; break; }
        }
        if (next) {
          const L = engine.world.L;
          const targetX = L.flowX(next.lane + 0.5, 1);
          engine.pointerMove(targetX, L.orbY);
        }
      }
    }
    if (!finishRes) engine.finish();
    assert(Number.isFinite(finishRes.score) && finishRes.score > 500, `flow playable (${finishRes.score}, gates ${gatesTotal})`);
    assert(finishRes.judged > 20, `flow judgments happen (${finishRes.judged})`);
  }

  console.log('\n[adaptive director: struggles → assist, excels → excite]');
  {
    const S = RS.Scoring;
    const ad = new S.AdaptiveDirector(true);
    const t0 = 100;
    for (let i = 0; i < 24; i++) ad.onJudgment('miss', t0 + i);
    ad.tick(t0 + 24);
    assert(ad.state === 'assist' && ad.activeCullTier === 2, `assist engaged (${ad.state})`);
    ad.recent = [];
    for (let i = 0; i < 30; i++) ad.onJudgment('perfect', t0 + 30 + i);
    ad.tick(t0 + 61);
    assert(ad.state !== 'assist', 'recovers from assist');
    const ad2 = new S.AdaptiveDirector(true);
    for (let i = 0; i < 30; i++) ad2.onJudgment('perfect', t0 + i);
    ad2.tick(t0 + 31);
    assert(ad2.state === 'excite' && ad2.extras, `excite engaged (${ad2.state})`);
    const ad3 = new S.AdaptiveDirector(false);
    ad3.onJudgment('miss', 1); ad3.tick(2);
    assert(ad3.state === 'baseline' && ad3.activeCullTier === 99, 'disabled director stays neutral');
  }

  console.log('\n[score manager unit checks]');
  {
    const S = RS.Scoring;
    const sm = new S.ScoreManager({ windowScale: 1 });
    const r1 = sm.judge(0.01, {});           /* perfect */
    assert(r1.grade === 'perfect' && r1.gain === 100, `perfect = 100 pts (${r1.gain})`);
    for (let i = 0; i < 9; i++) sm.judge(0.02, {});
    assert(sm.multiplier() === 2, `combo 10 → ×2 (${sm.multiplier()})`);
    sm.judge(0.3, {});                        /* miss */
    assert(sm.combo === 0, 'miss resets combo');
    assert(sm.counts.miss === 1, 'miss counted');
    const g = S.gradeOffset(0.06, 1);
    assert(g === 'great', `60ms → great (${g})`);
    assert(S.gradeOffset(0.2, 1) === 'miss', '200ms → miss');
    assert(S.gradeOffset(0.04, 1.25) === 'perfect', 'easy windows widened');
  }

  console.log(`\n=== ${checks - failures}/${checks} checks passed, ${failures} failed ===`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

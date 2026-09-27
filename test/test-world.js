/* ============================================================
   RESONANCE — test/test-world.js
   Unit tests for World rendering: flow-mode road geometry
   (5 columns, accent pads, no key labels), rhythm-mode pads,
   and climax pad heating. Uses a recording 2D context.
   ============================================================ */
'use strict';

/* entities.js touches document.createElement at module load (sprite
   cache) — stub it BEFORE requiring the modules. */
const fakeGradient = { addColorStop() { } };
const fakeCanvas2d = () => ({
  width: 0, height: 0,
  getContext: () => new Proxy({}, {
    get(t, p) {
      if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => fakeGradient;
      if (typeof p === 'string') return () => { };
      return undefined;
    },
    set() { return true; },
  }),
  toDataURL: () => '',
});
global.document = {
  createElement: (tag) => fakeCanvas2d(),
  addEventListener: () => { },
  hidden: false,
  readyState: 'complete',
  head: { appendChild: () => { } },
  body: { classList: { toggle: () => { }, add: () => { }, remove: () => { } } },
  getElementsByTagName: () => [],
};
global.window = global;
global.performance = global.performance || { now: () => Date.now() };

require('../src/utils.js');
require('../src/entities.js');
require('../src/world.js');

const RS = global.RS;

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ FAIL: ' + msg); }
}

/* recording 2D context: counts interesting calls + captures styles */
function recordingCtx() {
  const calls = { fillText: [], strokes: [], fills: [], arcs: 0 };
  const gradient = { addColorStop: () => { } };
  return {
    calls,
    ctx: new Proxy({}, {
      get(t, prop) {
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => gradient;
        if (prop === 'measureText') return () => ({ width: 10 });
        if (prop === 'fillText') return (txt, x, y) => { calls.fillText.push(String(txt)); };
        if (prop === 'stroke') return () => { calls.strokes.push(t.strokeStyle); };
        if (prop === 'fill') return () => { calls.fills.push(t.fillStyle); };
        if (prop === 'arc') return () => { calls.arcs++; };
        if (prop === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
        if (typeof prop === 'string') return () => { };
        return undefined;
      },
      set(t, prop, v) { t[prop] = v; return true; },
    }),
  };
}

/* ---------------- tests ---------------- */
(async function main() {
  console.log('— flow-mode road —');
  {
    const w = new RS.World.World();
    w.resize(1280, 800);
    w.update(0.016, { now: 1, bands: { bass: 0.5, mid: 0.4, high: 0.3, level: 0.4 }, zen: false, climax: 0 });
    const rec = recordingCtx();
    w.drawRoad(rec.ctx, {
      now: 1, bands: { bass: 0.5, mid: 0.4, high: 0.3, level: 0.4 },
      beatLines: [], mode: 'flow', pressedLanes: [0, 0, 0, 0, 0], showKeys: true,
    });
    /* 5 columns of pads → 5 pad strokes (plus 6 lane separators use the same strokeStyle bucket) */
    const laneSep = 6, padStrokes = rec.calls.strokes.length - laneSep;
    assert(padStrokes === 5, 'flow road renders 5 pad columns (got ' + padStrokes + ' pad strokes)');
    assert(rec.calls.fillText.length === 0, 'flow road draws no A/S/D/F key labels (got ' + JSON.stringify(rec.calls.fillText) + ')');
    /* flow pads stroke with the theme accent (verse default #00d5ff = 0,213,255).
       Lane separators legitimately use th.lane (#22d3ee) which coincides with a
       LANE_COLORS entry, so we assert the accent positively instead. */
    const acc = RS.util.hexToRgb(RS.World.THEMES.verse.accent);
    const hasAccentPad = rec.calls.strokes.some((s) => s && s.includes(acc.r + ',' + acc.g + ',' + acc.b));
    assert(hasAccentPad, 'flow pads use the theme accent color (rgba ' + acc.r + ',' + acc.g + ',' + acc.b + ')');
  }

  console.log('— rhythm-mode road —');
  {
    const w = new RS.World.World();
    w.resize(1280, 800);
    w.update(0.016, { now: 1, bands: { bass: 0.3, mid: 0.3, high: 0.3, level: 0.3 }, zen: false, climax: 0 });
    const rec = recordingCtx();
    w.drawRoad(rec.ctx, {
      now: 1, bands: { bass: 0.3, mid: 0.3, high: 0.3, level: 0.3 },
      beatLines: [], mode: 'rhythm', pressedLanes: [0, 0, 0, 0], showKeys: true,
    });
    const padStrokes = rec.calls.strokes.length - 5;
    assert(padStrokes === 4, 'rhythm road renders 4 pad columns (got ' + padStrokes + ')');
    assert(rec.calls.fillText.length === 4, 'rhythm road draws 4 key labels (got ' + rec.calls.fillText.length + ': ' + rec.calls.fillText.join('') + ')');
    assert(rec.calls.fillText.join('') === 'ASDF', 'labels are A S D F in order');
  }

  console.log('— climax pad heating —');
  {
    const w = new RS.World.World();
    w.resize(1280, 800);
    w.setSection('drop', 0);
    w.update(1.5, { now: 1, bands: { bass: 1, mid: 0.5, high: 0.5, level: 0.7 }, climax: 1 });
    assert(w.climax > 0.9, 'world climax lerps to 1 (got ' + w.climax.toFixed(2) + ')');
    const rec = recordingCtx();
    w.drawRoad(rec.ctx, {
      now: 1, bands: { bass: 1, mid: 0.5, high: 0.5, level: 0.7 },
      beatLines: [], mode: 'rhythm', pressedLanes: [0, 0, 0, 0], showKeys: true,
    });
    const dropLane = RS.util.hexToRgb(RS.World.THEMES.drop.lane); /* 254,137,61 */
    const hasWarm = rec.calls.strokes.some((s) => s && s.includes(dropLane.r + ',' + dropLane.g + ',' + dropLane.b));
    assert(hasWarm, 'pads heat toward the drop lane color at full climax (254,137,61)');
  }

  console.log('— zen idle road —');
  {
    const w = new RS.World.World();
    w.resize(1280, 800);
    w.update(0.016, { now: 1, bands: { bass: 0.2, mid: 0.2, high: 0.2, level: 0.2 }, zen: true, climax: 0 });
    const rec = recordingCtx();
    w.drawRoad(rec.ctx, {
      now: 1, bands: { bass: 0.2, mid: 0.2, high: 0.2, level: 0.2 },
      beatLines: [], mode: 'zen', pressedLanes: [0, 0, 0, 0], showKeys: false,
    });
    assert(rec.calls.fillText.length === 0, 'zen road draws no key labels');
    const padStrokes = rec.calls.strokes.length - 5;
    assert(padStrokes === 4, 'zen road renders 4 pad columns');
  }

  console.log('\n=== ' + passed + '/' + (passed + failed) + ' world checks passed' + (failed ? ', ' + failed + ' FAILED' : '') + ' ===');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

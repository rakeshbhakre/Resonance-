/* ============================================================
   RESONANCE — test/visual-check.js
   Objective pixel analysis of the screenshots captured by
   test/visual.js. Verifies color signatures per screen: dark
   theme, lane colors during play, drop-section warm palette,
   gold results accents, no blank frames.
   Run: after test/visual.js  (uses node-canvas via CANVAS_DIR)
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

let canvasLib;
for (const dir of [process.env.CANVAS_DIR || process.env.PUPPETEER_DIR, '/tmp/qa/node_modules', '/tmp/node_modules', '.'].filter(Boolean)) {
  try { canvasLib = require(path.join(dir, 'canvas')); break; } catch (e) { }
}
if (!canvasLib) { console.error('node-canvas not found — npm i canvas or set CANVAS_DIR'); process.exit(2); }

const SHOTS = path.join(__dirname, '..', 'shots');
let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ✓ ' + msg); } else { failed++; console.log('  ✗ ' + msg); } };

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0.0001) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return { h, s: mx === 0 ? 0 : d / mx, v: mx };
}

const BUCKETS = {
  cyan: [165, 205], blue: [205, 250], violet: [250, 295], pink: [295, 345],
  orange: [10, 45], gold: [45, 65], green: [95, 165], red: [345, 370],
};

async function analyze(file) {
  const img = await canvasLib.loadImage(path.join(SHOTS, file));
  const cv = canvasLib.createCanvas(img.width, img.height);
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const W = img.width, H = img.height;
  const data = ctx.getImageData(0, 0, W, H).data;
  const res = {
    w: W, h: H,
    dark: 0, bright: 0, meanLum: 0,
    hues: { cyan: 0, blue: 0, violet: 0, pink: 0, orange: 0, gold: 0, green: 0, red: 0 },
    colored: 0, total: 0,
    regions: [0, 0, 0].map(() => ({ colored: 0, total: 0, bright: 0 })),
  };
  for (let y = 0; y < H; y++) {
    const reg = Math.min(2, Math.floor((y / H) * 3));
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      res.meanLum += lum;
      res.total++; res.regions[reg].total++;
      if (lum < 40) res.dark++;
      if (lum > 200) { res.bright++; res.regions[reg].bright++; }
      const hsv = rgbToHsv(r, g, b);
      if (hsv.s > 0.25 && hsv.v > 0.25) {
        res.colored++; res.regions[reg].colored++;
        for (const k in BUCKETS) {
          let h = hsv.h;
          if (k === 'red' && h < 10) h += 360;
          if (h >= BUCKETS[k][0] && h < BUCKETS[k][1]) { res.hues[k]++; break; }
        }
      }
    }
  }
  const pc = (n) => (100 * n / res.total);
  res.meanLum /= res.total;
  res.pct = {
    dark: pc(res.dark), bright: pc(res.bright), colored: pc(res.colored),
    cyan: pc(res.hues.cyan), blue: pc(res.hues.blue), violet: pc(res.hues.violet),
    pink: pc(res.hues.pink), orange: pc(res.hues.orange), gold: pc(res.hues.gold),
    green: pc(res.hues.green), red: pc(res.hues.red),
  };
  res.regionPct = res.regions.map((r) => ({
    colored: 100 * r.colored / r.total, bright: 100 * r.bright / r.total,
  }));
  return res;
}

function fmt(a) {
  return `dark ${a.pct.dark.toFixed(0)}% · colored ${a.pct.colored.toFixed(1)}% ` +
    `[cyan ${a.pct.cyan.toFixed(2)} blue ${a.pct.blue.toFixed(2)} violet ${a.pct.violet.toFixed(2)} ` +
    `pink ${a.pct.pink.toFixed(2)} orange ${a.pct.orange.toFixed(2)} gold ${a.pct.gold.toFixed(2)}] ` +
    `reg-col ${a.regionPct.map((r) => r.colored.toFixed(1)).join('/')}`;
}

(async () => {
  const files = fs.readdirSync(SHOTS).filter((f) => f.endsWith('.png')).sort();
  ok(files.length >= 14, 'found ' + files.length + ' screenshots');

  for (const f of files) {
    const a = await analyze(f);
    console.log('— ' + f + ' (' + a.w + '×' + a.h + ') ' + fmt(a));
    const base = f.replace(/\.png$/, '');

    /* universal sanity */
    ok(a.meanLum < 90, base + ': dark theme overall (mean lum ' + a.meanLum.toFixed(0) + ')');
    ok(a.pct.bright < 40, base + ': not blown out');
    ok(a.pct.colored > 0.2, base + ': has color content');

    if (base === '01-home' || base === '11-home-again' || base === '14-mobile-home') {
      ok(a.pct.cyan + a.pct.blue > 0.15, base + ': brand cyan/blue present');
      ok(a.pct.violet + a.pct.pink > 0.05, base + ': gradient accents present');
    }
    if (/^0[4-7]-play/.test(base)) {
      ok(a.regionPct[2].colored > 15, base + ': road/pads rendered at bottom (' + a.regionPct[2].colored.toFixed(1) + '%)');
      ok(a.regionPct[0].colored > 0.5, base + ': sky glow/stars present (' + a.regionPct[0].colored.toFixed(1) + '%)');
      ok(a.pct.cyan > 0.05, base + ': lane cyan visible (' + a.pct.cyan.toFixed(2) + '%)');
    }
    if (base === '06-play-drop') {
      ok(a.pct.orange + a.pct.red > 0.05, base + ': drop section warm palette (' + (a.pct.orange + a.pct.red).toFixed(2) + '%)');
    }
    if (base === '05-play-build') {
      ok(a.pct.violet + a.pct.pink > 0.03, base + ': build section violet palette');
    }
    if (base === '08-results') {
      ok(a.pct.gold > 0.03, base + ': gold grade/stars visible (' + a.pct.gold.toFixed(2) + '%)');
      ok(a.regionPct[1].colored > 0.5, base + ': results content in middle band');
    }
    if (base === '10-flow') {
      ok(a.pct.cyan > 0.05, base + ': flow gates/road visible');
    }
    if (base === '15-mobile-play' || base === '16-mobile-touch') {
      ok(a.w < 500, base + ': portrait viewport');
      ok(a.pct.cyan > 0.02, base + ': gameplay colors on mobile');
    }
  }

  console.log('\n=== ' + passed + '/' + (passed + failed) + ' pixel checks passed' + (failed ? ', ' + failed + ' FAILED' : '') + ' ===');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

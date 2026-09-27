/* Debug: inspect AC landscape + phase for problem tracks */
'use strict';
const SR = 44100;
function kickBurst(out, off, vel) {
  for (let i = 0; i < 0.25 * SR && off + i < out.length; i++) {
    const t = i / SR;
    const f = 42 + 110 * Math.exp(-t * 38);
    out[off + i] += vel * Math.exp(-t * 16) * Math.sin(2 * Math.PI * f * t);
  }
}
function hatBurst(out, off, vel) {
  let prev = 0;
  for (let i = 0; i < 0.05 * SR && off + i < out.length; i++) {
    const t = i / SR;
    const n = Math.random() * 2 - 1;
    const lp = prev + 0.8 * (n - prev); prev = lp;
    out[off + i] += vel * 0.5 * Math.exp(-t * 90) * (n - lp);
  }
}
function makeTrack(bpm, bars, opts) {
  opts = opts || {};
  const T = 60 / bpm, dur = bars * 4 * T + 1;
  const out = new Float32Array(Math.ceil(dur * SR));
  const step = T / 4;
  for (let b = 0; b < bars * 4; b++) {
    const bt = 0.5 + b * T;
    kickBurst(out, Math.round(bt * SR), 0.9);
    if (opts.hats !== false) { hatBurst(out, Math.round((bt + T / 2) * SR), 0.6); hatBurst(out, Math.round((bt + T / 4) * SR), 0.3); }
    if (opts.snare && b % 2 === 1) hatBurst(out, Math.round(bt * SR), 0.8);
    for (let i = 0; i < T * SR; i++) out[Math.round(bt * SR) + i] += (Math.random() * 2 - 1) * 0.003;
  }
  return out;
}
/* replicate internal AC computation to print landscape */
async function main() {
  const A = require('../src/analyzer.js');
  for (const [name, bpm, bars, opts] of [['hiphop 88', 88, 12, { snare: true }], ['slow 72', 72, 10, {}], ['fast 174', 174, 24, { snare: true }]]) {
    const samples = makeTrack(bpm, bars, opts);
    const res = await A.analyze(samples, SR, {});
    const T = 60 / bpm;
    console.log(`\n== ${name}: detected bpm=${res.bpm} (true ${bpm}), beats=${res.beats.length}`);
    const b0 = res.beats.slice(0, 8).map((b) => {
      const rel = (b.time - 0.5) / T;
      return `${b.time.toFixed(3)}(e${((rel - Math.round(rel)) * T * 1000).toFixed(0)}ms,s${b.strength.toFixed(2)})`;
    });
    console.log('   first beats: ' + b0.join(' '));
    console.log('   sections: ' + res.sections.map((s) => `${s.type}@${s.start.toFixed(1)}-${s.end.toFixed(1)}`).join(' '));
  }
}
main().catch(console.error);

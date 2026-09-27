/* ============================================================
   RESONANCE — test/test-ui.js
   Full-stack browser simulation against the BUILT index.html:
   jsdom DOM + fake AudioContext + recording 2D context.
   Exercises: boot → home → demo analyze → start → countdown →
   playing → HUD → pause/resume → finish → results → replay.
   Run: NODE_PATH=/tmp/node_modules node test/test-ui.js
        (any dir containing jsdom works)
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ FAIL: ' + msg); }
}

/* ---------------- fake Web Audio ---------------- */
function makeFakeAudio() {
  const ac = {
    currentTime: 0, sampleRate: 44100, state: 'running',
    baseLatency: 0.008, outputLatency: 0.012,
    destination: { _n: 'dest' },
    createGain() {
      return { gain: param(), connect() { }, disconnect() { } };
    },
    createAnalyser() {
      return {
        fftSize: 0, frequencyBinCount: 128, smoothingTimeConstant: 0,
        getByteFrequencyData(arr) { for (let i = 0; i < arr.length; i++) arr[i] = 40 + (i % 7) * 18; },
        connect() { }, disconnect() { },
      };
    },
    createOscillator() {
      return { type: '', frequency: param(), connect() { }, start() { }, stop() { }, disconnect() { }, onended: null };
    },
    createBiquadFilter() {
      return { type: '', frequency: param(), Q: param(), connect() { }, disconnect() { } };
    },
    createBuffer(ch, len, sr) {
      return { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, _chans: [new Float32Array(len)], getChannelData() { return this._chans[0]; } };
    },
    createBufferSource() {
      const src = {
        buffer: null, onended: null,
        connect() { }, disconnect() { },
        start(t) { ac._started.push({ t, src }); },
        stop() { },
      };
      ac._sources.push(src);
      return src;
    },
    async resume() { this.state = 'running'; },
    async suspend() { this.state = 'suspended'; },
    async close() { },
    _sources: [], _started: [],
  };
  function param() {
    return { value: 0, setValueAtTime() { }, linearRampToValueAtTime() { }, exponentialRampToValueAtTime() { }, setTargetAtTime() { } };
  }
  return ac;
}

/* ---------------- recording 2D context ---------------- */
function makeFakeCtx() {
  const calls = { save: 0, fillRect: 0, arc: 0, fillText: 0, gradient: 0 };
  const gradient = { addColorStop() { } };
  return new Proxy({}, {
    get(t, prop) {
      if (prop === 'canvas') return { width: 1280, height: 720 };
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') {
        return () => { calls.gradient++; return gradient; };
      }
      if (prop === 'measureText') return () => ({ width: 10, actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 5 });
      if (prop === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (prop === 'isPointInPath') return () => false;
      if (typeof prop === 'string') {
        if (calls[prop] !== undefined) return (...a) => { calls[prop]++; };
        return () => { };
      }
      return undefined;
    },
    set() { return true; },
  });
}

/* ---------------- boot jsdom with the built file ---------------- */
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const fakeAC = makeFakeAudio();
const rafQueue = [];
let fakeCtx;

const { VirtualConsole } = require('jsdom');
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => console.log('  [page error]', e.message));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://resonance.local/',
  pretendToBeVisual: false,
  virtualConsole: vc,
  beforeParse(window) {
    window.AudioContext = function () { return fakeAC; };
    window.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
    window.cancelAnimationFrame = () => { };
    window.devicePixelRatio = 1;
    window.HTMLCanvasElement.prototype.getContext = function () { if (!fakeCtx) fakeCtx = makeFakeCtx(); return fakeCtx; };
    window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,FAKE';
    /* no Worker in jsdom → analyzer main-thread fallback path is exercised */
  },
});
const { window } = dom;
const { document } = window;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await sleep(25);
  }
  return false;
}
function pump(frames, dtSec) {
  for (let i = 0; i < frames; i++) {
    fakeAC.currentTime += dtSec;
    const q = rafQueue.splice(0, rafQueue.length);
    const ts = performance.now();
    q.forEach((cb) => cb(ts));
  }
}
const $ = (id) => document.getElementById(id);

(async function main() {
  console.log('— boot —');
  await waitFor(() => !!(window.App && window.App.engine), 5000); /* jsdom fires DOMContentLoaded on a later tick */
  assert(window.RS && window.RS.GameEngine, 'modules loaded onto window.RS');
  assert(window.App && window.UI, 'App & UI globals exist');
  assert(window.App.engine && window.App.engine.state === 'idle', 'engine booted idle');
  assert($('scr-home').classList.contains('active'), 'home screen active');
  const cards = document.querySelectorAll('.demo-card');
  assert(cards.length === 6, 'demo grid has 6 cards (got ' + cards.length + ')');
  assert(document.querySelectorAll('.mode-card').length === 4, 'mode picker has 4 modes');
  assert(document.querySelectorAll('#diff-picker button').length === 5, 'difficulty picker has 5 levels');

  console.log('— analyze demo track —');
  cards[0].click(); /* Neon Circuit */
  assert($('scr-analyze').classList.contains('active'), 'analyze screen shown');
  assert($('an-file').textContent.indexOf('Neon') >= 0, 'file label shows demo title');
  const analyzed = await waitFor(() => !$('btn-start').disabled, 30000, 'analysis');
  assert(analyzed, 'analysis completes (main-thread fallback)');
  assert($('an-stats').children.length === 6, 'six stat cells rendered');
  assert(parseInt($('an-bar').style.width) > 90, 'progress bar full');
  assert($('an-ribbon').children.length > 3, 'section ribbon rendered');
  assert($('an-stage').textContent.length > 0, 'stage label rendered');

  console.log('— start game —');
  $('btn-start').click();
  await waitFor(() => window.App.engine.state === 'countdown', 5000, 'countdown');
  assert(window.App.engine.state === 'countdown', 'engine in countdown');
  const lead = window.App.engine.leadTime();
  assert(lead > 1.5 && lead < 4, 'lead time sane (' + lead.toFixed(2) + 's)');
  assert(fakeAC._started.length === 1, 'audio source started');
  assert(Math.abs(fakeAC._started[0].t - (fakeAC.currentTime + lead)) < 0.01, 'audio scheduled at now+lead');
  assert($('hud').classList.contains('hidden') === false, 'HUD visible');
  assert(document.querySelector('.screen.active') === null, 'REGRESSION: no menu screen overlays the game after START');
  const trim = window.App.audio.trimGain;
  assert(trim && isFinite(trim.gain.value) && trim.gain.value >= 0.5 && trim.gain.value <= 3.2,
    'loudness trim active for the song (' + (trim ? trim.gain.value.toFixed(2) + '×' : 'missing') + ')');
  assert($('scr-analyze').classList.contains('active') === false, 'analyze screen hidden once playing');

  console.log('— play through countdown —');
  pump(Math.ceil(lead / (1 / 60)) + 10, 1 / 60);
  assert(window.App.engine.state === 'playing', 'engine playing after countdown (state=' + window.App.engine.state + ')');
  assert(document.querySelector('.screen.active') === null, 'still no overlay during play');
  /* input must reach the engine through the (now hidden) screen layer */
  window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }));
  assert(window.App.engine.pressedLanes[0] === true, 'lane input works with screens hidden');
  window.dispatchEvent(new window.KeyboardEvent('keyup', { code: 'KeyA', bubbles: true }));
  assert($('countdown').classList.contains('hidden') || $('count-num').textContent === 'GO', 'countdown done');

  console.log('— gameplay (bot) —');
  const e = window.App.engine;
  assert(e.song.timeline.events.length > 0, 'timeline loaded (' + e.song.timeline.events.length + ' events)');
  /* mini bot: press lane keys as events arrive (via real DOM key events) */
  const LANE_KEYS = ['KeyA', 'KeyS', 'KeyD', 'KeyF'];
  const evs = e.song.timeline.events.filter((ev) => ev.type === 'TAP' || ev.type === 'SPECIAL' || ev.type === 'HOLD');
  const done = new Set(), holding = new Set();
  function botStep() {
    const t = e.now;
    for (const ev of evs) {
      if (ev.time > t + 0.02) break;
      if (ev.type === 'HOLD') {
        if (!holding.has(ev.id) && !done.has(ev.id) && t >= ev.time - 0.01) {
          window.dispatchEvent(new window.KeyboardEvent('keydown', { code: LANE_KEYS[ev.lane], bubbles: true }));
          holding.add(ev.id);
        }
      } else if (!done.has(ev.id) && t >= ev.time - 0.01) {
        window.dispatchEvent(new window.KeyboardEvent('keydown', { code: LANE_KEYS[ev.lane], bubbles: true }));
        window.dispatchEvent(new window.KeyboardEvent('keyup', { code: LANE_KEYS[ev.lane], bubbles: true }));
        done.add(ev.id);
      }
    }
    for (const ev of Array.from(holding)) {
      if (t >= ev.time + (ev.dur || 0.2)) {
        window.dispatchEvent(new window.KeyboardEvent('keyup', { code: LANE_KEYS[ev.lane], bubbles: true }));
        holding.delete(ev.id); done.add(ev.id);
      }
    }
  }
  async function pumpBot(frames, dtSec) {
    for (let i = 0; i < frames; i++) {
      fakeAC.currentTime += dtSec;
      botStep();
      const q = rafQueue.splice(0, rafQueue.length);
      const ts = performance.now();
      q.forEach((cb) => cb(ts));
      if (i % 120 === 0) await sleep(0);
    }
  }
  await pumpBot(720, 1 / 60); /* 12s of bot play */
  assert(e.score.score > 0, 'bot scored points (' + e.score.score + ')');
  assert(e.score.judged > 10, 'events judged (' + e.score.judged + ')');
  assert($('hud-score-num').textContent !== '0', 'HUD score updating (' + $('hud-score-num').textContent + ')');
  assert(parseFloat($('progress-fill').style.width) > 0, 'progress bar moving');
  assert(fakeCtx, 'render context exercised');

  console.log('— pause / resume —');
  $('btn-pause').click();
  assert(e.state === 'paused', 'pause via button');
  assert($('pause').classList.contains('show'), 'pause overlay shown');
  assert($('pause-score').textContent.length > 0, 'pause stats filled');
  assert(/\d+:\d\d\s*\/\s*\d+:\d\d/.test($('pause-time').textContent), 'pause shows song time (' + $('pause-time').textContent + ')');
  assert(parseFloat($('pause-progress-fill').style.width) > 0, 'pause progress bar filled (' + $('pause-progress-fill').style.width + ')');
  $('btn-resume').click();
  assert(e.state === 'playing', 'resume works');
  window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
  assert(e.state === 'paused', 'Esc pauses');
  window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
  assert(e.state === 'playing', 'Esc resumes');

  console.log('— lane input —');
  window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyD', bubbles: true }));
  assert(e.pressedLanes[2] === true, 'key D presses lane 2');
  window.dispatchEvent(new window.KeyboardEvent('keyup', { code: 'KeyD', bubbles: true }));

  console.log('— finish —');
  const dur = e.song.analysis.duration;
  fakeAC.currentTime += (dur - e.now) + 3; /* jump song position past the end; clock snaps */
  /* pump frames (with bot still playing) until the engine finishes */
  let fin = false;
  for (let i = 0; i < 900 && !fin; i++) {
    fakeAC.currentTime += 1 / 60;
    botStep();
    const q = rafQueue.splice(0, rafQueue.length);
    q.forEach((cb) => cb(performance.now()));
    if (i % 180 === 0) await sleep(0);
    fin = e.state === 'finished';
  }
  assert(fin, 'engine finished');
  assert($('scr-results').classList.contains('active'), 'results screen shown');
  assert($('res-grade').textContent.length > 0, 'grade shown: ' + $('res-grade').textContent);
  assert(/\d/.test($('res-score').textContent), 'score shown: ' + $('res-score').textContent);
  assert($('res-grid').children.length === 9, 'results stat grid filled');
  assert(document.querySelectorAll('#res-stars .on').length >= 0, 'stars rendered');
  const stored = window.localStorage.getItem('resonance.best.' + window.App.lastResult.fingerprint + '.' + window.App.lastResult.mode + '.' + window.App.lastResult.difficulty);
  assert(!!stored, 'personal best stored');

  console.log('— replay —');
  $('btn-replay').click();
  const replayOk = await waitFor(() => e.state === 'countdown', 5000, 'replay countdown');
  assert(replayOk, 'replay restarts into countdown');
  pump(Math.ceil(e.leadTime() / (1 / 60)) + 10, 1 / 60);
  assert(e.state === 'playing', 'replay reaches playing');

  console.log('— quit to home —');
  window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
  $('btn-quit').click();
  assert(e.state === 'idle', 'quit returns engine to idle');
  assert($('scr-home').classList.contains('active'), 'home screen restored');
  assert($('hud').classList.contains('hidden'), 'HUD hidden after quit');

  console.log('— flow mode —');
  document.querySelectorAll('.mode-card')[1].click(); /* FLOW */
  assert(window.App.settings.mode === 'flow', 'mode setting updated');
  document.querySelectorAll('.demo-card')[3].click(); /* Voltage */
  await waitFor(() => !$('btn-start').disabled, 30000, 'flow analysis');
  $('btn-start').click();
  await waitFor(() => e.state === 'countdown', 5000, 'flow countdown');
  pump(Math.ceil(e.leadTime() / (1 / 60)) + 10, 1 / 60);
  assert(e.state === 'playing', 'flow mode playing');
  /* steer with pointer */
  const cv = $('cv');
  const rect = { left: 0, top: 0, width: 1280, height: 720 };
  cv.getBoundingClientRect = () => rect;
  cv.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 1100, clientY: 600, bubbles: true }));
  assert(e.flowTarget === 4, 'flow steering via pointer (target=' + e.flowTarget + ')');

  console.log('— settings persistence —');
  const vol = $('set-volume');
  vol.value = '40';
  vol.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert(Math.abs(window.App.settings.volume - 0.4) < 1e-9, 'volume slider applies');
  assert(!!window.localStorage.getItem('resonance.settings'), 'settings persisted');
  const saved = JSON.parse(window.localStorage.getItem('resonance.settings'));
  assert(saved.mode === 'flow' && saved.volume === 0.4, 'persisted values correct');

  console.log('— tap-test calibration —');
  $('btn-settings').click();
  $('btn-calibrate').click();
  assert(!!(window.App.tapTest && window.App.tapTest.active), 'tap test started');
  assert(window.App.tapTest.n === 8 && window.App.tapTest.interval > 0, 'beep grid scheduled (n=' + window.App.tapTest.n + ')');
  const tt = window.App.tapTest;
  /* tap 50ms late on every beep */
  for (let k = 0; k < 8; k++) {
    fakeAC.currentTime = tt.start + k * tt.interval + 0.05;
    window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  }
  assert(window.App.tapTest && window.App.tapTest.taps.length === 8, '8 taps captured (got ' + (window.App.tapTest ? window.App.tapTest.taps.length : 0) + ')');
  window.App.finishTapTest();
  const cal = window.App.settings.calibration;
  assert(Math.abs(cal - (-0.05)) < 0.021, 'calibration auto-set to ≈ −50ms (got ' + (cal * 1000).toFixed(0) + 'ms)');
  assert($('set-calib').value === '-50', 'latency slider synced (' + $('set-calib').value + 'ms)');
  assert((JSON.parse(window.localStorage.getItem('resonance.settings') || '{}').calibration * 1000).toFixed(0) === '-50', 'calibration persisted');
  $('btn-set-done').click();

  console.log('— help modal —');
  $('btn-help').click();
  assert($('modal-help').classList.contains('show'), 'help modal opens');
  $('btn-help-done').click();
  assert(!$('modal-help').classList.contains('show'), 'help modal closes');

  console.log('\n=== ' + passed + '/' + (passed + failed) + ' UI checks passed' + (failed ? ', ' + failed + ' FAILED' : '') + ' ===');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});

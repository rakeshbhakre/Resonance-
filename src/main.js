/* ============================================================
   RESONANCE — main.js
   Bootstrap · song pipeline (file/demo → analyze → generate) ·
   game loop · input · pause/settings persistence · results.
   Browser only. Requires: RS.* modules + UI (ui.js).
   ============================================================ */
(function () {
'use strict';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ============================================================
   SAFE STORAGE
   ============================================================ */
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  },
  set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ } }
};

/* ============================================================
   DEMOS
   ============================================================ */
const DEMO_GLYPHS = { neon: '⚡', hyperdrive: '➤', lofi: '☾', voltage: '★', boombap: '◒', deep: '◈' };

/* ============================================================
   APP STATE
   ============================================================ */
const App = {
  settings: null,
  engine: null,
  audio: null,
  canvas: null, ctx: null,
  current: null,        /* prepared song: {title, subtitle, buffer, analysis, meta, source, demoId, wavePeaks} */
  demoCache: {},        /* demoId -> prepared song */
  offsets: [],          /* timing chart data */
  raf: 0, lastTs: 0,
  idleT: 0,
  running: false,
  modeNames: { rhythm: 'Rhythm', flow: 'Flow', zen: 'Zen', chaos: 'Chaos' },
  gradeColors: { SS: '#ffd24a', S: '#8affc1', A: '#22d3ee', B: '#5b8cff', C: '#c084fc', D: '#8fa3c8' },
};
window.App = App; // debug handle

function defaultSettings() {
  let reduced = false;
  try { reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  return {
    mode: 'rhythm', diff: 0,
    volume: 0.85, sfx: true, calibration: 0,
    intensity: 1, reducedMotion: reduced, shapes: true, showKeys: true,
  };
}

/* ============================================================
   ANALYZER — worker with main-thread fallback
   ============================================================ */
const analyzerText = $('analyzer-src') ? $('analyzer-src').textContent : '';

function ensureMainAnalyzer() {
  if (window.RSAnalyzer) return;
  const s = document.createElement('script');
  s.textContent = analyzerText;
  document.head.appendChild(s);
}

function analyzeAudio(mono, sampleRate, onProg) {
  ensureMainAnalyzer();
  return new Promise((resolve) => {
    let worker = null;
    try {
      const glue = ';self.onmessage=function(e){var d=e.data;RSAnalyzer.analyze(d.samples,d.sampleRate,' +
        '{onProgress:function(p,s){postMessage({type:"progress",p:p,stage:s})}})' +
        '.then(function(res){postMessage({type:"done",res:res})},' +
        'function(err){postMessage({type:"error",message:String(err&&err.message||err)})})};';
      worker = new Worker(URL.createObjectURL(new Blob([analyzerText + glue], { type: 'text/javascript' })));
    } catch (e) { worker = null; }
    if (!worker) return fallback();

    let settled = false;
    const kill = () => { if (worker) { try { worker.terminate(); } catch (e) {} } };
    const timer = setTimeout(() => { if (!settled) { settled = true; kill(); fallback(); } }, 45000);

    worker.onmessage = (e) => {
      if (settled) return;
      const m = e.data;
      if (m.type === 'progress') onProg(m.p, m.stage);
      else if (m.type === 'done') { settled = true; clearTimeout(timer); kill(); resolve(m.res); }
      else { settled = true; clearTimeout(timer); kill(); fallback(); }
    };
    worker.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); kill(); fallback(); } };

    function fallback() {
      window.RSAnalyzer.analyze(mono, sampleRate, { onProgress: onProg })
        .then(resolve, (err) => { UI.toast('Analysis failed: ' + (err && err.message || err), true); resolve(null); });
    }
    /* send a copy — keep the original in case we must fall back after transfer */
    worker.postMessage({ samples: mono.slice(), sampleRate }, []);
  });
}

/* ============================================================
   SONG PIPELINE
   ============================================================ */
function mixToMono(audioBuffer) {
  const ch = audioBuffer.numberOfChannels, len = audioBuffer.length;
  const out = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const d = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += d[i] / ch;
  }
  return out;
}

async function prepare(buffer, meta, onProg) {
  /* buffer: AudioBuffer; meta: {title, subtitle, source, demoId} */
  const mono = buffer.numberOfChannels === 1 ? buffer.getChannelData(0).slice() : mixToMono(buffer);
  /* loudness estimate (skip first/last second) for per-song volume trim */
  let sum = 0, n = 0;
  const s0 = Math.min(mono.length, buffer.sampleRate);
  const s1 = Math.max(0, mono.length - buffer.sampleRate);
  for (let i = s0; i < s1; i += 7) { sum += mono[i] * mono[i]; n++; }
  const rms = Math.sqrt(sum / Math.max(1, n));
  onProg(0.02, 'decode');
  const analysis = await analyzeAudio(mono, buffer.sampleRate, (p, stage) => onProg(0.05 + p * 0.9, stage));
  if (!analysis) return null;
  onProg(0.97, 'energy');
  return Object.assign({ buffer, analysis, rms, wavePeaks: analysis.wavePeaks }, meta);
}

function generateTimeline(analysis) {
  const diffKeys = ['auto', 'easy', 'normal', 'hard', 'extreme'];
  const timeline = RS.Generator.generate(analysis, {
    mode: App.settings.mode,
    difficulty: diffKeys[App.settings.diff],
  });
  return timeline;
}

/* ---------- file input ---------- */
async function pickFile(file) {
  if (!file) return;
  if (file.size > 60 * 1024 * 1024) { UI.toast('File too large (60 MB max)', true); return; }
  const name = file.name.replace(/\.[^.]+$/, '');
  UI.beginAnalyze(name);
  try {
    App.audio.ensureCtx();
    const raw = await file.arrayBuffer();
    const buf = await App.audio.decode(raw);
    if (!buf || buf.duration < 8) { UI.toast('That file is too short or could not be decoded', true); App.goHome(); return null; }
    const song = await prepare(buf, {
      title: name, subtitle: 'Local file', source: 'file',
    }, (p, stage) => UI.analyzeProgress(p, stage));
    if (!song) { App.goHome(); return null; }
    return setReady(song);
  } catch (err) {
    console.error(err);
    UI.toast('Could not read that audio file', true);
    App.goHome();
    return null;
  }
}

/* ---------- demo input ---------- */
async function pickDemo(d) {
  const id = d.meta ? d.meta.id : d.id; /* catalog def or prepared */
  if (App.demoCache[id]) { UI.beginAnalyze(App.demoCache[id].title); setReady(App.demoCache[id]); return; }
  const def = RS.DemoSynth.catalog.find((c) => c.id === id) || d;
  UI.beginAnalyze(def.title);
  await new Promise((r) => setTimeout(r, 30)); /* let the screen paint */
  const rend = RS.DemoSynth.renderSong(def);
  App.audio.ensureCtx();
  const buffer = App.audio.bufferFromSamples(rend.samples, RS.DemoSynth.SR);
  const song = await prepare(buffer, {
    title: def.title, subtitle: 'Demo track · ' + def.style, source: 'demo', demoId: id,
  }, (p, stage) => UI.analyzeProgress(p, stage));
  if (!song) { App.goHome(); return; }
  App.demoCache[id] = song;
  setReady(song);
}

/* ---------- ready state ---------- */
function setReady(song) {
  App.current = song;
  const timeline = generateTimeline(song.analysis);
  song.timeline = timeline;
  const meta = {
    events: timeline.meta.eventCount,
    diffIndex: ['easy', 'normal', 'hard', 'extreme'].indexOf(timeline.meta.diffKey) + 1,
    diffName: timeline.meta.diffLabel,
    intensity: timeline.meta.estimated ? timeline.meta.estimated.score : 0.5,
  };
  UI.analyzeDone(song.analysis, meta);
  return song;
}

/* ============================================================
   GAME CONTROL
   ============================================================ */
async function startGame() {
  if (!App.current) return;
  const song = App.current;
  try {
    /* regenerate so mode/difficulty picks apply */
    const timeline = generateTimeline(song.analysis);
    const e = App.engine;
    App.offsets = [];
    e.load({ analysis: song.analysis, timeline, title: song.title, subtitle: song.subtitle });
    applySettings();

    try { await App.audio.unlock(); } catch (err) { /* ctx may still work */ }

    App.audio.stop();
    App.audio.setTrimForRms && App.audio.setTrimForRms(song.rms || 0.1);
    const lead = e.leadTime();
    App.audio.play(song.buffer, lead);
    e.start();

    /* THE GAME IS NOW LIVE — hide every menu screen so the world is
       visible and receives input (screens overlay the whole viewport). */
    UI.showScreen(null);

    UI.setHUDSong(song.title, App.modeNames[App.settings.mode] || App.settings.mode);
    UI.showHUD(true);
    UI.setCountdown(3);
    App.touchDevice = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    UI.showPulseButton(false);
  } catch (err) {
    console.error(err);
    UI.toast('Could not start: ' + (err && err.message || err), true);
    quitGame();
  }
}

function togglePause() {
  const e = App.engine;
  if (e.state === 'playing' || e.state === 'countdown') {
    e.pause();
    UI.pauseStats(e.hudState(), Math.max(0, e.now), e.song ? e.song.analysis.duration : 0);
    UI.showPause(true);
  } else if (e.state === 'paused') {
    UI.showPause(false);
    e.resume();
  }
}

function resumeGame() { if (App.engine.state === 'paused') { UI.showPause(false); App.engine.resume(); } }

function quitGame() {
  App.engine.quit();
  UI.showPause(false);
  UI.showHUD(false);
  UI.setCountdown(null);
  UI.showPulseButton(false);
  goHomeScreen();
}

function goHome() { quitGame(); }
function goHomeScreen() { UI.showScreen('scr-home'); }

function replay() {
  UI.showPause(false);
  startGame();
}

/* ============================================================
   RESULTS
   ============================================================ */
const DAY = 86400000;
function bestKey(res) { return 'resonance.best.' + res.fingerprint + '.' + res.mode + '.' + res.difficulty; }

function onFinish(res) {
  UI.showPause(false);
  UI.showHUD(false);
  UI.setCountdown(null);
  UI.showPulseButton(false);

  res.modeName = res.mode;
  res.diffName = res.difficulty;
  res.gradeColor = App.gradeColors[res.grade] || '#5b8cff';
  res.fullClear = res.counts.miss === 0 && res.judged > 0 && App.settings.mode !== 'zen';
  res.bonus = (res.orbs || 0) * 50 + (res.dodges || 0) * 30 + (res.peakHits || 0) * 500 + (res.holdTicks || 0) * 50;
  res.offsets = App.settings.mode === 'flow' ? [] : App.offsets;

  /* personal best */
  const key = bestKey(res);
  const prev = store.get(key, null);
  const isBest = !prev || res.score > prev.score;
  if (isBest && res.judged > 0) {
    store.set(key, { score: res.score, acc: res.accuracy, grade: res.grade, mode: res.modeName, date: Date.now() });
  }
  const all = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf('resonance.best.' + res.fingerprint + '.') === 0) {
        const v = store.get(k, null);
        if (v) all.push(Object.assign({ key: k }, v));
      }
    }
  } catch (e) {}
  all.sort((a, b) => b.score - a.score);
  const bests = all.slice(0, 5).map((b) => ({
    grade: b.grade, score: b.score, acc: b.acc, modeName: b.mode,
    date: new Date(b.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    me: b.key === key && isBest,
  }));

  /* calibration hint */
  let hint = '';
  const n = App.offsets.length;
  if (n >= 20 && Math.abs(res.avgOffsetMs) >= 22) {
    hint = res.avgOffsetMs > 0
      ? 'You tend to hit ' + Math.round(res.avgOffsetMs) + 'ms LATE — try increasing audio latency in settings.'
      : 'You tend to hit ' + Math.round(-res.avgOffsetMs) + 'ms EARLY — try decreasing audio latency in settings.';
  }

  App.lastResult = res;
  App.lastAnalysis = App.current;
  UI.showResults(res, bests, isBest && res.judged > 0, hint);
}

function shareResult() {
  if (!App.lastResult) return;
  try {
    const url = UI.renderShareCard(App.lastResult, App.current ? App.current.wavePeaks : null);
    UI.showShareCard(url);
  } catch (err) { UI.toast('Could not render the share card', true); }
}

/* ============================================================
   TAP-TEST CALIBRATION
   Beeps at a fixed grid; the user taps SPACE on each. The median
   tap offset becomes the audio-latency compensation automatically.
   ============================================================ */
App.startTapTest = function () {
  const a = App.audio;
  const ctx = a.ensureCtx();
  if (!ctx) { UI.toast('Audio is not available here', true); return; }
  if (a.unlock) a.unlock();
  const t0 = ctx.currentTime + 1.2;
  const N = 8, interval = 0.6;
  App.tapTest = { start: t0, interval, n: N, taps: [], active: true };
  for (let i = 0; i < N; i++) a.scheduleBeep(t0 + i * interval, i === N - 1 ? 1318 : 880);
  UI.toast('Tap test — press SPACE with each beep');
  UI.setCalibStatus('Listen… tap SPACE on each beep (8)');
  setTimeout(() => { if (App.tapTest) App.finishTapTest(); }, 1200 + N * 600 + 1200);
};

App.tapPress = function () {
  const tt = App.tapTest;
  if (!tt || !tt.active) return false;
  tt.taps.push(App.audio.ctx.currentTime);
  UI.setCalibStatus('Tap test — ' + tt.taps.length + '/' + tt.n + ' tapped');
  if (tt.taps.length >= tt.n + 2) App.finishTapTest();
  return true;
};

App.finishTapTest = function () {
  const tt = App.tapTest;
  if (!tt) return;
  tt.active = false;
  App.tapTest = null;
  const offs = [];
  for (const t of tt.taps) {
    const k = Math.round((t - tt.start) / tt.interval);
    if (k >= 0 && k < tt.n) offs.push(t - (tt.start + k * tt.interval));
  }
  if (offs.length < 4) {
    UI.setCalibStatus('');
    UI.toast('Not enough clean taps — try again', true);
    return;
  }
  offs.sort((a, b) => a - b);
  const med = offs[Math.floor(offs.length / 2)];
  const ms = Math.round(med * 1000);
  if (Math.abs(med) < 0.008) {
    UI.setCalibStatus('Perfect timing — no adjustment needed');
    UI.toast('Your timing is already spot on');
    return;
  }
  App.settings.calibration = clamp(App.settings.calibration - med, -0.25, 0.25);
  applySettings();
  UI.setCalibStatus('Calibrated (' + (ms > 0 ? '+' : '') + ms + 'ms ' + (med > 0 ? 'late' : 'early') + ' → latency ' + Math.round(App.settings.calibration * 1000) + 'ms)');
  UI.toast('Calibrated: ' + Math.abs(ms) + 'ms ' + (med > 0 ? 'late' : 'early') + ' compensated');
  UI.syncCalibUI && UI.syncCalibUI();
};

/* ============================================================
   SETTINGS
   ============================================================ */
App.saveSettings = function () { store.set('resonance.settings', App.settings); };

function applySettings() {
  const s = App.settings, e = App.engine, a = App.audio;
  a.setVolume(s.volume);
  a.setSfx(s.sfx);
  e.calibration = s.calibration;
  e.settings.visualIntensity = s.intensity;
  e.settings.reducedMotion = s.reducedMotion;
  e.settings.colorShapes = s.shapes;
  e.settings.showKeys = s.showKeys;
  document.body.classList.toggle('reduced-motion', s.reducedMotion);
  store.set('resonance.settings', s); /* persist every change */
}
App.applySettings = applySettings;

/* ============================================================
   ENGINE HOOKS
   ============================================================ */
function buildEngine() {
  App.audio = new RS.AudioEngine();
  App.engine = new RS.GameEngine({
    onHUD: (st) => { if (st.state === 'playing') UI.updateHUD(st); },
    onSection: (sec) => {
      if (!sec) return;
      const th = RS.World.THEMES && RS.World.THEMES[sec.type];
      UI.flashSection(sec.type, th ? th.accent : '#c084fc');
    },
    onCountdown: (n) => {
      if (n > 0) UI.setCountdown(n);
      else {
        UI.setCountdown('GO');
        setTimeout(() => UI.setCountdown(null), 650);
        if (App.touchDevice && App.settings.mode !== 'flow') {
          const hasPeaks = App.current && App.current.timeline &&
            App.current.timeline.events.some((ev) => ev.type === 'PEAK');
          UI.showPulseButton(hasPeaks);
        }
      }
    },
    onJudge: (res, ev) => {
      if (res && res.peakIncoming) { UI.showPulseButton(App.touchDevice && App.settings.mode !== 'flow'); return; }
      if (res && typeof res.off === 'number' && res.grade !== 'miss' && res.grade !== 'pass' && App.settings.mode !== 'flow') {
        App.offsets.push({ t: App.engine.now, off: res.off });
      }
    },
    onFinish,
  });
  App.engine.setAudio(App.audio);
}

/* ============================================================
   RENDER LOOP
   ============================================================ */
function loop(ts) {
  App.raf = requestAnimationFrame(loop);
  const dt = App.lastTs ? Math.min(0.05, (ts - App.lastTs) / 1000) : 0.016;
  App.lastTs = ts;
  const e = App.engine;
  if (e.state === 'idle' || e.state === 'finished') { idleFrame(dt); return; }
  const wasFrozen = App.audio._frozen;
  App.audio.tickWatchdog(dt); /* survive autoplay-blocked audio contexts */
  if (!wasFrozen && App.audio._frozen) {
    UI.toast('Audio is blocked here — playing silently', true);
  }
  const now = e.clock.update();
  e.update(now, dt);
  e.render();
}

let idleBands = { bass: 0, mid: 0, high: 0, level: 0 };
function idleFrame(dt) {
  const w = App.engine.world;
  App.idleT += dt;
  const t = App.idleT;
  idleBands.bass = 0.22 + 0.14 * Math.sin(t * 0.6);
  idleBands.mid = 0.18 + 0.1 * Math.sin(t * 0.83 + 2.1);
  idleBands.high = 0.12 + 0.07 * Math.sin(t * 1.21 + 4.2);
  idleBands.level = 0.2 + 0.1 * Math.sin(t * 0.45);
  w.update(dt, { now: t, bands: idleBands, zen: true, climax: 0, beat: null });
  w.drawBackground(App.ctx, { now: t, bands: idleBands });
  w.drawRoad(App.ctx, { now: t, bands: idleBands, beatLines: [], mode: 'zen', pressedLanes: [0, 0, 0, 0], showKeys: false });
}

/* ============================================================
   INPUT
   ============================================================ */
const KEY_LANES = { KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, ArrowLeft: 0, ArrowDown: 1, ArrowUp: 2, ArrowRight: 3 };
const GAME_KEYS = { KeyA: 1, KeyS: 1, KeyD: 1, KeyF: 1, ArrowLeft: 1, ArrowDown: 1, ArrowUp: 1, ArrowRight: 1, Space: 1 };

function bindInput() {
  window.addEventListener('keydown', (e) => {
    if (e.repeat && e.code !== 'Space') return;
    if (e.code === 'Escape') {
      /* close real modals first (settings may be open on top of pause) */
      let closed = false;
      ['modal-settings', 'modal-help', 'modal-share'].forEach((id) => {
        const m = document.getElementById(id);
        if (m.classList.contains('show')) { UI.closeModal(id); closed = true; }
      });
      if (closed) return;
      if (App.engine.state === 'playing' || App.engine.state === 'countdown' || App.engine.state === 'paused') togglePause();
      return;
    }
    if (!GAME_KEYS[e.code]) return;
    if (e.code === 'Space' && App.tapTest && App.tapTest.active) {
      e.preventDefault();
      App.tapPress();
      return;
    }
    const st = App.engine.state;
    if (st !== 'playing' && st !== 'countdown') {
      if (e.code === 'Space' && st === 'idle' && !UI.anyModalOpen()) {
        /* space on home = quick-start last song */
        if (App.current) { e.preventDefault(); startGame(); }
      }
      return;
    }
    e.preventDefault();
    if (e.code === 'Space') App.engine.pressSpace();
    else App.engine.pressLane(KEY_LANES[e.code]);
  });
  window.addEventListener('keyup', (e) => {
    if (!GAME_KEYS[e.code]) return;
    if (e.code === 'Space') App.engine.releaseSpace ? App.engine.releaseSpace() : null;
    else App.engine.releaseLane(KEY_LANES[e.code]);
  });

  /* pointer / touch on canvas */
  const cv = App.canvas;
  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (App.engine.state !== 'playing') return;
    const r = cv.getBoundingClientRect();
    App.engine.pointerDown(e.clientX - r.left, e.clientY - r.top);
  });
  cv.addEventListener('pointermove', (e) => {
    if (App.engine.state !== 'playing') return;
    if (App.settings.mode === 'flow') {
      const r = cv.getBoundingClientRect();
      App.engine.pointerMove(e.clientX - r.left, e.clientY - r.top);
    }
  });

  /* auto-pause when tab hidden */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && (App.engine.state === 'playing' || App.engine.state === 'countdown')) {
      togglePause();
    }
  });
  window.addEventListener('blur', () => {
    if (App.engine.state === 'playing' || App.engine.state === 'countdown') togglePause();
  });

  /* drag & drop */
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; UI.showDrop(true); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; UI.showDrop(false); } });
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; UI.showDrop(false);
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) pickFile(f);
  });
}

/* ============================================================
   RESIZE
   ============================================================ */
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  App.canvas.width = Math.round(w * dpr);
  App.canvas.height = Math.round(h * dpr);
  App.canvas.style.width = w + 'px';
  App.canvas.style.height = h + 'px';
  App.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (App.engine) App.engine.resize(w, h);
}

/* ============================================================
   APP PUBLIC (UI callbacks)
   ============================================================ */
App.demos = [];
App.pickDemo = pickDemo;
App.pickFile = pickFile;
App.startGame = startGame;
App.replay = replay;
App.goHome = goHome;
App.quitGame = quitGame;
App.resumeGame = resumeGame;
App.togglePause = togglePause;
App.shareResult = shareResult;
App.pulsePress = () => App.engine.pressSpace();
App.pulseRelease = () => { if (App.engine.releaseSpace) App.engine.releaseSpace(); };

/* ============================================================
   BOOT
   ============================================================ */
function boot() {
  App.canvas = $('cv');
  App.ctx = App.canvas.getContext('2d', { alpha: false });
  App.settings = Object.assign(defaultSettings(), store.get('resonance.settings', {}));

  buildEngine();
  App.engine.setCanvas(App.ctx); /* THE GAME RENDERS THROUGH THIS — never forget to wire it */
  onResize();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 250));

  /* demo cards for the UI */
  App.demos = RS.DemoSynth.catalog.map((d) => ({
    id: d.id, title: d.title, style: d.style, bpm: d.bpm,
    color: d.color || '#5b8cff', glyph: DEMO_GLYPHS[d.id] || '♪',
  }));

  UI.init(App);
  applySettings();
  bindInput();
  App.raf = requestAnimationFrame(loop);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();

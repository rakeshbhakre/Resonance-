/* ============================================================
   RESONANCE — ui.js
   Screen manager · home · analyze progress · HUD · results ·
   settings · toasts · share card. Talks to main.js via app.
   Browser only.
   ============================================================ */
(function () {
'use strict';

/* ---------- tiny DOM helpers ---------- */
const $ = (id) => document.getElementById(id);
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

const UI = {
  app: null,            // injected by main.js
  screens: {},
  modes: [
    { id: 'rhythm', name: 'RHYTHM', desc: '4 lanes · notes on beats & melodies' },
    { id: 'flow',   name: 'FLOW',   desc: 'steer a ship through gates & walls' },
    { id: 'zen',    name: 'ZEN',    desc: 'no fail · no combo · just vibe' },
    { id: 'chaos',  name: 'CHAOS',  desc: 'everything, everywhere, at once' },
  ],
  diffs: ['AUTO', 'EASY', 'NORMAL', 'HARD', 'EXTREME'],
  diffColors: ['#8fa3c8', '#8affc1', '#5b8cff', '#ff5ec4', '#ff4d6a'],
  sectionColors: {
    intro: '#3b4a6b', verse: '#2f5d8a', build: '#7a4fa8', chorus: '#b0468a',
    drop: '#ff5e3a', break: '#28486b', outro: '#3b4a6b',
  },
};

/* ============================================================
   SCREENS
   ============================================================ */
function showScreen(name) {
  for (const k in UI.screens) UI.screens[k].classList.toggle('active', k === name);
}
UI.showScreen = showScreen;

/* ============================================================
   HOME
   ============================================================ */
function buildHome() {
  const grid = $('demo-grid');
  grid.innerHTML = '';
  UI.app.demos.forEach((d) => {
    const card = el('div', 'demo-card');
    card.style.setProperty('--card-c', d.color);
    card.innerHTML =
      '<div class="dc-glyph">' + d.glyph + '</div>' +
      '<div class="dc-title">' + d.title + '</div>' +
      '<div class="dc-meta">' + d.bpm + ' BPM · ' + d.style + '</div>';
    card.addEventListener('click', () => UI.app.pickDemo(d));
    grid.appendChild(card);
  });

  const mp = $('mode-picker');
  mp.innerHTML = '';
  UI.modes.forEach((m) => {
    const card = el('div', 'mode-card' + (m.id === UI.app.settings.mode ? ' sel' : ''));
    card.innerHTML = '<div class="mc-name">' + m.name + '</div><div class="mc-desc">' + m.desc + '</div>';
    card.addEventListener('click', () => {
      UI.app.settings.mode = m.id;
      UI.app.saveSettings();
      Array.prototype.forEach.call(mp.children, (c) => c.classList.remove('sel'));
      card.classList.add('sel');
    });
    mp.appendChild(card);
  });

  const dp = $('diff-picker');
  dp.innerHTML = '';
  UI.diffs.forEach((d, i) => {
    const b = el('button', UI.app.settings.diff === i ? 'sel' : '');
    b.textContent = d;
    if (i >= 3) b.style.color = UI.diffColors[i];
    b.addEventListener('click', () => {
      UI.app.settings.diff = i;
      UI.app.saveSettings();
      Array.prototype.forEach.call(dp.children, (c) => c.classList.remove('sel'));
      b.classList.add('sel');
    });
    dp.appendChild(b);
  });

  $('btn-upload').addEventListener('click', () => $('file-input').click());
  $('btn-help').addEventListener('click', () => openModal('modal-help'));
  $('btn-help-done').addEventListener('click', () => closeModal('modal-help'));
  $('btn-settings').addEventListener('click', () => openSettings());
  $('btn-set-done').addEventListener('click', () => closeModal('modal-settings'));
}

/* ============================================================
   ANALYZE SCREEN
   ============================================================ */
UI.beginAnalyze = function (fileName) {
  showScreen('scr-analyze');
  $('an-file').textContent = fileName;
  $('an-bar').style.width = '0%';
  $('an-stage').textContent = 'DECODING AUDIO';
  $('an-wave').getContext('2d').clearRect(0, 0, 560, 84);
  $('an-stats').innerHTML = '';
  $('an-ribbon').innerHTML = '';
  $('an-note').textContent = '';
  setStartEnabled(false);
};

UI.analyzeProgress = function (p, stage) {
  $('an-bar').style.width = (p * 100).toFixed(1) + '%';
  if (stage) $('an-stage').textContent = String(stage).toUpperCase();
};

UI.analyzeDone = function (res, meta) {
  UI.analyzeProgress(1, 'READY');
  $('an-stage').textContent = 'READY TO PLAY';
  drawWave(res.wavePeaks, meta.intensity);
  const stats = [
    [Math.round(res.bpm) + '<small style="font-size:11px;color:var(--dim)"> BPM</small>', 'TEMPO'],
    [Math.floor(res.duration / 60) + ':' + ('0' + Math.round(res.duration % 60)).slice(-2), 'LENGTH'],
    [res.sections.length, 'SECTIONS'],
    [meta.events, 'EVENTS'],
    ['<span style="color:' + UI.diffColors[meta.diffIndex] + '">' + meta.diffName + '</span>', 'DIFFICULTY'],
    ['<div class="intensity-meter"><i style="width:' + Math.round(meta.intensity * 100) + '%"></i></div>', 'INTENSITY'],
  ];
  const box = $('an-stats');
  box.innerHTML = '';
  stats.forEach((s) => {
    box.appendChild(el('div', 'stat', '<div class="st-v">' + s[0] + '</div><div class="st-l">' + s[1] + '</div>'));
  });
  const rb = $('an-ribbon');
  rb.innerHTML = '';
  res.sections.forEach((sec) => {
    const b = el('div', 'sec-block');
    const w = Math.max(2, ((sec.end - sec.start) / res.duration) * 100);
    b.style.width = w + '%';
    b.style.background = UI.sectionColors[sec.type] || '#3b4a6b';
    if (sec.end - sec.start > 12) b.innerHTML = '<span>' + sec.type.toUpperCase() + '</span>';
    rb.appendChild(b);
  });
  $('an-note').textContent = 'Every game is generated from the actual audio — same song, same beats, every time.';
  setStartEnabled(true);
};

function setStartEnabled(on) {
  $('btn-start').disabled = !on;
  if (on && $('btn-start').scrollIntoView) {
    try { $('btn-start').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { }
  }
}

function drawWave(peaks, intensity) {
  const cv = $('an-wave'), ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, mid = H / 2, n = peaks.length;
  ctx.clearRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#22d3ee'); grad.addColorStop(0.5, '#5b8cff'); grad.addColorStop(1, '#c084fc');
  ctx.fillStyle = grad;
  const active = Math.max(Math.floor(n * 0.8), 16); // first 80% or 16 bars while analyzing
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * W;
    const h = Math.max(1, peaks[i] * (H * 0.46));
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x - 0.8, mid - h, 1.8, h * 2);
  }
  ctx.globalAlpha = 1;
}

/* ============================================================
   HUD
   ============================================================ */
UI.showHUD = function (on) { $('hud').classList.toggle('hidden', !on); };
UI.showPulseButton = function (on) { $('btn-pulse').classList.toggle('visible', on); };

UI.setCountdown = function (txt) {
  const wrap = $('countdown'), num = $('count-num');
  if (txt === null) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  num.textContent = txt;
  num.style.animation = 'none';
  void num.offsetWidth; // restart animation
  num.style.animation = '';
};

let lastCombo = -1;
UI.updateHUD = function (s) {
  $('hud-score-num').textContent = s.score.toLocaleString();
  $('hud-acc').textContent = s.accuracy.toFixed(1) + '%';
  $('hud-mult').textContent = 'MULT ×' + s.mult;
  if (s.combo !== lastCombo) {
    const c = $('hud-combo');
    c.textContent = '×' + s.combo;
    c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop');
    lastCombo = s.combo;
  }
  $('progress-fill').style.width = (s.progress * 100).toFixed(1) + '%';
  if (typeof s.flow === 'number') UI.updateFlow(s.flow);
  if (s.adaptive) UI.setAdaptiveLabel(s.adaptive);
};

UI.setHUDSong = function (name, modeName) { $('hud-song').textContent = name + ' · ' + modeName; };

let sectionTimer = null;
UI.flashSection = function (kind, color) {
  const lab = $('hud-section'), ann = $('section-announce');
  lab.textContent = kind.toUpperCase();
  lab.classList.add('show');
  ann.textContent = kind.toUpperCase();
  ann.style.setProperty('--sc', color || 'rgba(192,132,252,.9)');
  ann.classList.remove('show'); void ann.offsetWidth; ann.classList.add('show');
  clearTimeout(sectionTimer);
  sectionTimer = setTimeout(() => lab.classList.remove('show'), 4000);
};

UI.updateFlow = function (flow) {
  $('hud-flow-fill').style.width = Math.round(flow) + '%';
};

UI.setAdaptiveLabel = function (state) {
  const e = $('hud-adaptive');
  e.textContent = state === 'assist' ? 'ADAPTIVE · ASSIST' : state === 'excite' ? 'ADAPTIVE · EXCITE' : 'ADAPTIVE';
  e.classList.toggle('on', state !== 'baseline');
};

UI.pauseStats = function (s, now, duration) {
  $('pause-score').textContent = s.score.toLocaleString();
  $('pause-combo').textContent = '×' + s.combo;
  $('pause-acc').textContent = s.accuracy.toFixed(1) + '%';
  if (duration) {
    const fmt = (t) => Math.floor(t / 60) + ':' + ('0' + Math.floor(Math.max(0, t) % 60)).slice(-2);
    $('pause-time').textContent = fmt(now) + ' / ' + fmt(duration);
    $('pause-progress-fill').style.width = Math.min(100, (now / duration) * 100).toFixed(1) + '%';
  }
};

/* ---------- tap-test calibration UI ---------- */
UI.setCalibStatus = function (txt) {
  const el = $('set-calib-status');
  if (el) el.textContent = txt;
};
UI.syncCalibUI = function () {
  const s = UI.app.settings;
  $('set-calib').value = Math.round(s.calibration * 1000);
  $('set-calib-v').textContent = Math.round(s.calibration * 1000) + ' ms';
};

/* ============================================================
   RESULTS
   ============================================================ */
UI.showResults = function (res, bests, isBest, calibHint) {
  showScreen('scr-results');
  $('res-head').textContent = res.fullClear ? 'FULL COMBO!' : res.failed ? 'TRACK ENDED' : 'TRACK COMPLETE';
  $('res-song').textContent = res.songTitle;
  $('res-sub').textContent = res.modeName.toUpperCase() + ' · ' + res.diffName + (res.fullClear ? ' · ★ FULL COMBO ★' : '');
  const g = $('res-grade');
  g.textContent = res.grade;
  g.style.setProperty('--gc', res.gradeColor);
  $('res-stars').innerHTML =
    '<span class="' + (res.stars >= 1 ? 'on' : '') + '">★</span><span class="' + (res.stars >= 2 ? 'on' : '') +
    '">★</span><span class="' + (res.stars >= 3 ? 'on' : '') + '">★</span><span class="' + (res.stars >= 4 ? 'on' : '') +
    '">★</span><span class="' + (res.stars >= 5 ? 'on' : '') + '">★</span>';
  $('res-score').textContent = res.score.toLocaleString();
  $('res-best-badge').style.display = isBest ? 'inline-block' : 'none';
  const cells = [
    [res.accuracy.toFixed(1) + '%', 'ACCURACY'],
    ['×' + res.maxCombo, 'MAX COMBO'],
    [res.counts.perfect, 'PERFECT'],
    [res.counts.great, 'GREAT'],
    [res.counts.good, 'GOOD'],
    [res.counts.miss, 'MISS'],
    [(res.avgOffsetMs >= 0 ? '+' : '') + res.avgOffsetMs.toFixed(1) + 'ms', 'AVG TIMING'],
    [res.peaksHit + '/' + res.peaksTotal, 'PEAKS'],
    ['+' + res.bonus, 'BONUSES'],
  ];
  const grid = $('res-grid');
  grid.innerHTML = '';
  cells.forEach((c) => grid.appendChild(el('div', 'stat', '<div class="st-v">' + c[0] + '</div><div class="st-l">' + c[1] + '</div>')));
  drawTimingChart(res.offsets, res.duration);
  $('res-calib-hint').textContent = calibHint || '';
  const bb = $('res-bests');
  bb.innerHTML = '';
  if (bests && bests.length) {
    bb.appendChild(el('h4', '', 'PERSONAL BESTS — THIS TRACK'));
    bests.forEach((b) => {
      bb.appendChild(el('div', 'best-row' + (b.me ? ' me' : ''),
        '<span><b>' + b.grade + '</b> · ' + b.score.toLocaleString() + ' <span class="br-l">(' + b.acc.toFixed(1) + '% ' + b.modeName + ')</span></span>' +
        '<span class="br-l">' + b.date + '</span>'));
    });
  }
};

function drawTimingChart(offsets, duration) {
  const cv = $('res-timing'), ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, mid = H / 2;
  ctx.clearRect(0, 0, W, H);
  // perfect window band (±50ms)
  const scale = H / 2 / 160; // ±160ms full scale
  ctx.fillStyle = 'rgba(138, 255, 193, 0.10)';
  ctx.fillRect(0, mid - 50 * scale, W, 100 * scale);
  ctx.strokeStyle = 'rgba(120,160,255,.25)';
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();
  if (!offsets || !offsets.length) {
    ctx.fillStyle = 'rgba(143,163,200,.6)';
    ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('NO TIMING DATA (ZEN MODE)', W / 2, mid);
    return;
  }
  offsets.forEach((o) => {
    const x = (o.t / duration) * W;
    const y = mid + Math.max(-155, Math.min(155, o.off * 1000)) * scale;
    ctx.fillStyle = Math.abs(o.off * 1000) < 0.05 ? 'rgba(138,255,193,.8)' : Math.abs(o.off * 1000) < 0.1 ? 'rgba(91,140,255,.7)' : 'rgba(255,77,106,.7)';
    ctx.fillRect(x - 1, y - 1, 2.4, 2.4);
  });
  // moving average line
  ctx.strokeStyle = 'rgba(255,210,74,.85)'; ctx.lineWidth = 1.6;
  ctx.beginPath();
  const win = Math.max(4, Math.floor(offsets.length / 24));
  let sum = 0;
  for (let i = 0; i < offsets.length; i++) {
    sum += offsets[i].off;
    if (i >= win) sum -= offsets[i - win].off;
    const avg = sum / Math.min(i + 1, win);
    const x = (offsets[i].t / duration) * W;
    const y = mid + Math.max(-155, Math.min(155, avg * 1000)) * scale;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke(); ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(143,163,200,.55)';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'left'; ctx.fillText('EARLY −', 6, 12);
  ctx.textAlign = 'right'; ctx.fillText('+ LATE', W - 6, 12);
}

/* ============================================================
   MODALS / PAUSE
   ============================================================ */
function openModal(id) { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }
UI.openModal = openModal; UI.closeModal = closeModal;
UI.anyModalOpen = function () {
  return Array.prototype.some.call(document.querySelectorAll('.overlay'), (o) => o.classList.contains('show'));
};

UI.showPause = function (on) { $('pause').classList.toggle('show', on); };

function openSettings() {
  const s = UI.app.settings;
  $('set-volume').value = Math.round(s.volume * 100);
  $('set-sfx').classList.toggle('on', s.sfx);
  $('set-calib').value = Math.round(s.calibration * 1000);
  $('set-calib-v').textContent = Math.round(s.calibration * 1000) + ' ms';
  Array.prototype.forEach.call($('set-intensity').children, (b) =>
    b.classList.toggle('sel', parseFloat(b.dataset.v) === s.intensity));
  $('set-reduced').classList.toggle('on', s.reducedMotion);
  $('set-shapes').classList.toggle('on', s.shapes);
  $('set-keys').classList.toggle('on', s.showKeys);
  openModal('modal-settings');
}
UI.openSettings = openSettings;

function bindSettings() {
  $('set-volume').addEventListener('input', (e) => {
    UI.app.settings.volume = e.target.value / 100; UI.app.applySettings();
  });
  $('set-sfx').addEventListener('click', (e) => {
    UI.app.settings.sfx = !UI.app.settings.sfx;
    e.target.classList.toggle('on', UI.app.settings.sfx);
    UI.app.applySettings();
  });
  $('set-calib').addEventListener('input', (e) => {
    UI.app.settings.calibration = e.target.value / 1000;
    $('set-calib-v').textContent = e.target.value + ' ms';
    UI.setCalibStatus('');
    UI.app.applySettings();
  });
  $('btn-calibrate').addEventListener('click', () => UI.app.startTapTest());
  Array.prototype.forEach.call($('set-intensity').children, (b) => {
    b.addEventListener('click', () => {
      UI.app.settings.intensity = parseFloat(b.dataset.v);
      Array.prototype.forEach.call($('set-intensity').children, (x) => x.classList.remove('sel'));
      b.classList.add('sel');
      UI.app.applySettings();
    });
  });
  $('set-reduced').addEventListener('click', (e) => {
    UI.app.settings.reducedMotion = !UI.app.settings.reducedMotion;
    e.target.classList.toggle('on', UI.app.settings.reducedMotion);
    UI.app.applySettings();
  });
  $('set-shapes').addEventListener('click', (e) => {
    UI.app.settings.shapes = !UI.app.settings.shapes;
    e.target.classList.toggle('on', UI.app.settings.shapes);
    UI.app.applySettings();
  });
  $('set-keys').addEventListener('click', (e) => {
    UI.app.settings.showKeys = !UI.app.settings.showKeys;
    e.target.classList.toggle('on', UI.app.settings.showKeys);
    UI.app.applySettings();
  });
}

/* ============================================================
   TOASTS
   ============================================================ */
UI.toast = function (msg, isErr) {
  const t = el('div', 'toast' + (isErr ? ' err' : ''), msg);
  $('toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, 3200);
  setTimeout(() => t.remove(), 3700);
};

/* ============================================================
   DROP OVERLAY
   ============================================================ */
UI.showDrop = function (on) { $('drop-overlay').classList.toggle('hidden', !on); };

/* ============================================================
   SHARE CARD
   ============================================================ */
UI.showShareCard = function (dataUrl) {
  $('share-img').src = dataUrl;
  $('share-dl').href = dataUrl;
  openModal('modal-share');
};

UI.renderShareCard = function (res, wavePeaks) {
  const S = 900;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S * 0.5625 || 506; // 16:9-ish card
  cv.height = 506;
  const ctx = cv.getContext('2d');
  // background
  const bg = ctx.createLinearGradient(0, 0, S, 506);
  bg.addColorStop(0, '#070a18'); bg.addColorStop(0.5, '#0b1230'); bg.addColorStop(1, '#160a26');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, S, 506);
  // ambient orbs
  const orbs = [[140, 90, 180, '34,211,238'], [760, 420, 220, '192,132,252'], [520, 60, 140, '91,140,255']];
  orbs.forEach((o) => {
    const g = ctx.createRadialGradient(o[0], o[1], 0, o[0], o[1], o[2]);
    g.addColorStop(0, 'rgba(' + o[3] + ',.28)'); g.addColorStop(1, 'rgba(' + o[3] + ',0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(o[0], o[1], o[2], 0, 7); ctx.fill();
  });
  // header
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8fa3c8';
  ctx.font = '600 17px "Segoe UI", sans-serif';
  ctx.fillText('R E S O N A N C E', S / 2, 52);
  ctx.fillStyle = '#e8f0ff';
  ctx.font = '800 30px "Segoe UI", sans-serif';
  let title = res.songTitle.length > 34 ? res.songTitle.slice(0, 33) + '…' : res.songTitle;
  ctx.fillText(title, S / 2, 96);
  ctx.fillStyle = '#8fa3c8';
  ctx.font = '600 14px "Segoe UI", sans-serif';
  ctx.fillText(res.modeName.toUpperCase() + ' · ' + res.diffName.toUpperCase(), S / 2, 124);
  // grade + stars
  ctx.save();
  ctx.shadowColor = res.gradeColor; ctx.shadowBlur = 42;
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 120px "Segoe UI", sans-serif';
  ctx.fillText(res.grade, S / 2, 262);
  ctx.restore();
  ctx.fillStyle = '#ffd24a';
  ctx.font = '30px sans-serif';
  ctx.fillText('★'.repeat(res.stars) + '☆'.repeat(5 - res.stars), S / 2, 306);
  // stats row
  ctx.font = '800 40px "Segoe UI", sans-serif';
  ctx.fillStyle = '#e8f0ff';
  ctx.fillText(res.score.toLocaleString(), S / 2, 368);
  ctx.font = '600 15px "Segoe UI", sans-serif';
  ctx.fillStyle = '#8fa3c8';
  ctx.fillText('SCORE · ' + res.accuracy.toFixed(1) + '% ACC · ×' + res.maxCombo + ' COMBO', S / 2, 394);
  // waveform strip
  if (wavePeaks) {
    const n = wavePeaks.length, mid = 448, amp = 34;
    const grad = ctx.createLinearGradient(60, 0, S - 60, 0);
    grad.addColorStop(0, 'rgba(34,211,238,.6)'); grad.addColorStop(0.5, 'rgba(91,140,255,.6)'); grad.addColorStop(1, 'rgba(192,132,252,.6)');
    ctx.fillStyle = grad;
    for (let i = 0; i < n; i++) {
      const x = 60 + (i / (n - 1)) * (S - 120);
      const h = Math.max(1, wavePeaks[i] * amp);
      ctx.fillRect(x, mid - h, 2.4, h * 2);
    }
  }
  ctx.fillStyle = '#4a5a7a';
  ctx.font = '600 13px "Segoe UI", sans-serif';
  ctx.fillText('YOUR MUSIC · YOUR GAME — PLAYED LOCALLY', S / 2, 490);
  return cv.toDataURL('image/png');
};

/* ============================================================
   INIT
   ============================================================ */
UI.init = function (app) {
  UI.app = app;
  ['scr-home', 'scr-analyze', 'scr-results'].forEach((id) => { UI.screens[id] = $(id); });
  buildHome();
  bindSettings();

  $('file-input').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) UI.app.pickFile(f);
    e.target.value = '';
  });

  // buttons wired by main via app where stateful; static ones here:
  $('btn-start').addEventListener('click', () => UI.app.startGame());
  $('btn-back').addEventListener('click', () => UI.app.goHome());
  $('btn-replay').addEventListener('click', () => UI.app.replay());
  $('btn-new').addEventListener('click', () => UI.app.goHome());
  $('btn-share').addEventListener('click', () => UI.app.shareResult());
  $('btn-share-done').addEventListener('click', () => closeModal('modal-share'));
  $('btn-resume').addEventListener('click', () => UI.app.resumeGame());
  $('btn-restart').addEventListener('click', () => UI.app.replay());
  $('btn-quit').addEventListener('click', () => UI.app.quitGame());
  $('btn-pause').addEventListener('click', () => UI.app.togglePause());
  $('btn-pause-settings').addEventListener('click', () => openSettings());
  $('btn-pulse').addEventListener('pointerdown', (e) => { e.preventDefault(); UI.app.pulsePress(); });
  $('btn-pulse').addEventListener('pointerup', (e) => { e.preventDefault(); UI.app.pulseRelease(); });
};

if (typeof window !== 'undefined') window.UI = UI;
})();

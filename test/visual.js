/* ============================================================
   RESONANCE — test/visual.js
   Real-browser visual QA. Boots the BUILT index.html in
   headless Chromium (puppeteer), plays a demo with an in-page
   bot, and captures screenshots at key moments. Also collects
   page errors/console noise.
   Run:  node test/visual.js [--puppeteer-dir /tmp/node_modules]
   Needs: npm i puppeteer (anywhere resolvable via require).
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

let puppeteer;
for (const dir of [process.env.PUPPETEER_DIR || process.env.CANVAS_DIR, '/tmp/qa/node_modules', '/tmp/node_modules', '.'].filter(Boolean)) {
  try { puppeteer = require(path.join(dir, 'puppeteer')); break; } catch (e) { }
}
if (!puppeteer) { console.error('puppeteer not found — npm install puppeteer, or set PUPPETEER_DIR'); process.exit(2); }

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const errors = [];
const consoleNoise = [];
let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ✓ ' + msg); } else { failed++; console.log('  ✗ ' + msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  console.log('    📸 ' + name + '.png');
}

/* in-page bot: presses lane keys + space from the timeline */
const BOT_SRC = `(() => {
  const e = window.App.engine;
  const KEYS = ['KeyA','KeyS','KeyD','KeyF'];
  const evs = e.song.timeline.events.filter(ev => ev.type==='TAP'||ev.type==='SPECIAL'||ev.type==='HOLD'||ev.type==='PEAK');
  const done = new Set(), holding = new Set();
  window.__botHits = 0;
  window.__bot = () => {
    if (e.state !== 'playing') return;
    const t = e.now;
    for (const ev of evs) {
      if (ev.time > t + 0.03) break;
      if (ev.type === 'PEAK') {
        if (!done.has(ev.id) && t >= ev.time - 0.02) { window.dispatchEvent(new KeyboardEvent('keydown',{code:'Space'})); window.dispatchEvent(new KeyboardEvent('keyup',{code:'Space'})); done.add(ev.id); window.__botHits++; }
      } else if (ev.type === 'HOLD') {
        if (!holding.has(ev.id) && !done.has(ev.id) && t >= ev.time - 0.012) { window.dispatchEvent(new KeyboardEvent('keydown',{code:KEYS[ev.lane]})); holding.add(ev.id); }
      } else if (!done.has(ev.id) && t >= ev.time - 0.012) {
        window.dispatchEvent(new KeyboardEvent('keydown',{code:KEYS[ev.lane]}));
        window.dispatchEvent(new KeyboardEvent('keyup',{code:KEYS[ev.lane]}));
        done.add(ev.id); window.__botHits++;
      }
    }
    for (const ev of Array.from(holding)) {
      if (t >= ev.time + (ev.dur || 0.2)) { window.dispatchEvent(new KeyboardEvent('keyup',{code:KEYS[ev.lane]})); holding.delete(ev.id); done.add(ev.id); }
    }
  };
  window.__botTimer = setInterval(window.__bot, 8);
})();`;

function writeWav(file, samples, sr) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE((v * 32767) | 0, 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

async function newSession(browser, opts) {
  const page = await browser.newPage();
  await page.setViewport({ width: opts.w, height: opts.h, deviceScaleFactor: 1, isMobile: !!opts.mobile, hasTouch: !!opts.mobile });
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleNoise.push(m.text()); });
  await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'load' });
  await page.waitForFunction('!!(window.App && window.App.engine)', { timeout: 10000 });
  return page;
}

async function waitForSongTime(page, t, timeoutMs) {
  await page.waitForFunction(
    (t) => window.App.engine.state !== 'idle' && window.App.engine.now >= t,
    { timeout: timeoutMs }, t);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--force-color-profile=srgb'],
  });

  /* ---------- environment probes ---------- */
  console.log('— environment —');
  {
    const p = await browser.newPage();
    await p.setContent('<canvas></canvas>');
    const probe = await p.evaluate(() => new Promise((res) => {
      let ac;
      try { ac = new AudioContext(); } catch (e) { return res('no-audioctx'); }
      const t0 = ac.currentTime;
      setTimeout(() => res(ac.state + ' Δt=' + (ac.currentTime - t0).toFixed(3)), 600);
    }));
    ok(/running/.test(probe) && !/Δt=0.000/.test(probe), 'AudioContext runs & advances in headless (' + probe + ')');
    const worker = await p.evaluate(() => new Promise((res) => {
      try {
        const w = new Worker(URL.createObjectURL(new Blob(['self.onmessage=()=>postMessage(1)'], { type: 'text/javascript' })));
        w.onmessage = () => { w.terminate(); res('ok'); };
        w.onerror = () => res('error');
        w.postMessage(0);
        setTimeout(() => res('timeout'), 2000);
      } catch (e) { res('throw: ' + e.message); }
    }));
    ok(worker === 'ok', 'blob Worker available (' + worker + ')');
    await p.close();
  }

  /* ---------- desktop session: full playthrough ---------- */
  console.log('— desktop 1280×800 —');
  const page = await newSession(browser, { w: 1280, h: 800 });

  await sleep(1600); /* idle animation */
  await shot(page, '01-home');

  const anStart = Date.now();
  await page.click('.demo-card');               /* Neon Circuit */
  await page.waitForFunction("!document.getElementById('btn-start').disabled", { timeout: 60000 });
  const anMs = Date.now() - anStart;
  ok(anMs < 30000, 'analysis finished (' + (anMs / 1000).toFixed(1) + 's for a ~44s track)');
  await sleep(400);
  await shot(page, '02-analyze');

  await page.click('#btn-start');
  await page.waitForFunction("window.App.engine.state === 'countdown'", { timeout: 5000 });
  await shot(page, '03-countdown');

  await page.evaluate(BOT_SRC);
  await page.waitForFunction("window.App.engine.state === 'playing'", { timeout: 8000 });
  await waitForSongTime(page, 4.5, 15000); await shot(page, '04-play-intro');
  await page.waitForFunction("window.App.engine.section && window.App.engine.section.type === 'build' && window.App.engine.now > 9", { timeout: 30000 });
  await shot(page, '05-play-build');
  /* wait for the real drop section AND its theme to finish lerping in */
  await page.waitForFunction("window.App.engine.section && window.App.engine.section.type === 'drop' && window.App.engine.now - window.App.engine.section.start > 4", { timeout: 60000 });
  await shot(page, '06-play-drop');
  await page.waitForFunction("window.App.engine.now > 36", { timeout: 60000 }); await shot(page, '07-play-late');

  const midStats = await page.evaluate(() => {
    const s = window.App.engine.score;
    return { score: s.score, combo: s.combo, acc: s.accuracy(), judged: s.judged, hits: window.__botHits };
  });
  ok(midStats.score > 5000, 'bot scoring mid-run (' + JSON.stringify(midStats) + ')');
  ok(midStats.acc >= 0.9, 'bot accuracy healthy (' + (midStats.acc * 100).toFixed(1) + '%)');

  await page.waitForFunction("window.App.engine.state === 'finished'", { timeout: 120000 });
  await sleep(700); /* results animations */
  await shot(page, '08-results');
  const res = await page.evaluate(() => ({
    grade: window.App.lastResult.grade, score: window.App.lastResult.score,
    acc: window.App.lastResult.accuracy.toFixed(1), completed: window.App.lastResult.completed,
    offsets: window.App.lastResult.offsets.length,
  }));
  ok(res.completed, 'run completed (' + JSON.stringify(res) + ')');
  ok(res.grade === 'SS' || res.grade === 'S', 'bot grade high (' + res.grade + ')');
  ok(res.offsets > 50, 'timing offsets captured for chart (' + res.offsets + ')');

  /* pause screenshot */
  await page.click('#btn-replay');
  await page.waitForFunction("window.App.engine.state === 'countdown'", { timeout: 5000 });
  await page.waitForFunction("window.App.engine.state === 'playing'", { timeout: 8000 });
  await waitForSongTime(page, 3, 10000);
  await page.keyboard.press('Escape');
  await sleep(400);
  await shot(page, '09-pause');
  await page.click('#btn-quit');
  await sleep(400);

  /* ---------- flow mode ---------- */
  console.log('— flow mode —');
  await page.evaluate("document.querySelectorAll('.mode-card')[1].click()");
  await page.evaluate("document.querySelectorAll('.demo-card')[3].click()"); /* Voltage */
  await page.waitForFunction("!document.getElementById('btn-start').disabled", { timeout: 60000 });
  await page.click('#btn-start');
  await page.waitForFunction("window.App.engine.state === 'countdown'", { timeout: 5000 });
  await page.waitForFunction("window.App.engine.state === 'playing'", { timeout: 8000 });
  /* let adaptive steer via pointer sweep */
  await waitForSongTime(page, 8, 20000);
  for (let i = 0; i < 30; i++) {
    await page.mouse.move(200 + (i % 2) * 880, 600);
    await sleep(120);
  }
  await waitForSongTime(page, 14, 15000); await shot(page, '10-flow');
  const flowState = await page.evaluate(() => ({ judged: window.App.engine.score.judged, score: window.App.engine.score.score, col: window.App.engine.flowCol.toFixed(2) }));
  ok(flowState.judged > 10, 'flow gates judging (' + JSON.stringify(flowState) + ')');
  await page.evaluate("window.App.quitGame()");
  await sleep(300);

  /* ---------- help/settings ---------- */
  await shot(page, '11-home-again');
  await page.click('#btn-settings');
  await sleep(300);
  await shot(page, '12-settings');
  await page.click('#btn-set-done');
  await page.click('#btn-help');
  await sleep(300);
  await shot(page, '13-help');
  await page.click('#btn-help-done');
  await page.close();

  /* ---------- mobile session ---------- */
  console.log('— mobile 390×844 —');
  const mob = await newSession(browser, { w: 390, h: 844, mobile: true });
  await sleep(1200);
  await shot(mob, '14-mobile-home');
  await mob.click('.demo-card');
  await mob.waitForFunction("!document.getElementById('btn-start').disabled", { timeout: 60000 });
  await mob.click('#btn-start');
  await mob.waitForFunction("window.App.engine.state === 'countdown'", { timeout: 5000 });
  await mob.evaluate(BOT_SRC);
  await mob.waitForFunction("window.App.engine.state === 'playing'", { timeout: 8000 });
  await waitForSongTime(mob, 6, 20000);
  await shot(mob, '15-mobile-play');
  /* touch lane input */
  const lanes = await mob.evaluate(() => {
    const L = window.App.engine.world.L;
    return [0, 1, 2, 3].map((i) => L.laneX(i, 1));
  });
  await mob.touchscreen.touchStart(lanes[0], 700);
  await mob.touchscreen.touchEnd();
  await mob.touchscreen.touchStart(lanes[2], 700);
  await mob.touchscreen.touchEnd();
  await sleep(300);
  await shot(mob, '16-mobile-touch');
  await mob.close();

  /* ---------- real file upload (the user-reported flow) ---------- */
  console.log('— real file upload —');
  {
    /* build a ~80s WAV with the demo synth and push it through #file-input */
    const DS = require(path.join(ROOT, 'src', 'demosynth.js'));
    const neon = DS.catalog.find((c) => c.id === 'neon');
    const def = Object.assign({}, neon, {
      id: 'uploadtest', title: 'Upload Test',
      sections: neon.sections.concat(neon.sections.slice(1)),
    });
    const rend = DS.renderSong(def);
    const wav = path.join('/tmp', 'resonance-upload.wav');
    writeWav(wav, rend.samples, DS.SR);

    const up = await newSession(browser, { w: 1280, h: 800 });
    const input = await up.$('#file-input');
    await input.uploadFile(wav);
    await up.waitForFunction("!document.getElementById('btn-start').disabled", { timeout: 90000 });
    ok(true, 'uploaded WAV analyzed & ready');
    const vis = await up.evaluate(() => {
      const r = document.getElementById('btn-start').getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0;
    });
    ok(vis, 'START button visible in viewport at 1280×800');
    await up.click('#btn-start');
    await up.waitForFunction("window.App.engine.state === 'countdown'", { timeout: 8000 });
    const noOverlay = await up.evaluate(() => document.querySelector('.screen.active') === null);
    ok(noOverlay, 'REGRESSION FIX: no stats screen over the game (file upload flow)');
    await up.waitForFunction("window.App.engine.state === 'playing'", { timeout: 15000 });
    await up.evaluate(BOT_SRC);
    await waitForSongTime(up, 8, 20000);
    const st = await up.evaluate(() => {
      const e = window.App.engine;
      return { now: +e.now.toFixed(1), score: e.score.score, judged: e.score.judged, src: App.current.source };
    });
    ok(st.src === 'file' && st.score > 0, 'file-upload game playable, bot scoring (' + JSON.stringify(st) + ')');
    await shot(up, '17-file-upload-play');
    await up.close();
  }

  /* ---------- short viewport: START must be reachable ---------- */
  console.log('— short viewport 1024×560 —');
  {
    const sh = await newSession(browser, { w: 1024, h: 560 });
    await sh.click('.demo-card');
    await sh.waitForFunction("!document.getElementById('btn-start').disabled", { timeout: 60000 });
    const vis = await sh.evaluate(() => {
      const r = document.getElementById('btn-start').getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0;
    });
    ok(vis, 'START visible without scrolling on a short viewport');
    await shot(sh, '18-short-viewport');
    await sh.close();
  }

  /* ---------- autoplay-blocked audio: game must stay playable ---------- */
  console.log('— frozen audio clock fallback —');
  {
    const fz = await newSession(browser, { w: 1280, h: 800 });
    await fz.click('.demo-card');
    await fz.waitForFunction("!document.getElementById('btn-start').disabled", { timeout: 60000 });
    /* freeze the audio clock like a blocked/suspended context would */
    await fz.evaluate(() => {
      const a = window.App.audio;
      a.ensureCtx();
      Object.defineProperty(a.ctx, 'currentTime', { get: () => 0, configurable: true });
    });
    await fz.click('#btn-start');
    await fz.waitForFunction("window.App.engine.state === 'playing'", { timeout: 15000 });
    const toastShown = await fz.evaluate(() => {
      const t = document.querySelector('.toast');
      return t ? t.textContent : '';
    });
    await fz.waitForFunction("window.App.engine.now >= 2", { timeout: 15000 });
    const fb = await fz.evaluate(() => ({
      frozen: window.App.audio._frozen, now: +window.App.engine.now.toFixed(1),
    }));
    ok(fb.frozen === true && fb.now >= 2, 'wall-clock fallback engaged, game advancing (' + JSON.stringify(fb) + ')');
    ok(/silently/i.test(toastShown), 'silent-mode toast shown to the user ("' + toastShown + '")');
    await shot(fz, '19-frozen-audio-fallback');
    await fz.close();
  }

  /* ---------- verdicts ---------- */
  console.log('— errors —');
  ok(errors.length === 0, 'no page errors' + (errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''));
  ok(consoleNoise.length === 0, 'no console.error noise' + (consoleNoise.length ? ' → ' + consoleNoise.slice(0, 3).join(' | ') : ''));
  for (const f of fs.readdirSync(SHOTS)) {
    const size = fs.statSync(path.join(SHOTS, f)).size;
    ok(size > 3000, f + ' has real content (' + (size / 1024).toFixed(0) + ' KB)');
  }

  await browser.close();
  console.log('\n=== ' + passed + '/' + (passed + failed) + ' visual checks passed' + (failed ? ', ' + failed + ' FAILED' : '') + ' — screenshots in shots/ ===');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

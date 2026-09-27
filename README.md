# RESONANCE — Your Music. Your Game.

A complete, single-file music-rhythm game that turns **any audio file** into a
playable level, entirely in your browser. Upload a song — the game analyzes
the actual audio (tempo, beats, structure, energy, drops) and generates the
chart from it. Nothing is uploaded anywhere; there is no server, no account,
no asset download. One HTML file, ~230 KB.

```
┌────────────────────────────────────────────────────────────────────┐
│  ♫ upload any song ──► analyze (tempo · beats · structure · energy)│
│                          │                                          │
│                          ▼                                          │
│                generate chart (lanes · holds · hazards · peaks)     │
│                          │                                          │
│                          ▼                                          │
│                     play · react · score                            │
└────────────────────────────────────────────────────────────────────┘
```

## Play it

Open **`index.html`** in any modern browser. That's it — it works from
`file://`, a USB stick, or a web server. (For best audio latency on
Bluetooth headphones, bump *Settings → Audio latency*.)

- **Upload a song** — MP3, WAV, OGG, M4A, FLAC… or drag & drop it anywhere.
- **Or play a demo track** — six built-in procedurally-synthesized songs
  (electronic, synthwave, lo-fi, drum & bass, boom-bap, ambient).
- **Four modes**
  | Mode | What it is |
  |---|---|
  | **RHYTHM** | 4-lane note highway — taps, holds, specials, hazards, orbs, peak moments |
  | **FLOW** | steer a ship through gates and walls with pointer / touch |
  | **ZEN** | no fail, no combo drain — just the music and the highway |
  | **CHAOS** | everything at once, for the brave |
- **Difficulty** — AUTO (estimated from the song itself) through EXTREME,
  plus **live adaptive difficulty** that quietly adds or culls notes if
  you're struggling or cruising.

### Controls

| Input | Action |
|---|---|
| `A` `S` `D` `F` / arrows | lane hits (tap lanes on touch) |
| `SPACE` | peak moments (golden ring) |
| pointer / touch drag | lane hits, orb pickup, FLOW steering |
| `ESC` | pause / resume |

Judgments: **PERFECT** ±50 ms · **GREAT** ±100 ms · **GOOD** ±150 ms.
Combos build your multiplier (up to ×5); a perfect streak charges **FLOW**
(≥90 + 10-combo grants a bonus tier). Let spiked hazards pass — pressing
their lane costs you. Golden-gate chains are worth double.

### Audio that adapts to your files

- **Loudness normalization** — every upload gets a per-song trim (from its
  measured RMS) plus a gentle compressor, so quiet acoustic tracks and
  brick-walled EDM both sit at a comfortable, non-clipping level.
- **Tap-test calibration** — Settings → *TAP TEST* plays a beep grid; tap
  SPACE with the beats and your audio latency is measured and applied
  automatically (headphone / Bluetooth delay included).

## Results, bests, sharing

After a track: letter grade + stars, accuracy, judgment counts, average
timing offset, a **timing scatter chart** of every hit (early/late drift,
with moving average), per-track personal bests (local only), and a
downloadable share card. If your average offset is consistently off by
20 ms+, the game suggests a latency adjustment. The pause screen shows
live score/combo/accuracy plus song position and progress.

## Building from source

```
node build.js        # → index.html (self-contained; no dependencies)
```

`build.js` inlines every module from `src/` into `template.html`. The
analyzer is also embedded as `text/plain` so the game can spin it up in a
Web Worker (Blob URL); if Workers are unavailable it falls back to the
main thread with progress yields.

## Tests

```
node test/test-analyzer.js    # DSP: tempo, beats, sections, peaks    (47)
node test/test-demos.js       # synth + end-to-end analysis of demos   (60)
node test/test-generator.js   # chart generation + validation         (93)
node test/test-game.js        # headless playthroughs via GameEngine  (61)
node test/test-world.js       # world rendering: flow/rhythm/zen       (10)
                              # road geometry, climax pad heating
NODE_PATH=<dir with jsdom> node test/test-ui.js                      (67)
node test/visual.js           # real-browser QA: headless Chromium,   (37)
                              # in-page bot plays a demo start-to-
                              # finish; screenshots into shots/
CANVAS_DIR=<dir with canvas> node test/visual-check.js               (85)
                              # pixel-statistic verification of the
                              # screenshots (palette per section,
                              # dark theme, no blank frames)
```

`test-game.js` runs perfect/chaos/flow bots through the real engine with a
stubbed canvas — full songs, all modes, determinism and completion checks.
`test-ui.js` boots the **built** `index.html` in jsdom with a fake
AudioContext and plays a demo start-to-finish through the real DOM
(clicks, key events, pause, results, replay, settings persistence).
`test/visual.js` is the deepest layer: it loads the built file in real
Chromium (needs `npm i puppeteer`), runs with the actual Web Audio clock
and blob-Worker analysis, plays with a keyboard bot (SS rank), and
captures 16 screenshots — desktop, flow mode, mobile/touch — which
`test/visual-check.js` then verifies by pixel statistics. All without a
single page error.


## Architecture

```
template.html     page shell, full CSS design system
src/utils.js      math, RNG, color, curve helpers
src/demosynth.js  procedural demo-track synthesis (seeded → deterministic)
src/analyzer.js   the DSP: FFT → spectral flux → onset density →
                  tempo/beat tracking → sections → peaks/drops →
                  fingerprint; runs in a Worker when possible
src/generator.js  analysis → event timeline (taps/holds/hazards/orbs/
                  peaks/gates), difficulty model, per-mode shaping,
                  seed = fnv1a(fingerprint|mode|difficulty)
src/clock.js      audio-clock with latency + user calibration and
                  drift-smoothing (snaps after seeks)
src/scoring.js    ScoreManager (grades, combo tiers, flow energy,
                  chains) + AdaptiveDirector (assist/excite hysteresis)
src/audio.js      Web Audio engine: scheduling, analyser bands for the
                  visuals, synthesized SFX (zero audio assets)
src/entities.js   pooled targets/holds/hazards/orbs/peaks/gates/walls,
                  particles, floating judgments, beat rings, sprite cache
src/world.js      reactive world: themes per song section, starfield,
                  road with beat-locked grid, spectrum foreground
src/engine.js     GameEngine: states, input, judging, spawning, adaptive
                  culling, climax events, completion
src/ui.js         screens, HUD, results, settings, toasts, share card
src/main.js       bootstrap + orchestration: file → decode → analyze →
                  generate → play; input; persistence; rAF loop
```

**Design guarantees**

- Same song + mode + difficulty ⇒ same chart (seeded generation from the
  audio fingerprint).
- No fails: a run always completes; results grade whatever happened.
- Adaptive difficulty never changes what's on screen mid-approach — only
  what spawns next.
- All state local: `localStorage` only, wrapped to survive private mode.

## Browser support

Chrome / Edge / Firefox / Safari (desktop & mobile). Requires Web Audio;
everything else degrades gracefully (Worker → main thread, localStorage →
memory). If the browser blocks audio autoplay entirely, a watchdog detects
the frozen audio clock and switches to wall time so the game stays
playable (with a "playing silently" notice), retrying the audio context
in the background.

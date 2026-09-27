/* ============================================================
 * RESONANCE — engine.js
 * GameEngine: state machine + main loop + input + judgment +
 * spawning + flow/zen modes + climax + adaptive integration.
 * DOM-free logic (render receives a ctx) → testable in Node.
 * ============================================================ */
(function () {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const RS = G.RS = G.RS || {};
  const U = RS.util;
  const E = RS.Entities;
  const { clamp, lerp, TAU } = U;
  const S = RS.Scoring;

  class GameEngine {
    /* hooks: {onHUD, onSection, onFinish, onCountdown, onJudge, onPauseRequest} */
    constructor(hooks) {
      this.hooks = hooks || {};
      this.state = 'idle';
      this.ctx = null;
      this.world = new RS.World.World();
      this.audio = null;          /* RS.AudioEngine (browser) or test double */
      this.calibration = 0;       /* seconds */
      this.settings = { visualIntensity: 1, reducedMotion: false, showKeys: true, colorShapes: true };

      this.pools = {
        targets: new E.Pool(() => new E.Target(), 64),
        holds: new E.Pool(() => new E.Hold(), 24),
        hazards: new E.Pool(() => new E.Hazard(), 16),
        peaks: new E.Pool(() => new E.Peak(), 6),
        gates: new E.Pool(() => new E.Gate(), 48),
        walls: new E.Pool(() => new E.Wall(), 12),
        rings: new E.Pool(() => new E.BeatRing(), 20)
      };
      this.particles = new E.Particles(420);
      this.texts = new E.FloatTexts(28);
      this.orbs = new E.Pool(() => new E.Orb(), 80);

      this.song = null;           /* {analysis, timeline, title, subtitle} */
      this.score = null;
      this.adaptive = null;
      this.clock = null;
      this.reset_();
    }

    reset_() {
      this.now = 0;
      this.dt = 0;
      this.nextIdx = 0;
      this.beatIdx = 0;
      this.sectionIdx = -1;
      this.section = null;
      this.climax = false;
      this.pressedLanes = [false, false, false, false];
      this.strayT = [-9, -9, -9, -9];
      this.holdByLane = [null, null, null, null];
      this.eventsTotal = 0;
      this.eventsSpawned = 0;
      this.eventsJudged = 0;
      this._lastBands = { bass: 0, mid: 0, high: 0, level: 0 };
      this.finished = false;
      this.lastHudAt = -1;
      this.lastOrbPull = 0;
      this.flowCol = 2; this.flowTarget = 2;
      this.flowSteer = { left: false, right: false };
      this.lastCountdownN = 99;
      this.orbRngSeed = 1;
      for (const k in this.pools) this.pools[k].clear();
      this.particles.clear(); this.texts.clear(); this.orbs.clear();
    }

    setCanvas(ctx) { this.ctx = ctx; }
    setAudio(audio) { this.audio = audio; }
    resize(w, h) { this.world.resize(w, h); }

    load(song) {
      this.reset_();
      this.song = song;
      const meta = song.timeline.meta;
      this.world.resize(this.world.L ? this.world.L.w : 960, this.world.L ? this.world.L.h : 540);
      this.world.setSection('verse', 0);
      this.world.climax = 0;
      this.world.zen = meta.mode === 'zen';
      this.score = new S.ScoreManager({ zen: meta.mode === 'zen', windowScale: meta.windowScale });
      this.adaptive = new S.AdaptiveDirector(meta.adaptive);
      this.eventsTotal = song.timeline.events.filter((e) => e.type !== 'ORB').length;
      this.score.peakTotal = song.timeline.events.filter((e) => e.type === 'PEAK').length;
      /* clock: song position from audio clock + latency + calibration */
      const audio = this.audio;
      this.clock = new RS.GameClock(() => {
        const raw = audio ? audio.songTime() : this.testTime_;
        return raw - (audio ? audio.latencySeconds() : 0) + this.calibration;
      });
    }

    /* External time source for Node tests (no audio engine) */
    setTestTime(t) { this.testTime_ = t; }

    leadTime() {
      if (!this.song) return 3;
      const T = 60 / this.song.analysis.bpm;
      return 3 * clamp(2 * T, 0.55, 1.0) + 0.3;
    }

    start(countdownTicks) {
      if (!this.song) return;
      this.state = 'countdown';
      this.countdownTotal = this.leadTime();
      this.clock.sync();
      if (this.audio) this.audio.sfx('count');
      if (this.hooks.onCountdown) this.hooks.onCountdown(3);
      this.lastCountdownN = 3;
    }

    pause() {
      if (this.state !== 'playing' && this.state !== 'countdown') return;
      this.pausedFrom = this.state;
      this.state = 'paused';
      if (this.audio) this.audio.pause();
    }
    resume() {
      if (this.state !== 'paused') return;
      this.state = this.pausedFrom || 'playing';
      if (this.audio) this.audio.resume();
    }
    quit() {
      this.state = 'idle';
      if (this.audio) this.audio.stop();
    }

    /* ============================ INPUT ============================ */
    pressLane(lane, timeOverride) {
      if (this.state !== 'playing') return;
      const now = timeOverride !== undefined ? timeOverride : this.now;
      if (lane < 0 || lane > 3) return;
      this.pressedLanes[lane] = true;
      const meta = this.song.timeline.meta;
      if (meta.mode === 'flow') return; /* flow steers instead */

      /* 1) hazard check first (targets win if both qualify) */
      let target = null, targetDt = 1e9;
      let hazard = null, hazDt = 1e9;
      const win = S.WINDOWS.good * this.score.windowScale;
      this.pools.targets.each((t) => {
        if (t.judged) return;
        const dt = now - t.ev.time;
        if (Math.abs(dt) <= win && (!target || Math.abs(dt) < Math.abs(targetDt))) {
          target = t; targetDt = dt;
        }
      });
      this.pools.holds.each((h) => {
        if (h.state !== 'pending') return;
        const dt = now - h.ev.time;
        if (Math.abs(dt) <= win && Math.abs(dt) < Math.abs(targetDt)) { target = h; targetDt = dt; }
      });
      this.pools.hazards.each((h) => {
        if (h.state !== 'incoming') return;
        const dt = now - h.ev.time;
        if (Math.abs(dt) <= Math.max(0.16, win) && Math.abs(dt) < Math.abs(hazDt)) { hazard = h; hazDt = dt; }
      });

      if (target) {
        if (target instanceof E.Hold) {
          this.beginHold(target, targetDt, now);
        } else {
          this.judgeTarget(target, targetDt, now);
        }
        return;
      }
      if (hazard && Math.abs(hazDt) <= 0.18) {
        this.hitHazard(hazard, now);
        return;
      }
      /* stray press: soft ripple, debounced */
      if (now - this.strayT[lane] > 0.13) {
        this.strayT[lane] = now;
        const L = this.world.L;
        this.particles.ring(L.laneX(lane, 1), L.hitY, 'rgba(160,190,220,0.5)', 10);
      }
    }
    releaseLane(lane, timeOverride) {
      if (lane < 0 || lane > 3) return;
      this.pressedLanes[lane] = false;
      if (this.state !== 'playing') return;
      const now = timeOverride !== undefined ? timeOverride : this.now;
      const h = this.holdByLane[lane];
      if (h && h.state === 'held') this.endHold(h, now, false);
    }
    pressSpace(timeOverride) {
      if (this.state !== 'playing') return;
      const now = timeOverride !== undefined ? timeOverride : this.now;
      this.tryPeak(now, null);
    }
    pointerDown(x, y, timeOverride) {
      if (this.state !== 'playing') return;
      const now = timeOverride !== undefined ? timeOverride : this.now;
      const L = this.world.L;
      const meta = this.song.timeline.meta;
      if (meta.mode === 'flow') {
        this.flowTarget = clamp(this.flowColFromX(x), 0, 4);
        return;
      }
      /* peak: clicking near the orb */
      const dx = x - L.cx, dy = y - L.orbY;
      if (Math.hypot(dx, dy) < L.targetR * 3.2) {
        if (this.tryPeak(now, { x, y })) return;
      }
      /* pop nearby orbs */
      let popped = false;
      this.orbs.each((o) => {
        if (Math.hypot(o.x - x, o.y - y) < 34) {
          this.collectOrb(o);
          popped = true;
        }
      });
      if (popped) return;
      /* lane press by x band */
      const rel = (x - (L.cx - L.botW / 2 * 0.77)) / (L.botW * 0.77);
      if (rel >= 0 && rel <= 1 && y > L.h * 0.3) {
        this.pressLane(Math.min(3, Math.floor(rel * 4)), now);
      }
    }
    flowColFromX(x) {
      const L = this.world.L;
      const hitHW = (L.botW / 2) * ((L.hitY - L.vpY) / (L.h - L.vpY));
      return clamp((x - (L.cx - hitHW)) / (2 * hitHW) * 5, 0, 4);
    }
    pointerMove(x, y) {
      if (this.state !== 'playing') return;
      if (this.song.timeline.meta.mode === 'flow') {
        this.flowTarget = clamp(this.flowColFromX(x), 0, 4);
      }
    }
    setFlowSteer(dir, on) {
      if (dir < 0) this.flowSteer.left = on; else this.flowSteer.right = on;
    }

    /* ============================ JUDGMENT ============================ */
    judgeTarget(t, dt, now) {
      t.judged = true;
      const res = this.score.judge(dt, t.ev);
      this.adaptive.onJudgment(res.grade, now);
      this.eventsJudged++;
      const L = this.world.L;
      const x = L.laneX(t.ev.lane, 1), y = L.hitY;
      const col = E.JUDGE_COLORS[res.grade] || '#fff';
      const vi = this.settings.visualIntensity;
      if (res.grade === 'perfect') {
        this.particles.burst(x, y, col, Math.round(16 * vi) + 6, 260);
        this.particles.ring(x, y, col, 16);
        if (!this.settings.reducedMotion) this.world.addShake(2.2);
      } else if (res.grade === 'great') {
        this.particles.burst(x, y, col, Math.round(10 * vi) + 3, 200);
      } else if (res.grade === 'good') {
        this.particles.burst(x, y, col, Math.round(6 * vi), 150);
      } else {
        this.particles.ring(x, y, col, 12);
        if (!this.settings.reducedMotion) this.world.addShake(3.5);
      }
      this.texts.add(x, y - 34, E.JUDGE_LABELS[res.grade] + (res.gain ? ' +' + res.gain : ''), col,
        res.grade === 'perfect' ? 17 : 14, this.settings.colorShapes ? E.JUDGE_GLYPHS[res.grade] : null);
      if (res.milestone) {
        this.texts.add(L.cx, L.h * 0.32, res.milestone.label, '#ffd24a', 26, '✦', 1.3);
        this.particles.confetti(L.cx, L.h * 0.3, ['#ffd24a', '#67e8f9', '#ff5ec4', '#8affc1'], Math.round(26 * vi));
        if (this.audio) this.audio.sfx('chain');
      }
      if (res.chainDone) {
        this.texts.add(x, y - 66, 'CHAIN COMPLETE', '#aef4ff', 18, '∞', 1.1);
        this.particles.confetti(x, y, ['#aef4ff', '#67e8f9'], Math.round(16 * vi));
      }
      if (this.audio) this.audio.sfx(res.grade === 'pass' ? 'chime' : res.grade);
      t.kill();
      if (this.hooks.onJudge) this.hooks.onJudge(res, t.ev);
    }
    beginHold(h, dt, now) {
      const res = this.score.judge(dt, h.ev);
      this.adaptive.onJudgment(res.grade, now);
      this.eventsJudged++;
      h.state = 'held';
      h.pressT = now;
      h.grade = res.grade;
      this.holdByLane[h.ev.lane] = h;
      const L = this.world.L;
      const x = L.laneX(h.ev.lane, 1), y = L.hitY;
      this.texts.add(x, y - 34, E.JUDGE_LABELS[res.grade], E.JUDGE_COLORS[res.grade], 15, this.settings.colorShapes ? E.JUDGE_GLYPHS[res.grade] : null);
      this.particles.burst(x, y, E.JUDGE_COLORS[res.grade], 8, 180);
      if (this.audio) this.audio.sfx(res.grade === 'pass' ? 'chime' : res.grade);
    }
    endHold(h, now, natural) {
      h.state = 'done';
      this.holdByLane[h.ev.lane] = null;
      const L = this.world.L;
      const x = L.laneX(h.ev.lane, 1), y = L.hitY;
      if (natural) {
        const res = this.score.holdComplete(h.ev, h.grade);
        this.texts.add(x, y - 34, 'HOLD ✓', '#ffd24a', 15, '◉');
        this.particles.burst(x, y, '#ffd24a', 12, 220);
        if (this.audio) this.audio.sfx('perfect');
      } else {
        const frac = clamp((now - h.ev.time) / h.ev.dur, 0, 1);
        const res = this.score.holdEarly(h.ev, frac, h.grade);
        this.texts.add(x, y - 34, frac > 0.7 ? 'RELEASED' : 'EARLY', frac > 0.7 ? '#67e8f9' : '#e8f4ff', 13, '◌');
      }
      h.kill();
    }
    hitHazard(h, now) {
      h.state = 'hit';
      const res = this.score.hazardHit();
      this.adaptive.onJudgment('miss', now);
      const L = this.world.L;
      const x = L.laneX(h.ev.lane, 1), y = L.hitY;
      this.texts.add(x, y - 40, 'OUCH! −150', '#ff5e3a', 17, '✕');
      this.particles.burst(x, y, '#ff5e3a', 18, 300);
      if (!this.settings.reducedMotion) this.world.addShake(9);
      if (this.audio) this.audio.sfx('hazard');
      h.kill();
    }
    tryPeak(now, pos) {
      let hit = false;
      this.pools.peaks.each((pk) => {
        if (pk.state !== 'pending' || hit) return;
        if (Math.abs(now - pk.ev.time) <= 0.3) {
          hit = true;
          this.eventsJudged++;
          pk.state = 'hit';
          pk.fx = now;
          const res = this.score.peakHit();
          const L = this.world.L;
          const x = pos ? pos.x : L.cx, y = pos ? pos.y : L.orbY;
          this.texts.add(L.cx, L.h * 0.36, 'PERFECT MOMENT', '#ffe08a', 24, '◈', 1.4);
          this.texts.add(L.cx, L.h * 0.36 + 34, '+' + res.gain, '#ffe08a', 18, null, 1.2);
          this.particles.confetti(L.cx, L.h * 0.4, ['#ffe08a', '#ffd24a', '#ffffff', '#8affc1'], Math.round(40 * this.settings.visualIntensity));
          this.particles.ring(x, y, '#ffe08a', 30);
          if (this.audio) this.audio.sfx('peak');
          if (!this.settings.reducedMotion) this.world.addShake(5);
        }
      });
      return hit;
    }
    collectOrb(o) {
      o.kill();
      this.score.orbCollect();
      this.particles.burst(o.x, o.y, '#8affc1', 5, 120);
      if (this.audio) this.audio.sfx('orb');
    }

    /* ============================ UPDATE ============================ */
    update(now, dt) {
      this.now = now; this.dt = dt;
      const st = this.state;
      if (st === 'idle' || st === 'paused' || st === 'finished') return;

      const song = this.song, an = song.analysis, tl = song.timeline, meta = tl.meta;
      const L = this.world.L;
      const bands = this.audio ? this.audio.bands(dt) : { bass: 0, mid: 0, high: 0, level: 0 };
      this._lastBands = bands;

      if (st === 'countdown') {
        const remain = -now;
        const T = 60 / an.bpm;
        const tick = clamp(2 * T, 0.55, 1.0);
        const n = Math.ceil(remain / tick - 0.3 / tick);
        if (now >= 0) {
          this.state = 'playing';
          if (this.audio) this.audio.sfx('go');
          if (this.hooks.onCountdown) this.hooks.onCountdown(0);
        } else if (n < this.lastCountdownN && n >= 1 && this.hooks.onCountdown) {
          if (this.audio) this.audio.sfx('count');
          this.hooks.onCountdown(n);
          this.lastCountdownN = n;
        }
      }

      if (this.state === 'playing') {
        /* adaptive window scale */
        if (meta.adaptive) {
          this.adaptive.tick(now);
          this.score.setWindowScale(meta.windowScale * this.adaptive.windowScale);
        }
        this.score.tick(dt);

        /* ---- spawn due events ---- */
        const approach = meta.approach;
        while (this.nextIdx < tl.events.length) {
          const ev = tl.events[this.nextIdx];
          if (ev.time - approach > now) break;
          this.nextIdx++;
          if (ev.type === 'ORB') { this.spawnOrbs(ev); continue; }
          /* adaptive culling (never cull essentials) */
          if (ev.tier >= 3 && !this.adaptive.extras) continue;
          if (ev.tier >= 2 && ev.tier >= this.adaptive.activeCullTier && (ev.type === 'TAP' || ev.type === 'GATE')) continue;
          if (ev.type === 'TAP' || ev.type === 'SPECIAL' || ev.type === 'HOLD' || ev.type === 'PEAK' || ev.type === 'GATE') this.eventsSpawned++;
          this.spawnEvent(ev);
        }

        /* ---- beat visuals ---- */
        while (this.beatIdx < an.beats.length && an.beats[this.beatIdx].time <= now) {
          const b = an.beats[this.beatIdx];
          if (b.strength > 0.12 && !this.world.zen) {
            const ring = this.pools.rings.get();
            if (ring) ring.spawn(L.cx, L.orbY, b.downbeat || b.strength > 0.75 ? '#ffffff' : E.LANE_COLORS[2], b.downbeat || b.strength > 0.75);
          }
          this.beatIdx++;
        }

        /* ---- section tracking ---- */
        const secs = an.sections;
        let si = this.sectionIdx;
        while (si + 1 < secs.length && secs[si + 1].start <= now) si++;
        if (si !== this.sectionIdx) {
          this.sectionIdx = si;
          this.section = secs[si];
          this.world.setSection(this.section.type, now);
          const wasClimax = this.climax;
          this.climax = this.section.type === 'drop';
          if (this.hooks.onSection) this.hooks.onSection(this.section, now);
          if (this.climax && !wasClimax) {
            this.score.climaxBonus = true;
            this.texts.add(L.cx, L.h * 0.3, 'CLIMAX ×1.3', '#ff8a3d', 24, '⚡', 1.5);
            this.particles.confetti(L.cx, L.h * 0.32, ['#ff8a3d', '#ffd24a', '#ffffff'], 34);
            if (this.audio) this.audio.sfx('peak');
          } else if (!this.climax && wasClimax) {
            this.score.climaxBonus = false;
          }
        }

        /* ---- expire unhit events (misses) ---- */
        const win = S.WINDOWS.good * this.score.windowScale;
        this.pools.targets.each((t) => {
          if (!t.judged && now > t.ev.time + win) this.judgeTarget(t, now - t.ev.time, now);
        });
        this.pools.holds.each((h) => {
          if (h.state === 'pending' && now > h.ev.time + win) {
            h.state = 'done';
            const res = this.score.judge(now - h.ev.time, h.ev); /* miss */
            this.adaptive.onJudgment(res.grade, now);
            this.eventsJudged++;
            const x = L.laneX(h.ev.lane, 1);
            this.texts.add(x, L.hitY - 34, 'MISS', '#ff4d6a', 14, this.settings.colorShapes ? '✕' : null);
            if (this.audio) this.audio.sfx('miss');
            h.kill();
          } else if (h.state === 'held' && now > h.ev.time + h.ev.dur + win * 0.6) {
            this.endHold(h, now, true);
          }
        });
        this.pools.hazards.each((h) => {
          if (h.state === 'incoming' && now > h.ev.time + 0.22) {
            h.state = 'passed';
            this.score.dodgeSuccess();
            const x = L.laneX(h.ev.lane, 1);
            this.texts.add(x, L.hitY - 30, 'DODGED +30', '#9db8d8', 11, '◇');
            if (this.audio) this.audio.sfx('dodge');
            h.kill();
          }
        });
        this.pools.peaks.each((pk) => {
          if (pk.state === 'pending' && now > pk.ev.time + 0.3) {
            pk.state = 'expired';
            pk.fx = now;
            this.eventsJudged++;
            this.score.peakMiss();
          }
        });

        /* ---- flow mode player ---- */
        if (meta.mode === 'flow') {
          if (this.flowSteer.left) this.flowTarget = clamp(this.flowTarget - dt * 3.2, 0, 4);
          if (this.flowSteer.right) this.flowTarget = clamp(this.flowTarget + dt * 3.2, 0, 4);
          this.flowCol = lerp(this.flowCol, this.flowTarget, Math.min(1, dt * 10));
          /* gates judge on arrival */
          this.pools.gates.each((g) => {
            if (g.state === 'pending' && now >= g.ev.time) {
              g.state = 'done';
              const dcol = Math.abs(this.flowCol - g.ev.lane);
              const ev2 = { scoreMul: g.ev.gold ? 2 : 1 };
              const res = dcol < 0.45 ? this.score.judge(0.01, ev2) : dcol < 0.85 ? this.score.judge(0.08, ev2) : this.score.judge(0.3, ev2);
              this.adaptive.onJudgment(res.grade, now);
              this.eventsJudged++;
              const gy = L.orbY, gx = L.cx;
              this.texts.add(gx, gy - 60, E.JUDGE_LABELS[res.grade] + (res.gain ? ' +' + res.gain : ''), E.JUDGE_COLORS[res.grade], 15, this.settings.colorShapes ? E.JUDGE_GLYPHS[res.grade] : null);
              if (res.grade === 'perfect') this.particles.burst(gx, gy, '#ffd24a', 12, 220);
              if (this.audio) this.audio.sfx(res.grade);
              g.kill();
            }
          });
          /* walls */
          this.pools.walls.each((w) => {
            if (w.state === 'pending' && now >= w.ev.time) {
              w.state = 'done';
              const col = Math.round(this.flowCol);
              if (w.ev.lanes.indexOf(col) >= 0) {
                this.score.hazardHit();
                this.adaptive.onJudgment('miss', now);
                this.texts.add(L.cx, L.orbY - 70, 'CRASH!', '#ff5e3a', 18, '✕');
                if (!this.settings.reducedMotion) this.world.addShake(10);
                if (this.audio) this.audio.sfx('hazard');
                /* knock to nearest free col */
                let best = 0, bd = 9;
                for (let c = 0; c < 5; c++) {
                  if (w.ev.lanes.indexOf(c) < 0) {
                    const d = Math.abs(c - this.flowCol);
                    if (d < bd) { bd = d; best = c; }
                  }
                }
                this.flowTarget = this.flowCol = best;
              }
              w.kill();
            }
          });
        }

        /* ---- orbs ---- */
        const pull = this.score.combo >= 10 ? clamp(0.2 + this.score.combo / 160, 0, 0.85) : 0.05;
        this.orbs.each((o) => {
          o.update(dt, L, pull, L.cx, L.orbY, now);
          const dx = o.x - L.cx, dy = o.y - L.orbY;
          if (Math.hypot(dx, dy) < L.targetR * 2.1) this.collectOrb(o);
        });

        /* ---- finish ---- */
        if (now > an.duration + 1.4 && this.nextIdx >= tl.events.length) {
          this.finish();
        }
      }

      /* ---- shared visual updates ---- */
      const beat = an.beats[Math.min(this.beatIdx, an.beats.length - 1)] || { time: now, strength: 0 };
      const T = 60 / an.bpm;
      const phase = clamp(1 - (beat.time - now) / T, 0, 1);
      this.world.update(dt, {
        now, bands, zen: this.world.zen, climax: this.climax,
        beat: { phase, strength: beat.strength || 0.3, downbeat: !!beat.downbeat }
      });
      this.particles.update(dt);
      this.texts.update(dt);
      this.pools.rings.each((r) => r.update(dt));

      /* HUD (throttled) */
      if (this.hooks.onHUD && now - this.lastHudAt > 0.1) {
        this.lastHudAt = now;
        this.hooks.onHUD(this.hudState());
      }
    }

    spawnEvent(ev) {
      const L = this.world.L;
      switch (ev.type) {
        case 'TAP': case 'SPECIAL': {
          const t = this.pools.targets.get();
          if (t.active) return;
          t.spawn(ev, this.now);
          break;
        }
        case 'HOLD': {
          const h = this.pools.holds.get();
          if (h.active) return;
          h.spawn(ev, this.now);
          break;
        }
        case 'HAZARD': {
          const h = this.pools.hazards.get();
          if (h.active) return;
          h.spawn(ev, this.now);
          break;
        }
        case 'PEAK': {
          const pk = this.pools.peaks.get();
          if (pk.active) return;
          pk.spawn(ev, this.now);
          if (this.hooks.onJudge) this.hooks.onJudge({ peakIncoming: true }, ev);
          break;
        }
        case 'GATE': {
          const g = this.pools.gates.get();
          if (g.active) return;
          g.spawn(ev); g.state = 'pending';
          break;
        }
        case 'WALL': {
          const w = this.pools.walls.get();
          if (w.active) return;
          w.spawn(ev); w.state = 'pending';
          break;
        }
      }
    }
    spawnOrbs(ev) {
      const L = this.world.L;
      const rng = U.mulberry32(ev.id * 7919 + 13);
      for (let i = 0; i < ev.count; i++) {
        const o = this.orbs.get();
        if (o.active) continue;
        o.spawn(L.cx + (rng() - 0.5) * L.botW * 0.7, L.h * (0.18 + rng() * 0.3), rng());
      }
    }

    hudState() {
      const sc = this.score;
      const an = this.song.analysis;
      return {
        state: this.state,
        score: Math.round(sc.displayScore),
        combo: sc.combo,
        mult: sc.multiplier(),
        accuracy: sc.accuracy(),
        flow: sc.flow,
        progress: clamp(this.now / an.duration, 0, 1),
        section: this.section ? this.section.type : null,
        climax: this.climax,
        adaptive: this.adaptive.state,
        zen: sc.zen
      };
    }

    finish() {
      if (this.finished) return;
      this.finished = true;
      this.state = 'finished';
      const res = this.score.results();
      res.mode = this.song.timeline.meta.modeName;
      res.difficulty = this.song.timeline.meta.diffLabel;
      res.songTitle = this.song.title;
      res.songSubtitle = this.song.subtitle || '';
      res.duration = this.song.analysis.duration;
      res.bpm = this.song.analysis.bpm;
      res.fingerprint = this.song.analysis.fingerprint;
      res.seed = this.song.timeline.meta.seed;
      res.eventsTotal = this.eventsTotal;
      res.eventsJudged = this.eventsJudged;
      res.completed = this.eventsJudged >= Math.max(1, this.eventsSpawned) && this.now > this.song.analysis.duration - 2;
      if (this.audio) this.audio.stop();
      if (this.hooks.onFinish) this.hooks.onFinish(res);
    }

    /* ============================ RENDER ============================ */
    render() {
      if (!this.ctx || !this.song) return;
      const ctx = this.ctx, L = this.world.L;
      const now = this.now;
      const meta = this.song.timeline.meta;
      const bands = this._lastBands;
      const freqData = this.audio && this.audio._freqData ? this.audio._freqData : null;

      const so = this.world.shakeOffset();
      ctx.save();
      ctx.translate(so.x, so.y);

      /* beat grid lines for the road */
      const an = this.song.analysis;
      const beatLines = [];
      const T = 60 / an.bpm;
      for (let i = Math.max(0, this.beatIdx - 1); i < Math.min(an.beats.length, this.beatIdx + 10); i++) {
        const b = an.beats[i];
        const p = 1 - (b.time - now) / (meta.approach * 1.15);
        if (p > -0.1 && p < 1.1) beatLines.push({ p: clamp(p, 0, 1), strong: b.downbeat });
      }

      this.world.drawBackground(ctx, { now, bands });
      this.world.drawRoad(ctx, {
        now, bands, beatLines, mode: meta.mode,
        pressedLanes: this.pressedLanes,
        showKeys: this.settings.showKeys && !this.world.zen
      });

      this.pools.rings.each((r) => r.draw(ctx, L));

      /* entities */
      if (meta.mode === 'flow') {
        this.pools.walls.each((w) => w.draw(ctx, L, now));
        this.pools.gates.each((g) => g.draw(ctx, L, now));
      } else {
        this.pools.hazards.each((h) => h.draw(ctx, L, now));
        this.pools.holds.each((h) => h.draw(ctx, L, now));
        this.pools.targets.each((t) => t.draw(ctx, L, now, this.settings.visualIntensity));
      }
      this.orbs.each((o) => o.draw(ctx, now));
      this.pools.peaks.each((pk) => pk.draw(ctx, L, now, this.settings.visualIntensity));

      /* player */
      const orbX = meta.mode === 'flow' ? L.flowX(this.flowCol + 0.5, 1) : L.cx;
      this.world.drawOrb(ctx, {
        bands, combo: this.score.combo, mult: this.score.multiplier(),
        flow: this.score.flow, orbX,
        orbColor: this.climax ? '#ffd0a0' : (this.world.zen ? '#c9f0ff' : '#9be8ff')
      });

      this.texts.draw(ctx);
      this.particles.draw(ctx);
      this.world.drawForeground(ctx, { now, bands }, freqData);

      ctx.restore();
    }
  }

  RS.GameEngine = GameEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = GameEngine;
})();

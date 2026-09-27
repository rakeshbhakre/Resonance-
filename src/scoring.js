/* ============================================================
 * RESONANCE — scoring.js
 * ScoreManager (score / combo / multiplier / flow energy / judgments)
 * AdaptiveDirector (runtime difficulty adaptation)
 *
 * Pure logic — no DOM, fully testable in Node.
 * ============================================================ */
(function () {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const RS = G.RS = G.RS || {};
  const U = RS.util;
  const clamp = U.clamp;

  /* Timing windows (seconds) — configurable. */
  const WINDOWS = { perfect: 0.05, great: 0.10, good: 0.18 };

  /* Combo → multiplier tiers (configurable) */
  const COMBO_TIERS = [
    { combo: 100, mult: 5, label: 'CLIMAX' },
    { combo: 50, mult: 4, label: 'IN THE ZONE' },
    { combo: 25, mult: 3, label: 'ON FIRE' },
    { combo: 10, mult: 2, label: 'COMBO ×2' }
  ];

  function gradeOffset(dt, scale) {
    const a = Math.abs(dt);
    if (a <= WINDOWS.perfect * scale) return 'perfect';
    if (a <= WINDOWS.great * scale) return 'great';
    if (a <= WINDOWS.good * scale) return 'good';
    return 'miss';
  }

  const GRADE_POINTS = { perfect: 100, great: 70, good: 40, miss: 0 };
  const ACC_WEIGHT = { perfect: 1, great: 0.7, good: 0.4, miss: 0 };

  class ScoreManager {
    constructor(opts) {
      opts = opts || {};
      this.zen = !!opts.zen;
      this.windowScale = opts.windowScale || 1;
      this.reset();
    }
    reset() {
      this.score = 0;
      this.combo = 0; this.maxCombo = 0;
      this.flow = 60;                     /* 0..100 energy */
      this.counts = { perfect: 0, great: 0, good: 0, miss: 0 };
      this.judged = 0; this.accWeight = 0;
      this.offsets = [];                  /* signed, seconds */
      this.chainProgress = {};            /* chainId → hits */
      this.peakHits = 0; this.peakTotal = 0;
      this.orbs = 0; this.dodges = 0; this.hazardHits = 0;
      this.holdTicks = 0;
      this.lastMilestone = 0;
      this.displayScore = 0;              /* lerped for HUD */
      this.climaxBonus = false;
    }
    setWindowScale(s) { this.windowScale = s; }

    comboTier() {
      for (const t of COMBO_TIERS) if (this.combo >= t.combo) return t;
      return null;
    }
    multiplier() {
      if (this.zen) return 1;
      const tier = this.comboTier();
      let m = tier ? tier.mult : 1;
      if (this.flow < 22) m = Math.max(1, m - 1);       /* low energy: dampen */
      else if (this.flow >= 90 && this.combo >= 10) m += 1; /* flow state: boost */
      if (this.climaxBonus) m = Math.round(m * 1.3);
      return clamp(m, 1, 8);
    }

    _milestone() {
      for (const t of COMBO_TIERS) {
        if (this.combo === t.combo && this.lastMilestone < t.combo) {
          this.lastMilestone = t.combo;
          return t;
        }
      }
      return null;
    }

    /* Core judgment for TAP / SPECIAL / HOLD-start / GATE */
    judge(dt, ev) {
      const grade = gradeOffset(dt, this.windowScale);
      this.judged++;
      this.accWeight += ACC_WEIGHT[grade];
      if (grade !== 'miss') this.offsets.push(dt);
      if (grade === 'miss') return this._miss(ev);
      this.counts[grade]++;
      const base = GRADE_POINTS[grade] * (ev && ev.scoreMul ? ev.scoreMul : 1);
      const gain = Math.round(base * this.multiplier());
      this.score += gain;
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
      this.flow = clamp(this.flow + (grade === 'perfect' ? 2.0 : grade === 'great' ? 1.2 : 0.4), 0, 100);
      /* chain tracking */
      let chainDone = false;
      if (ev && ev.chain) {
        const c = ev.chain;
        this.chainProgress[c.id] = (this.chainProgress[c.id] || 0) + 1;
        if (c.last && this.chainProgress[c.id] >= c.len) {
          chainDone = true;
          this.score += 200 * this.multiplier();
        }
      }
      return { grade, gain, combo: this.combo, mult: this.multiplier(), off: dt, milestone: this._milestone(), chainDone };
    }
    _miss(ev) {
      this.counts.miss++;
      let chainBroken = false;
      if (ev && ev.chain) { this.chainProgress[ev.chain.id] = -99; chainBroken = true; }
      if (this.zen) return { grade: 'pass', gain: 0, combo: this.combo, mult: 1, milestone: null, zenPass: true };
      this.combo = 0;
      this.flow = clamp(this.flow - 9, 0, 100);
      return { grade: 'miss', gain: 0, combo: 0, mult: 1, milestone: null, chainBroken };
    }

    /* HOLD completed fully */
    holdComplete(ev, startGrade) {
      const gain = Math.round(50 * this.multiplier());
      this.score += gain;
      this.holdTicks++;
      return { grade: 'perfect', gain, hold: true };
    }
    /* HOLD released early — prorated by held fraction */
    holdEarly(ev, fraction, startGrade) {
      const gain = Math.round(50 * fraction * this.multiplier());
      this.score += gain;
      return { grade: fraction > 0.7 ? 'great' : 'good', gain, hold: true, early: true };
    }
    holdTick() {
      this.score += Math.round(10);
      this.holdTicks++;
    }

    peakHit() {
      this.peakHits++;
      const gain = Math.round(500 * this.multiplier());
      this.score += gain;
      this.flow = clamp(this.flow + 6, 0, 100);
      return { gain };
    }
    peakMiss() { /* no penalty — peaks are gifts */ }
    orbCollect() {
      this.orbs++;
      this.score += 25;
      return { gain: 25 };
    }
    dodgeSuccess() {
      this.dodges++;
      this.score += 30;
      return { gain: 30 };
    }
    hazardHit() {
      this.hazardHits++;
      if (this.zen) return { gain: 0 };
      this.score = Math.max(0, this.score - 150);
      this.combo = 0;
      this.flow = clamp(this.flow - 16, 0, 100);
      return { gain: -150 };
    }
    tick(dt) {
      if (!this.zen) this.flow = clamp(this.flow - 0.22 * dt, 0, 100);
      /* display score chases real score */
      this.displayScore += (this.score - this.displayScore) * Math.min(1, dt * 10);
      if (Math.abs(this.score - this.displayScore) < 1) this.displayScore = this.score;
    }

    accuracy() {
      return this.judged ? this.accWeight / this.judged : 1;
    }
    avgOffsetMs() {
      if (!this.offsets.length) return 0;
      let s = 0; for (const o of this.offsets) s += o;
      return (s / this.offsets.length) * 1000;
    }
    offsetStdMs() {
      if (this.offsets.length < 2) return 0;
      const m = this.avgOffsetMs();
      let s = 0; for (const o of this.offsets) s += (o * 1000 - m) * (o * 1000 - m);
      return Math.sqrt(s / this.offsets.length);
    }

    grade() {
      const a = this.accuracy() * 100;
      if (a >= 97) return 'SS';
      if (a >= 93) return 'S';
      if (a >= 86) return 'A';
      if (a >= 75) return 'B';
      if (a >= 60) return 'C';
      return 'D';
    }
    stars() {
      const a = this.accuracy() * 100;
      if (a >= 92) return 5;
      if (a >= 82) return 4;
      if (a >= 70) return 3;
      if (a >= 55) return 2;
      return 1;
    }
    results() {
      return {
        score: this.score,
        accuracy: this.accuracy(),
        grade: this.grade(),
        stars: this.stars(),
        maxCombo: this.maxCombo,
        counts: Object.assign({}, this.counts),
        judged: this.judged,
        avgOffsetMs: this.avgOffsetMs(),
        offsetStdMs: this.offsetStdMs(),
        peakHits: this.peakHits, peakTotal: this.peakTotal,
        orbs: this.orbs, dodges: this.dodges, hazardHits: this.hazardHits,
        holdTicks: this.holdTicks,
        maxMultiplier: this.multiplier()
      };
    }
  }

  /* ---------------- Adaptive difficulty ---------------- */
  class AdaptiveDirector {
    constructor(enabled) {
      this.enabled = enabled;
      this.reset();
    }
    reset() {
      this.state = 'baseline';
      this.since = 0;
      this.cullTier = 2;        /* events with tier >= this get culled in 'assist' */
      this.activeCullTier = 99; /* 99 = cull nothing */
      this.windowScale = 1;
      this.extras = false;
      this.recent = [];         /* {t, grade} */
    }
    onJudgment(grade, t) {
      if (!this.enabled) return;
      this.recent.push({ t, grade });
    }
    tick(now) {
      if (!this.enabled) return;
      while (this.recent.length && now - this.recent[0].t > 18) this.recent.shift();
      if (this.recent.length < 10) return;
      let w = 0, miss = 0;
      for (const j of this.recent) {
        w += ACC_WEIGHT[j.grade] || 0;
        if (j.grade === 'miss') miss++;
      }
      const acc = w / this.recent.length, missRate = miss / this.recent.length;
      if (acc < 0.45 || missRate > 0.28) {
        if (this.state !== 'assist') { this.state = 'assist'; this.since = now; }
      } else if (acc > 0.85 && missRate < 0.06) {
        if (this.state !== 'excite') { this.state = 'excite'; this.since = now; }
      } else if (this.state !== 'baseline' && now - this.since > 14) {
        this.state = 'baseline'; this.since = now;
      }
      /* hysteresis: stay in a state a while before switching */
      if (this.state === 'assist' && now - this.since > 20 && acc > 0.6) { this.state = 'baseline'; this.since = now; }
      this.activeCullTier = this.state === 'assist' ? this.cullTier : 99;
      this.windowScale = this.state === 'assist' ? 1.18 : (this.state === 'excite' ? 0.94 : 1);
      this.extras = this.state === 'excite';
    }
  }

  RS.Scoring = { WINDOWS, COMBO_TIERS, gradeOffset, ScoreManager, AdaptiveDirector };
  if (typeof module !== 'undefined' && module.exports) module.exports = RS.Scoring;
})();

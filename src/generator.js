/* ============================================================
 * RESONANCE — generator.js
 * GameplayGenerator: converts audio analysis into a deterministic
 * gameplay timeline.
 *
 *   Analysis → difficulty estimation → beat mapping → event
 *   generation (types, lanes, tiers) → validated timeline
 *
 * Determinism: seed = fingerprint ⊕ mode ⊕ difficulty → mulberry32.
 * The same song always produces the same base timeline (replays are
 * fair). Tier-3 "extras" and tier-2 "fill" can be culled/activated at
 * runtime by the adaptive difficulty director without regenerating.
 * ============================================================ */
(function () {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const RS = G.RS = G.RS || {};
  const U = RS.util;
  const clamp = U.clamp, lerp = U.lerp;

  /* ---------------- configuration ---------------- */
  const DIFFS = {
    easy: { density: 0.5, sub: 0.04, chords: 0.05, holds: 0.22, hazards: 0, chains: 0, windowScale: 1.25, label: 'EASY', cap: 2.4 },
    normal: { density: 0.72, sub: 0.2, chords: 0.16, holds: 0.34, hazards: 0.035, chains: 0.16, windowScale: 1.0, label: 'NORMAL', cap: 3.4 },
    hard: { density: 1.0, sub: 0.38, chords: 0.3, holds: 0.44, hazards: 0.075, chains: 0.3, windowScale: 0.9, label: 'HARD', cap: 4.4 },
    extreme: { density: 1.25, sub: 0.6, chords: 0.44, holds: 0.5, hazards: 0.12, chains: 0.45, windowScale: 0.8, label: 'EXTREME', cap: 5.4 }
  };
  const SECTION_MULT = { intro: 0.5, verse: 0.82, build: 1.02, chorus: 1.14, drop: 1.28, break: 0.22, outro: 0.55 };
  const MODES = {
    rhythm: { name: 'Rhythm', desc: 'Classic beat synchronization', eventSet: 'full' },
    flow: { name: 'Flow', desc: 'Steer through a music-driven highway', eventSet: 'flow' },
    zen: { name: 'Zen', desc: 'No punishment. Pure immersion', eventSet: 'zen' },
    challenge: { name: 'Challenge', desc: 'Tighter, denser, leaderboard rules', eventSet: 'full', densityMul: 1.28, windowMul: 0.75, hazardMul: 1.35, adaptive: false }
  };

  /* ---------------- difficulty estimation ---------------- */
  function estimateDifficulty(an) {
    const norm = (v, a, b) => clamp((v - a) / (b - a), 0, 1);
    const beatsPerSec = an.beats.length / Math.max(1, an.duration);
    const score = 0.30 * norm(an.bpm, 62, 178) +
      0.32 * norm(an.onsetDensity, 1.2, 5) +
      0.18 * an.intensity +
      0.20 * norm(beatsPerSec, 0.9, 3.1);
    let key = 'easy';
    if (score >= 0.68) key = 'extreme';
    else if (score >= 0.52) key = 'hard';
    else if (score >= 0.34) key = 'normal';
    return { key, score };
  }

  /* ---------------- helpers ---------------- */
  function curveAt(curve, fps, t) {
    const i = clamp(Math.round(t * fps), 0, curve.length - 1);
    return curve[i];
  }
  function sustainLength(an, t, e0) {
    /* how long energy stays ≥ 75% of its value at t (min level 0.3) */
    const { energyCurve, fps } = an;
    const floor = Math.max(0.3, 0.75 * e0);
    let end = t;
    for (let tt = t; tt < Math.min(an.duration, t + 4); tt += 0.1) {
      if (curveAt(energyCurve, fps, tt) >= floor) end = tt;
      else if (tt > end + 0.25) break;
    }
    return end - t;
  }

  /* ---------------- main generator ---------------- */
  function generate(an, opts) {
    opts = opts || {};
    const mode = MODES[opts.mode] ? opts.mode : 'rhythm';
    const modeCfg = MODES[mode];
    let diffKey = opts.difficulty && DIFFS[opts.difficulty] ? opts.difficulty : 'auto';
    const est = estimateDifficulty(an);
    if (diffKey === 'auto') diffKey = est.key;
    const diff = Object.assign({}, DIFFS[diffKey]);
    if (modeCfg.densityMul) diff.density = Math.min(1.35, diff.density * modeCfg.densityMul);
    if (modeCfg.hazardMul) diff.hazards = diff.hazards * modeCfg.hazardMul;
    const windowScale = diff.windowScale * (modeCfg.windowMul || 1);

    const seed = U.fnv1a(an.fingerprint + '|' + mode + '|' + diffKey + '|' + (opts.modifiers || ''));
    const rng = U.mulberry32(seed);

    const beats = an.beats;
    const T = 60 / an.bpm;
    const approach = clamp(4 * T, 1.15, 2.6);
    const leadIn = Math.min(Math.max(2.6, approach + 0.5), Math.max(2.0, an.duration * 0.4));
    const zen = mode === 'zen';
    const flow = mode === 'flow';

    const events = [];
    let idCounter = 1;
    const laneEnd = [-9, -9, -9, -9, -9]; /* last end time per lane */
    let chainId = 0, chainRemaining = 0, chainLen = 0, chainBeat = 0;
    let lastPeakTime = -99, lastHazard = -99, lastOrb = -99;
    let lastLane = 3, dir = 1;
    let altFlip = 0;

    /* lane pattern engine */
    function freeLanes(t, gap) {
      const out = [];
      for (let l = 0; l < 4; l++) if (laneEnd[l] + gap <= t) out.push(l);
      return out;
    }
    function pickLane(t, dur, preferOuter) {
      const gap = Math.max(0.3, T * 0.6);
      let cands = freeLanes(t, gap + dur);
      if (!cands.length) cands = freeLanes(t, Math.max(0.24, T * 0.42) + dur);
      if (!cands.length) return -1;
      let lane;
      const r = rng();
      if (preferOuter) {
        const outer = cands.filter((l) => l === 0 || l === 3);
        if (outer.length && r < 0.72) lane = outer[Math.floor(rng() * outer.length)];
      }
      if (lane === undefined) {
        if (cands.length >= 3 && r < 0.42) {
          /* alternate hand groups: L(0,1) ↔ R(2,3) */
          altFlip ^= 1;
          const group = altFlip ? [0, 1] : [2, 3];
          const pool = cands.filter((l) => group.indexOf(l) >= 0);
          lane = pool.length ? pool[Math.floor(rng() * pool.length)] : cands[Math.floor(rng() * cands.length)];
        } else if (r < 0.72) {
          /* adjacent walk */
          const step = dir > 0 ? 1 : -1;
          let next = lastLane + step;
          if (next > 3) { dir = -1; next = lastLane - 1; }
          if (next < 0) { dir = 1; next = lastLane + 1; }
          lane = cands.indexOf(next) >= 0 ? next : cands[Math.floor(rng() * cands.length)];
        } else {
          lane = cands[Math.floor(rng() * cands.length)];
        }
      }
      return lane;
    }
    function pushEvent(e) {
      e.id = idCounter++;
      events.push(e);
      if (e.lane !== undefined && e.type !== 'PEAK' && e.type !== 'ORB') {
        if (e.type === 'HAZARD') laneEnd[e.lane] = e.time + Math.max(0.8, 1.1 * T); /* reserve lane */
        else laneEnd[e.lane] = e.time + (e.dur || 0) + 0.02;
      }
      return e;
    }

    /* map analysis peaks to nearest beat (cooldown) */
    const peakBeats = new Set();
    for (const p of (an.peaks || [])) {
      let bi = -1, bd = 1;
      for (let i = 0; i < beats.length; i++) {
        const d = Math.abs(beats[i].time - p.time);
        if (d < bd) { bd = d; bi = i; }
      }
      if (bi >= 0 && bd <= 0.5 && beats[bi].time - lastPeakTime > 14) {
        peakBeats.add(bi);
        lastPeakTime = beats[bi].time;
      }
    }
    lastPeakTime = -99;

    /* drop starts for climax tracking */
    const dropStarts = (an.drops || []).map((d) => d.time);

    /* ============ RHYTHM / ZEN / CHALLENGE ============ */
    if (!flow) {
      for (let i = 0; i < beats.length; i++) {
        const b = beats[i];
        const t = b.time;
        if (t < leadIn || t > an.duration - 1.2) continue;
        const secMult = SECTION_MULT[b.section] !== undefined ? SECTION_MULT[b.section] : 0.85;
        const eLocal = curveAt(an.energyCurve, an.fps, t);
        const bassLocal = curveAt(an.bassEnergy, an.fps, t);
        const energyFactor = zen ? 0.9 : (0.68 + 0.62 * eLocal);

        /* --- chain sequence state (build sections) --- */
        if (chainRemaining > 0) chainRemaining--;

        /* --- PEAK events --- */
        if (peakBeats.has(i) && t - lastPeakTime > 14) {
          lastPeakTime = t;
          pushEvent({
            time: t, type: 'PEAK', tier: 0, strength: 1, intensity: eLocal,
            section: b.section, dur: 0
          });
          continue; /* peak beat carries only the peak */
        }

        /* --- density roll --- */
        let p = diff.density * secMult * energyFactor;
        if (zen) p = 0.34 * Math.max(0.6, secMult + 0.35) * energyFactor;
        let want = 0;
        if (p >= 1) { want = 1; if (p - 1 > rng()) want = 2; }
        else if (rng() < p) want = 1;

        /* chain trigger in build sections */
        if (!zen && diff.chains > 0 && b.section === 'build' && chainRemaining === 0 && rng() < diff.chains * 0.35) {
          chainLen = 4 + Math.floor(rng() * 5);
          chainRemaining = chainLen;
          chainId++;
          chainBeat = 0;
        }

        for (let k = 0; k < want; k++) {
          /* --- event type --- */
          let type = 'TAP', dur = 0, tier = 1, scoreMul = 1;

          const sus = sustainLength(an, t, eLocal);
          const sustained = sus > Math.max(0.9, 1.4 * T) && curveAt(an.midEnergy, an.fps, t + 0.3) > 0.42;

          if (k === 0 && b.downbeat && b.strength > 0.62 && !zen) {
            type = 'SPECIAL'; scoreMul = 1.5; tier = 0;
          } else if (k === 0 && sustained && rng() < diff.holds) {
            type = 'HOLD';
            dur = clamp(Math.round(sus / T) * T, T, 2.2 * T);
            if (zen) dur = Math.max(dur, 1.6 * T);
            tier = 1;
          } else if (chainRemaining > 0 && chainBeat < chainLen) {
            type = 'TAP'; tier = 1;
          } else {
            tier = (k > 0) ? 2 : 1;
          }

          const lane = pickLane(t, dur, type === 'SPECIAL');
          if (lane < 0) continue;
          const ev = {
            time: t, type, lane, dur, tier, strength: b.strength, intensity: eLocal,
            section: b.section, scoreMul, bass: bassLocal
          };
          if (chainRemaining > 0 && type === 'TAP' && chainBeat < chainLen) {
            ev.chain = { id: chainId, len: chainLen, idx: chainBeat, last: chainBeat === chainLen - 1 };
            chainBeat++;
            if (ev.chain.last) ev.scoreMul = 1.35;
          }
          pushEvent(ev);
          lastLane = lane;
        }

        /* --- sub-beat (8th) targets in energetic sections --- */
        if (!zen && diff.sub > 0 && (b.section === 'chorus' || b.section === 'drop' || b.section === 'build') &&
            an.bpm < 168 && b.strength > 0.4 && rng() < diff.sub * (0.5 + 0.5 * eLocal)) {
          const t2 = t + T / 2;
          const lane2 = pickLane(t2, 0, false);
          if (lane2 >= 0) {
            pushEvent({ time: t2, type: 'TAP', lane: lane2, dur: 0, tier: 2, strength: b.strength * 0.75, intensity: eLocal, section: b.section, scoreMul: 1, bass: bassLocal });
            lastLane = lane2;
          }
        }

        /* --- hazards (dodge) --- */
        if (!zen && diff.hazards > 0 && t - lastHazard > Math.max(6, 8 * T) && t > leadIn + 6) {
          const hz = diff.hazards * (b.section === 'drop' ? 2.2 : b.section === 'chorus' ? 1.4 : 0.55);
          if (rng() < hz) {
            /* pick a lane with no events nearby ±(0.6 or 1.5T) */
            const clear = Math.max(0.6, 1.4 * T);
            const cands = [];
            for (let l = 0; l < 4; l++) {
              const busy = events.some((e) => Math.abs(e.time - t) < clear && (e.lane === l || e.type === 'PEAK'));
              if (!busy && laneEnd[l] + clear <= t) cands.push(l);
            }
            if (cands.length) {
              const lane = cands[Math.floor(rng() * cands.length)];
              pushEvent({ time: t, type: 'HAZARD', lane, dur: 0, tier: 2, strength: b.strength, intensity: eLocal, section: b.section, scoreMul: 0, bass: bassLocal });
              lastHazard = t;
            }
          }
        }

        /* --- orbs: breaks, intros, quiet moments, zen abundance --- */
        const orbWindow = zen ? Math.max(3, 4 * T) : 6;
        const quietish = eLocal < 0.4 || b.section === 'break' || b.section === 'intro';
        if (t - lastOrb > orbWindow && (zen || (quietish && rng() < 0.5))) {
          pushEvent({ time: t, type: 'ORB', count: 3 + Math.floor(rng() * 4), tier: zen ? 1 : 1, strength: 0.3, intensity: eLocal, section: b.section, dur: 0 });
          lastOrb = t;
        }
      }

      /* tier-3 extras: activated by the adaptive director when the player is
         excelling (deterministic, precomputed) */
      for (const e of events.slice()) {
        if (e.type === 'SPECIAL' && rng() < 0.55) {
          const lane = pickLane(e.time, 0, false);
          if (lane >= 0 && lane !== e.lane) {
            events.push({
              id: idCounter++, time: e.time, type: 'TAP', lane, dur: 0, tier: 3,
              strength: e.strength * 0.8, intensity: e.intensity, section: e.section, scoreMul: 1, bass: e.bass, extra: true
            });
          }
        }
      }
    } else {
      /* ============ FLOW MODE ============ */
      const cols = 5;
      let col = 2;
      let lastWall = -99;
      for (let i = 0; i < beats.length; i++) {
        const b = beats[i];
        const t = b.time;
        if (t < leadIn || t > an.duration - 1.2) continue;
        const secMult = SECTION_MULT[b.section] !== undefined ? SECTION_MULT[b.section] : 0.85;
        const eLocal = curveAt(an.energyCurve, an.fps, t);
        const p = diff.density * secMult * (0.75 + 0.5 * eLocal);

        if (peakBeats.has(i)) {
          pushEvent({ time: t, type: 'PEAK', tier: 0, strength: 1, intensity: eLocal, section: b.section, dur: 0 });
          lastPeakTime = t;
          continue;
        }
        if (rng() < p) {
          /* gate: random-walk column, avoid extreme jumps */
          const r = rng();
          if (r < 0.3 && col > 0) col--;
          else if (r < 0.6 && col < cols - 1) col++;
          pushEvent({
            time: t, type: 'GATE', lane: col, tier: 1, strength: b.strength, intensity: eLocal,
            section: b.section, dur: 0, gold: b.downbeat && b.strength > 0.65
          });
        }
        /* walls on strong beats in intense sections */
        if (b.downbeat && (b.section === 'drop' || b.section === 'chorus') && t - lastWall > Math.max(2.4, 4 * T) && rng() < 0.5) {
          const span = 2 + Math.floor(rng() * 2); /* 2-3 columns */
          const start = Math.floor(rng() * (cols - span + 1));
          /* never wall the gate column */
          const lanes = [];
          for (let l = start; l < start + span; l++) lanes.push(l);
          const lastGate = events.length ? events[events.length - 1] : null;
          if (!lastGate || lanes.indexOf(lastGate.lane) < 0 || t - lastGate.time > T * 0.5) {
            pushEvent({ time: t, type: 'WALL', lanes, tier: 2, strength: b.strength, intensity: eLocal, section: b.section, dur: Math.max(0.3, T * 0.5) });
            lastWall = t;
          }
        }
        /* ribbon orbs in calmer parts */
        if (t - lastOrb > Math.max(3, 5 * T) && (b.section === 'verse' || b.section === 'intro' || b.section === 'break') && rng() < 0.6) {
          pushEvent({ time: t, type: 'ORB', count: 4 + Math.floor(rng() * 4), tier: 1, strength: 0.3, intensity: eLocal, section: b.section, dur: 0 });
          lastOrb = t;
        }
      }
    }

    /* sort + ids + global density cap */
    events.sort((a, b) => a.time - b.time);
    /* enforce a hard events-per-second cap over rolling 4 s windows */
    const cap = diff.cap;
    const kept = [];
    const windowEvents = [];
    for (const e of events) {
      if (e.type === 'ORB') { kept.push(e); continue; }
      while (windowEvents.length && e.time - windowEvents[0].time > 4) windowEvents.shift();
      if (windowEvents.length >= cap * 4 && e.tier >= 2) continue;
      windowEvents.push(e);
      kept.push(e);
    }
    kept.forEach((e, i) => { e.id = i + 1; });

    const stats = validate(kept, an, T);
    const counted = kept.filter((e) => e.type !== 'ORB');
    return {
      events: kept,
      meta: {
        mode, modeName: modeCfg.name, diffKey, diffLabel: diff.label,
        estimated: est, estimatedLabel: DIFFS[est.key].label,
        windowScale, approach, leadIn, seed: U.hex(seed, 8),
        adaptive: modeCfg.adaptive !== false && !zen,
        eventCount: counted.length,
        eventsPerSec: counted.length / Math.max(1, an.duration),
        dropStarts, stats
      }
    };
  }

  /* ---------------- validation (used by tests + engine sanity) ---------------- */
  function validate(events, an, T) {
    const problems = [];
    const laneEnd = [-9, -9, -9, -9, -9];
    for (const e of events) {
      if (!isFinite(e.time) || e.time < 0) problems.push('bad time @' + e.id);
      if (e.lane !== undefined && (e.lane < 0 || e.lane > 4)) problems.push('bad lane @' + e.id);
      if (e.type === 'HOLD' && (!e.dur || e.dur <= 0)) problems.push('bad hold @' + e.id);
      if (e.lane !== undefined && e.type !== 'PEAK' && e.type !== 'ORB' && e.type !== 'WALL') {
        const minGap = Math.max(0.22, T * 0.5);
        if (e.time < laneEnd[e.lane] + minGap - 1e-3) problems.push(`lane ${e.lane} overlap @t=${e.time.toFixed(2)}`);
        laneEnd[e.lane] = Math.max(laneEnd[e.lane], e.time + (e.dur || 0));
      }
    }
    /* events sorted? */
    for (let i = 1; i < events.length; i++) {
      if (events[i].time < events[i - 1].time - 1e-6) { problems.push('unsorted @' + i); break; }
    }
    return { problems: problems.slice(0, 12), problemCount: problems.length };
  }

  RS.Generator = { generate, estimateDifficulty, DIFFS, MODES, SECTION_MULT };
  if (typeof module !== 'undefined' && module.exports) module.exports = RS.Generator;
})();

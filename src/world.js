/* ============================================================
 * RESONANCE — world.js
 * Music-reactive environment: starfield, perspective highway with
 * beat-synced grid lines, section themes, live visualizer, shake,
 * climax transformation, player orb.
 * ============================================================ */
(function () {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const RS = G.RS = G.RS || {};
  const U = RS.util;
  const { clamp, lerp, TAU, easeOutCubic } = U;
  const E = RS.Entities;

  /* Section themes — the world's mood follows song structure */
  const THEMES = {
    intro: { bg1: '#04060f', bg2: '#0a1030', lane: '#22d3ee', accent: '#3b6bff', glow: 0.5, star: 0.55 },
    verse: { bg1: '#030711', bg2: '#07203a', lane: '#22d3ee', accent: '#00d5ff', glow: 0.7, star: 0.85 },
    build: { bg1: '#070318', bg2: '#26093f', lane: '#a86bff', accent: '#c084fc', glow: 0.9, star: 1.2 },
    chorus: { bg1: '#0a0316', bg2: '#3a0a3a', lane: '#ff5ec4', accent: '#ff4fd8', glow: 1.0, star: 1.35 },
    drop: { bg1: '#150407', bg2: '#4a120c', lane: '#ff8a3d', accent: '#ff6b35', glow: 1.25, star: 1.8 },
    break: { bg1: '#05070c', bg2: '#131b24', lane: '#7fa8c0', accent: '#9db8d8', glow: 0.35, star: 0.35 },
    outro: { bg1: '#04060f', bg2: '#0a1428', lane: '#4f8fd0', accent: '#6fa8e0', glow: 0.45, star: 0.4 }
  };

  class World {
    constructor() {
      this.L = null;
      this.stars = [];
      this.dust = [];
      this.theme = this._copyTheme(THEMES.verse);
      this.targetThemeName = 'verse';
      this.shakeMag = 0;
      this.climax = 0;          /* 0..1 climacticness */
      this.zen = false;
      this.beat = { phase: 0, strength: 0, downbeat: false };
      this.settings = { visualIntensity: 1, reducedMotion: false };
      this._t = 0;
      this._grid = [];
    }
    _copyTheme(t) {
      return {
        bg1: U.hexToRgb(t.bg1), bg2: U.hexToRgb(t.bg2), lane: U.hexToRgb(t.lane),
        accent: U.hexToRgb(t.accent), glow: t.glow, star: t.star
      };
    }
    resize(w, h) {
      this.L = this._layout(w, h);
      /* starfield */
      const n = Math.round(clamp(w * h / 12000, 60, 160) * (this.settings.visualIntensity >= 1 ? 1 : 0.6));
      this.stars = [];
      for (let i = 0; i < n; i++) {
        this.stars.push({
          x: Math.random() * w, y: Math.random() * h,
          z: 0.2 + Math.random() * 0.8, tw: Math.random() * TAU
        });
      }
    }
    _layout(w, h) {
      const L = {};
      L.w = w; L.h = h;
      L.cx = w / 2;
      L.vpY = h * 0.13;
      L.hitY = h * 0.8;
      L.orbY = h * 0.845;
      L.botW = Math.min(w * 0.92, h * 1.1);
      L.targetR = clamp(w * 0.034, 14, 34);
      L.approach = 2;
      L.yAt = (p) => lerp(L.vpY + (h - L.vpY) * 0.06, L.hitY, Math.pow(clamp(p, 0, 1), 1.3));
      const halfWAt = (y) => (L.botW / 2) * clamp((y - L.vpY) / (h - L.vpY), 0, 1.35);
      L.laneX = (lane, p) => {
        const y = L.yAt(p);
        const hw = halfWAt(y);
        return L.cx - hw + (lane + 0.5) * (2 * hw / 4);
      };
      L.flowX = (col, p) => {
        const y = L.yAt(p);
        const hw = halfWAt(y);
        return L.cx - hw + col * (2 * hw / 5);
      };
      return L;
    }

    setSection(name, now) {
      if (THEMES[name]) this.targetThemeName = name;
    }
    addShake(mag) {
      if (this.settings.reducedMotion) return;
      this.shakeMag = Math.min(18, this.shakeMag + mag);
    }
    shakeOffset() {
      if (this.shakeMag < 0.3) return { x: 0, y: 0 };
      return { x: (Math.random() - 0.5) * this.shakeMag, y: (Math.random() - 0.5) * this.shakeMag };
    }

    update(dt, st) {
      /* st: {now, bands, beat, combo, flow, climax, zen, energyCurve, bpm, sections} */
      const L = this.L;
      this._t += dt;
      this.zen = !!st.zen;
      this.climax = lerp(this.climax, st.climax ? 1 : 0, Math.min(1, dt * 2.2));
      this.beat = st.beat || this.beat;

      /* theme lerp */
      const target = THEMES[this.targetThemeName] || THEMES.verse;
      const k = Math.min(1, dt * 1.6);
      this.theme.bg1 = U.lerpRgb(this.theme.bg1, U.hexToRgb(target.bg1), k);
      this.theme.bg2 = U.lerpRgb(this.theme.bg2, U.hexToRgb(target.bg2), k);
      this.theme.lane = U.lerpRgb(this.theme.lane, U.hexToRgb(target.lane), k);
      this.theme.accent = U.lerpRgb(this.theme.accent, U.hexToRgb(target.accent), k);
      this.theme.glow = lerp(this.theme.glow, target.glow, k);
      this.theme.star = lerp(this.theme.star, target.star, k);

      /* shake decay */
      this.shakeMag *= Math.pow(0.001, dt);

      /* starfield motion */
      const bands = st.bands || { bass: 0, mid: 0, high: 0, level: 0 };
      const starSpeed = (0.35 + this.theme.star * 0.55) * (1 + bands.level * 0.9) * (1 + this.climax * 0.9) * (this.zen ? 0.5 : 1);
      for (const s of this.stars) {
        s.y += (40 + s.z * 340) * starSpeed * dt;
        s.x += Math.sin(this._t * 0.3 + s.tw) * 8 * dt;
        if (s.y > L.h + 4) { s.y = -4; s.x = Math.random() * L.w; }
        if (s.x < -4) s.x += L.w + 8; else if (s.x > L.w + 4) s.x -= L.w + 8;
      }
    }

    /* ---------- background: gradient, horizon glow, stars ---------- */
    drawBackground(ctx, st) {
      const L = this.L, th = this.theme;
      const bands = st.bands || { bass: 0, mid: 0, high: 0, level: 0 };
      const grad = ctx.createLinearGradient(0, 0, 0, L.h);
      grad.addColorStop(0, U.rgbToCss(th.bg1));
      grad.addColorStop(0.55, U.rgbToCss(U.lerpRgb(th.bg1, th.bg2, 0.5)));
      grad.addColorStop(1, U.rgbToCss(th.bg2));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, L.w, L.h);

      /* horizon glow — breathes with bass */
      const hg = ctx.createRadialGradient(L.cx, L.vpY, 0, L.cx, L.vpY, L.w * (0.45 + bands.bass * 0.22));
      hg.addColorStop(0, U.rgbToCss(th.accent, (0.13 + bands.bass * 0.22) * th.glow * this.settings.visualIntensity));
      hg.addColorStop(1, U.rgbToCss(th.accent, 0));
      ctx.fillStyle = hg;
      ctx.fillRect(0, 0, L.w, L.h);

      /* climax wash */
      if (this.climax > 0.02) {
        ctx.fillStyle = `rgba(255,140,60,${0.05 * this.climax * this.settings.visualIntensity})`;
        ctx.fillRect(0, 0, L.w, L.h);
      }

      /* stars */
      const starAlpha = 0.5 * this.settings.visualIntensity;
      ctx.fillStyle = '#cfe8ff';
      for (const s of this.stars) {
        const tw = 0.5 + 0.5 * Math.sin(this._t * 3 + s.tw * 7) * (0.4 + bands.high * 0.8);
        ctx.globalAlpha = starAlpha * (0.25 + s.z * 0.55) * tw;
        const sz = s.z * 2.1;
        ctx.fillRect(s.x, s.y, sz, sz);
      }
      ctx.globalAlpha = 1;
    }

    /* ---------- the highway: lanes, beat grid, pads ---------- */
    drawRoad(ctx, st) {
      const L = this.L, th = this.theme;
      const mode = st.mode; /* 'rhythm' | 'flow' | 'zen' — passed inside st */
      const bands = st.bands || { bass: 0, mid: 0, high: 0, level: 0 };
      const beat = this.beat;
      const pulse = (0.5 + 0.5 * Math.cos(beat.phase * TAU)) * beat.strength;

      /* road body */
      const roadGrad = ctx.createLinearGradient(0, L.vpY, 0, L.h);
      roadGrad.addColorStop(0, U.rgbToCss(th.bg1, 0.4));
      roadGrad.addColorStop(1, U.rgbToCss(th.bg2, 0.75));
      ctx.fillStyle = roadGrad;
      ctx.beginPath();
      const hwTop = 2, hwBot = L.botW / 2 * 1.06;
      ctx.moveTo(L.cx - hwTop, L.vpY);
      ctx.lineTo(L.cx + hwTop, L.vpY);
      ctx.lineTo(L.cx + hwBot, L.h);
      ctx.lineTo(L.cx - hwBot, L.h);
      ctx.closePath();
      ctx.fill();

      /* lane separators */
      const nCols = mode === 'flow' ? 5 : 4;
      const hitHW = (L.botW / 2) * ((L.hitY - L.vpY) / (L.h - L.vpY));
      ctx.strokeStyle = U.rgbToCss(th.lane, 0.16 + pulse * 0.1);
      ctx.lineWidth = 1.5;
      for (let c = 0; c <= nCols; c++) {
        const xh = L.cx - hitHW + c * (2 * hitHW / nCols);
        ctx.beginPath();
        ctx.moveTo(lerp(L.cx, xh, 0.04), lerp(L.vpY, L.hitY, 0.04));
        const xh2 = L.cx - hwBot + c * (2 * hwBot / nCols);
        ctx.lineTo(lerp(xh, xh2, 1.6), L.h + 30);
        ctx.stroke();
      }

      /* beat grid lines scrolling down the road (locked to beat timeline) */
      if (st.beatLines && st.beatLines.length) {
        for (const bl of st.beatLines) {
          const p = bl.p;
          if (p < 0 || p > 1.05) continue;
          const y = L.yAt(p);
          const hw = (L.botW / 2) * clamp((y - L.vpY) / (L.h - L.vpY), 0, 1.35);
          const a = clamp(p * 1.6, 0, 1) * (bl.strong ? 0.5 : 0.24) * (1 - Math.pow(p, 6));
          ctx.strokeStyle = bl.strong ? U.rgbToCss(th.accent, a) : U.rgbToCss(th.lane, a * 0.7);
          ctx.lineWidth = bl.strong ? 2.2 : 1.2;
          ctx.beginPath();
          ctx.moveTo(L.cx - hw, y);
          ctx.lineTo(L.cx + hw, y);
          ctx.stroke();
        }
      }

      /* hit row pads */
      const padY = L.hitY;
      for (let c = 0; c < nCols; c++) {
        const x0 = L.cx - hitHW + c * (2 * hitHW / nCols);
        const x1 = x0 + 2 * hitHW / nCols;
        const pressed = st.pressedLanes && st.pressedLanes[c];
        const padGlow = pressed ? 0.85 : 0.22 + pulse * 0.14;
        /* pad color: the receptor row takes on the section's lane color as
           climaxes heat up (drops go hot). Falling notes keep their lane
           colors, so readability is unaffected. Quantized k keeps the glow
           sprite cache bounded. */
        const k = Math.round(clamp(this.climax, 0, 1) * 16) / 16;
        const padRgb = mode === 'flow' ? th.accent /* already {r,g,b} */
          : k > 0 ? U.lerpRgb(U.hexToRgb(E.LANE_COLORS[c]), U.hexToRgb((THEMES[this.targetThemeName] || THEMES.verse).lane), k)
            : U.hexToRgb(E.LANE_COLORS[c]);
        /* pad bar */
        ctx.fillStyle = U.rgbToCss(padRgb, pressed ? 0.5 : 0.16 + pulse * 0.08);
        ctx.beginPath();
        this._roundRect(ctx, x0 + 6, padY - 5, x1 - x0 - 12, 10, 5);
        ctx.fill();
        ctx.strokeStyle = U.rgbToCss(padRgb, padGlow);
        ctx.lineWidth = pressed ? 3 : 1.6;
        ctx.beginPath();
        this._roundRect(ctx, x0 + 6, padY - 5, x1 - x0 - 12, 10, 5);
        ctx.stroke();
        E.glow(ctx, (x0 + x1) / 2, padY, (x1 - x0) * 0.75, padRgb, pressed ? 0.5 : 0.16 + pulse * 0.08);
        /* key labels */
        if (mode !== 'flow' && st.showKeys) {
          ctx.font = `700 ${Math.round(clamp((x1 - x0) * 0.2, 11, 16))}px 'Segoe UI', system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = U.rgbToCss(padRgb, pressed ? 0.95 : 0.42);
          ctx.fillText(['A', 'S', 'D', 'F'][c], (x0 + x1) / 2, padY + 24);
        }
      }
    }
    _roundRect(ctx, x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    /* ---------- player orb ---------- */
    drawOrb(ctx, st) {
      const L = this.L;
      const bands = st.bands || { bass: 0, mid: 0, high: 0, level: 0 };
      const x = st.orbX !== undefined ? st.orbX : L.cx;
      const y = L.orbY;
      const bass = bands.bass;
      const R = L.targetR * (0.62 + bass * 0.5 + (st.combo > 25 ? 0.1 : 0));
      const col = st.orbColor || '#9be8ff';

      E.glow(ctx, x, y, R * 4.2, col, 0.5 + bass * 0.3);
      /* core */
      const coreGrad = ctx.createRadialGradient(x, y, 0, x, y, R);
      coreGrad.addColorStop(0, '#ffffff');
      coreGrad.addColorStop(0.45, col);
      coreGrad.addColorStop(1, U.rgbToCss(U.hexToRgb(col), 0.1));
      ctx.fillStyle = coreGrad;
      ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill();

      /* multiplier ring */
      const mult = st.mult || 1;
      if (mult > 1) {
        ctx.strokeStyle = mult >= 4 ? '#ffd24a' : mult >= 3 ? '#ff5ec4' : '#67e8f9';
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.arc(x, y, R * 1.5, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, (st.combo % 25) / 25));
        ctx.stroke();
        ctx.globalAlpha = 0.28;
        ctx.beginPath(); ctx.arc(x, y, R * 1.5, 0, TAU); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      /* flow meter */
      if (!this.zen) {
        const flow = clamp((st.flow || 0) / 100, 0, 1);
        ctx.strokeStyle = flow < 0.25 ? '#ff4d6a' : flow > 0.8 ? '#8affc1' : '#7fa8c0';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, R * 1.85, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * flow);
        ctx.stroke();
        ctx.globalAlpha = 0.18;
        ctx.beginPath();
        ctx.arc(x, y, R * 1.85, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    /* ---------- foreground: visualizer bars + vignette ---------- */
    drawForeground(ctx, st, freqData) {
      const L = this.L;
      const th = this.theme;
      const vi = this.settings.visualIntensity;

      /* live spectrum along the bottom edge */
      if (freqData && vi > 0.3) {
        const nBars = 40;
        const bw = L.w / nBars;
        ctx.globalAlpha = 0.28 * vi;
        for (let i = 0; i < nBars; i++) {
          const bin = 1 + Math.floor(Math.pow(i / nBars, 1.6) * 70);
          const v = freqData[bin] / 255;
          const hgt = v * v * L.h * 0.09 * (1 + this.climax * 0.7);
          ctx.fillStyle = i < 8 ? U.rgbToCss(th.accent) : U.rgbToCss(th.lane);
          ctx.fillRect(i * bw + 1, L.h - hgt, bw - 2, hgt);
        }
        ctx.globalAlpha = 1;
      }

      /* beat vignette pulse */
      const beat = this.beat;
      const pulse = Math.pow(1 - beat.phase, 2.2) * beat.strength * (this.settings.reducedMotion ? 0.35 : 1);
      if (pulse > 0.02) {
        const vg = ctx.createRadialGradient(L.cx, L.h * 0.5, L.h * 0.3, L.cx, L.h * 0.5, L.h * 0.85);
        vg.addColorStop(0, 'rgba(0,0,0,0)');
        vg.addColorStop(1, U.rgbToCss(th.accent, (0.16 + 0.12 * this.climax) * pulse * vi));
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, L.w, L.h);
      }
      /* permanent subtle vignette */
      const vg2 = ctx.createRadialGradient(L.cx, L.h * 0.45, L.h * 0.4, L.cx, L.h * 0.5, L.h * 0.95);
      vg2.addColorStop(0, 'rgba(0,0,0,0)');
      vg2.addColorStop(1, 'rgba(0,0,6,0.5)');
      ctx.fillStyle = vg2;
      ctx.fillRect(0, 0, L.w, L.h);
    }
  }

  RS.World = { World, THEMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = RS.World;
})();

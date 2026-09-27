/* ============================================================
 * RESONANCE — entities.js
 * Pooled gameplay objects + rendering: targets, holds, hazards,
 * orbs, peaks, gates/walls, particles, floating text, beat rings.
 * Zero per-frame allocation in steady state.
 * ============================================================ */
(function () {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const RS = G.RS = G.RS || {};
  const U = RS.util;
  const { clamp, lerp, TAU, easeOutCubic } = U;

  const LANE_COLORS = ['#22d3ee', '#5b8cff', '#c084fc', '#ff5ec4'];
  const JUDGE_COLORS = { perfect: '#ffd24a', great: '#67e8f9', good: '#e8f4ff', miss: '#ff4d6a', pass: '#9db8d8' };
  const JUDGE_GLYPHS = { perfect: '✦', great: '✧', good: '●', miss: '✕', pass: '○' };
  const JUDGE_LABELS = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', miss: 'MISS', pass: 'FLOW' };

  /* ---------- glow sprite cache (avoids per-frame shadowBlur) ---------- */
  const spriteCache = new Map();
  function glowSprite(color, radius) {
    /* color: '#rrggbb' hex string or {r,g,b} object */
    const isObj = typeof color === 'object' && color !== null;
    const rgb = isObj ? color : U.hexToRgb(color);
    const key = (isObj ? (rgb.r | 0) + ',' + (rgb.g | 0) + ',' + (rgb.b | 0) : color) + '|' + radius;
    let c = spriteCache.get(key);
    if (c) return c;
    const r = Math.ceil(radius);
    c = document.createElement('canvas');
    c.width = c.height = r * 2;
    const x = c.getContext('2d');
    const grad = x.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, U.rgbToCss(rgb, 0.85));
    grad.addColorStop(0.35, U.rgbToCss(rgb, 0.38));
    grad.addColorStop(1, U.rgbToCss(rgb, 0));
    x.fillStyle = grad;
    x.fillRect(0, 0, r * 2, r * 2);
    spriteCache.set(key, c);
    return c;
  }
  function glow(ctx, x, y, radius, color, alpha) {
    const s = glowSprite(color, 48);
    ctx.globalAlpha = alpha === undefined ? 1 : alpha;
    ctx.drawImage(s, x - radius, y - radius, radius * 2, radius * 2);
    ctx.globalAlpha = 1;
  }

  /* ---------- generic pool ---------- */
  class Pool {
    constructor(factory, n) {
      this.items = [];
      for (let i = 0; i < n; i++) this.items.push(factory());
    }
    get() {
      for (const it of this.items) if (!it.active) return it;
      const it = this.items[0];
      return it;
    }
    each(fn) { for (const it of this.items) if (it.active) fn(it); }
    countActive() { let n = 0; for (const it of this.items) if (it.active) n++; return n; }
    clear() { for (const it of this.items) it.active = false; }
  }

  /* ================= TARGETS (tap / special / chain) ================= */
  class Target {
    constructor() { this.active = false; this.ev = null; this.hitT = 0; this.judged = false; this.bornAt = 0; this.rot = 0; }
    spawn(ev, now) {
      this.active = true; this.ev = ev; this.hitT = ev.time; this.judged = false; this.bornAt = now;
      this.rot = (ev.id * 137) % 360;
    }
    kill() { this.active = false; this.ev = null; }
    draw(ctx, L, now, quality) {
      const ev = this.ev;
      const approach = L.approach;
      const p = clamp(1 - (ev.time - now) / approach, -0.35, 1);
      if (p < 0) return;
      const x = L.laneX(ev.lane, p), y = L.yAt(p);
      const baseR = L.targetR;
      const sc = lerp(0.55, 1, easeOutCubic(clamp(p, 0, 1))) * lerp(0.9, 1.12, ev.strength || 0.5);
      const r = baseR * sc;
      const col = ev.type === 'SPECIAL' ? '#ffd24a' : LANE_COLORS[ev.lane % 4];
      const nearHit = clamp(1 - Math.abs(ev.time - now) / 0.25, 0, 1);
      const alpha = p > 0.92 ? clamp((1 - p) / 0.08 + 0.4, 0, 1) : clamp(p * 4, 0, 1);

      glow(ctx, x, y, r * (2.4 + nearHit * 0.8), col, 0.5 * alpha + nearHit * 0.25);
      ctx.globalAlpha = alpha;
      if (ev.type === 'SPECIAL') {
        /* rotating diamond with double ring */
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(this.rot * Math.PI / 180 + now * 1.5);
        ctx.fillStyle = col;
        ctx.beginPath();
        const rr = r * 0.72;
        ctx.moveTo(0, -rr); ctx.lineTo(rr, 0); ctx.lineTo(0, rr); ctx.lineTo(-rr, 0);
        ctx.closePath(); ctx.fill();
        ctx.restore();
        ctx.strokeStyle = col; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(x, y, r * 1.25, 0, TAU); ctx.stroke();
        ctx.globalAlpha = alpha * 0.5;
        ctx.beginPath(); ctx.arc(x, y, r * 1.55, 0, TAU); ctx.stroke();
      } else if (ev.chain) {
        /* chain targets: hexagon links */
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(this.rot * Math.PI / 180 + now * 2.2);
        ctx.strokeStyle = '#aef4ff';
        ctx.lineWidth = 3;
        ctx.fillStyle = U.rgbToCss(U.hexToRgb(col), 0.25);
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = i / 6 * TAU;
          const px = Math.cos(a) * r * 0.9, py = Math.sin(a) * r * 0.9;
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.restore();
      } else {
        /* standard target: filled disc + inner ring + core */
        ctx.fillStyle = U.rgbToCss(U.hexToRgb(col), 0.92);
        ctx.beginPath(); ctx.arc(x, y, r * 0.62, 0, TAU); ctx.fill();
        ctx.strokeStyle = U.rgbToCss(U.hexToRgb('#ffffff'), 0.85);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, r * 0.62, 0, TAU); ctx.stroke();
        ctx.strokeStyle = col;
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(x, y, r * 0.18, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  /* ================= HOLDS ================= */
  class Hold {
    constructor() { this.active = false; this.ev = null; this.state = 'pending'; this.pressT = 0; this.grade = null; }
    spawn(ev, now) { this.active = true; this.ev = ev; this.state = 'pending'; this.pressT = 0; this.grade = null; }
    kill() { this.active = false; this.ev = null; }
    draw(ctx, L, now) {
      const ev = this.ev;
      const approach = L.approach;
      const pHead = clamp(1 - (ev.time - now) / approach, -0.5, 1);
      const pTail = clamp(1 - (ev.time + ev.dur - now) / approach, -0.5, 1);
      if (pHead < 0) return;
      const col = LANE_COLORS[ev.lane % 4];
      const held = this.state === 'held';
      const headP = held ? 1 : pHead;
      const hx = L.laneX(ev.lane, headP), hy = L.yAt(held ? 1 : headP);
      const tx = L.laneX(ev.lane, pTail), ty = L.yAt(pTail);
      const r = L.targetR * lerp(0.55, 1, easeOutCubic(clamp(headP, 0, 1)));
      /* beam */
      const bw = r * 0.52;
      const grad = ctx.createLinearGradient(hx, hy, tx, ty);
      const rgb = U.hexToRgb(col);
      grad.addColorStop(0, U.rgbToCss(rgb, held ? 0.85 : 0.5));
      grad.addColorStop(1, U.rgbToCss(rgb, 0.08));
      ctx.fillStyle = grad;
      ctx.beginPath();
      const dx = tx - hx, dy = ty - hy, len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len * bw, ny = dx / len * bw;
      ctx.moveTo(hx + nx, hy + ny);
      ctx.lineTo(tx + nx, ty + ny);
      ctx.lineTo(tx - nx, ty - ny);
      ctx.lineTo(hx - nx, hy - ny);
      ctx.closePath();
      ctx.fill();
      /* energy dashes flowing along the beam */
      ctx.strokeStyle = U.rgbToCss(rgb, 0.65);
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 14]);
      ctx.lineDashOffset = -(now * 90) % 20;
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.setLineDash([]);
      /* head */
      glow(ctx, hx, hy, r * 2.2, col, held ? 0.8 : 0.45);
      ctx.strokeStyle = col; ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.arc(hx, hy, r * 0.8, 0, TAU); ctx.stroke();
      ctx.fillStyle = U.rgbToCss(rgb, held ? 0.9 : 0.35);
      ctx.beginPath(); ctx.arc(hx, hy, held ? r * 0.55 : r * 0.4, 0, TAU); ctx.fill();
      /* tail marker */
      ctx.strokeStyle = U.rgbToCss(rgb, 0.5);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(tx, ty, r * 0.42, 0, TAU); ctx.stroke();
    }
  }

  /* ================= HAZARDS (dodge) ================= */
  class Hazard {
    constructor() { this.active = false; this.ev = null; this.state = 'incoming'; this.doneT = 0; }
    spawn(ev, now) { this.active = true; this.ev = ev; this.state = 'incoming'; this.doneT = 0; }
    kill() { this.active = false; this.ev = null; }
    draw(ctx, L, now) {
      const ev = this.ev;
      const p = clamp(1 - (ev.time - now) / L.approach, -0.6, 1);
      if (p < 0) return;
      const x = L.laneX(ev.lane, p), y = L.yAt(p);
      const passed = now > ev.time + 0.12;
      const fade = passed ? clamp(1 - (now - ev.time - 0.12) / 0.35, 0, 1) : 1;
      const r = L.targetR * lerp(0.5, 1.05, easeOutCubic(clamp(p, 0, 1)));
      const warn = clamp(1 - Math.abs(ev.time - now) / 0.5, 0, 1);
      const col = '#ff5e3a';
      glow(ctx, x, y, r * (2.2 + warn * 1.6), col, (0.35 + warn * 0.4) * fade);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(now * 2.6);
      ctx.globalAlpha = fade;
      /* spiked gear — distinct shape (not just color) */
      ctx.strokeStyle = col;
      ctx.fillStyle = U.rgbToCss(U.hexToRgb(col), 0.3);
      ctx.lineWidth = 3;
      ctx.beginPath();
      const spikes = 8;
      for (let i = 0; i < spikes * 2; i++) {
        const a = i / (spikes * 2) * TAU;
        const rr = i % 2 === 0 ? r : r * 0.55;
        const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      /* X mark in center */
      ctx.strokeStyle = '#ffdcd0';
      ctx.lineWidth = 3.5;
      const x1 = r * 0.28;
      ctx.beginPath();
      ctx.moveTo(-x1, -x1); ctx.lineTo(x1, x1);
      ctx.moveTo(x1, -x1); ctx.lineTo(-x1, x1);
      ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  /* ================= ORBS (collect) ================= */
  class Orb {
    constructor() { this.active = false; this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; this.seed = 0; this.size = 3; }
    spawn(x, y, seed) {
      this.active = true;
      this.x = x; this.y = y;
      this.seed = seed;
      this.vx = (Math.sin(seed * 12.9) * 0.5) * 30;
      this.vy = 26 + (seed % 1) * 30;
      this.size = 3 + (seed % 1) * 2.5;
    }
    kill() { this.active = false; }
    update(dt, L, pull, pullX, pullY, now) {
      /* gentle drift downward + gravity toward player when combo is high.
         Sway uses song time (now) — never wall clock: orb motion must be
         deterministic so identical play yields identical scores. */
      this.x += this.vx * dt + Math.sin(this.seed * 7.7 + (now || 0) * 0.001) * 6 * dt;
      this.y += this.vy * dt;
      if (pull > 0) {
        const dx = pullX - this.x, dy = pullY - this.y;
        const d = Math.hypot(dx, dy) || 1;
        this.x += (dx / d) * pull * 190 * dt;
        this.y += (dy / d) * pull * 190 * dt;
      }
      if (this.y > L.h + 30) this.active = false;
    }
    draw(ctx, now) {
      const tw = 0.7 + 0.3 * Math.sin(this.seed * 31 + now * 6);
      glow(ctx, this.x, this.y, this.size * 4.5, '#8affc1', 0.55 * tw);
      ctx.fillStyle = '#d9ffe9';
      ctx.beginPath(); ctx.arc(this.x, this.y, this.size * tw, 0, TAU); ctx.fill();
    }
  }

  /* ================= PEAK (perfect moment) ================= */
  class Peak {
    constructor() { this.active = false; this.ev = null; this.state = 'pending'; this.fx = 0; }
    spawn(ev, now) { this.active = true; this.ev = ev; this.state = 'pending'; this.fx = 0; }
    kill() { this.active = false; this.ev = null; }
    draw(ctx, L, now, quality) {
      const ev = this.ev;
      const dt = now - ev.time;
      const approach = Math.max(1.2, L.approach);
      const p = clamp(1 - (ev.time - now) / approach, 0, 1);
      const cx = L.cx, cy = L.orbY;
      if (this.state === 'pending') {
        const R = lerp(L.h * 0.42, L.targetR * 1.9, easeOutCubic(p));
        const a = clamp(p * 2.5, 0, 1) * (p > 0.92 ? clamp((1 - p) / 0.08, 0, 1) + 0.55 : 1);
        glow(ctx, cx, cy, R * 1.5, '#ffe08a', 0.28 * a);
        ctx.strokeStyle = '#ffe08a';
        ctx.lineWidth = 4.5;
        ctx.globalAlpha = a;
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
        ctx.lineWidth = 2;
        ctx.globalAlpha = a * 0.55;
        ctx.beginPath(); ctx.arc(cx, cy, R * 0.8, 0, TAU); ctx.stroke();
        /* diamond marker */
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(now * 1.2);
        ctx.fillStyle = '#ffe08a';
        const rr = L.targetR * 0.5;
        ctx.beginPath();
        ctx.moveTo(0, -rr); ctx.lineTo(rr, 0); ctx.lineTo(0, rr); ctx.lineTo(-rr, 0);
        ctx.closePath(); ctx.fill();
        ctx.restore();
        ctx.globalAlpha = 1;
      } else if (this.state === 'hit') {
        /* celebration burst */
        const t = clamp((now - this.fx) / 0.9, 0, 1);
        const R = lerp(L.targetR * 2, L.h * 0.7, easeOutCubic(t));
        ctx.globalAlpha = 1 - t;
        ctx.strokeStyle = '#ffe08a';
        ctx.lineWidth = 7 * (1 - t) + 1;
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5 * (1 - t);
        ctx.beginPath(); ctx.arc(cx, cy, R * 0.8, 0, TAU); ctx.stroke();
        ctx.globalAlpha = 1;
        if (t >= 1) this.kill();
      } else { /* expired: fizzle */
        const t = clamp((now - this.fx) / 0.5, 0, 1);
        ctx.globalAlpha = (1 - t) * 0.4;
        ctx.strokeStyle = '#8a8676';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, lerp(L.targetR * 2.2, L.targetR * 3.4, t), 0, TAU); ctx.stroke();
        ctx.globalAlpha = 1;
        if (t >= 1) this.kill();
      }
    }
  }

  /* ================= FLOW: gates & walls ================= */
  class Gate {
    constructor() { this.active = false; this.ev = null; }
    spawn(ev) { this.active = true; this.ev = ev; }
    kill() { this.active = false; this.ev = null; }
    draw(ctx, L, now) {
      const ev = this.ev;
      const p = clamp(1 - (ev.time - now) / L.approach, -0.3, 1);
      if (p < 0) return;
      const y = L.yAt(p);
      const col = ev.gold ? '#ffd24a' : '#67e8f9';
      const x0 = L.flowX(ev.lane, p), x1 = L.flowX(ev.lane + 1, p);
      const cx = (x0 + x1) / 2, w = x1 - x0;
      const r = Math.min(w * 0.42, (y - L.vpY) * 0.16);
      glow(ctx, cx, y, r * 2.2, col, 0.5);
      ctx.strokeStyle = col;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.ellipse(cx, y, r, r * 0.42, 0, 0, TAU);
      ctx.stroke();
      if (ev.gold) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(cx, y, r * 0.72, r * 0.3, 0, 0, TAU);
        ctx.stroke();
      }
    }
  }
  class Wall {
    constructor() { this.active = false; this.ev = null; }
    spawn(ev) { this.active = true; this.ev = ev; }
    kill() { this.active = false; this.ev = null; }
    draw(ctx, L, now) {
      const ev = this.ev;
      const p = clamp(1 - (ev.time - now) / L.approach, -0.3, 1);
      if (p < 0) return;
      const y = L.yAt(p);
      const x0 = L.flowX(ev.lanes[0], p), x1 = L.flowX(ev.lanes[ev.lanes.length - 1] + 1, p);
      const hgt = (y - L.vpY) * 0.11;
      glow(ctx, (x0 + x1) / 2, y, Math.max(x1 - x0, hgt) * 1.4, '#ff5e3a', 0.35);
      const grad = ctx.createLinearGradient(x0, y - hgt, x1, y);
      grad.addColorStop(0, 'rgba(255,94,58,0.16)');
      grad.addColorStop(1, 'rgba(255,94,58,0.4)');
      ctx.fillStyle = grad;
      ctx.fillRect(x0, y - hgt, x1 - x0, hgt);
      ctx.strokeStyle = '#ff5e3a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.lineTo(x1, y - hgt); ctx.lineTo(x0, y - hgt);
      ctx.closePath(); ctx.stroke();
      /* hazard stripes */
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, y - hgt, x1 - x0, hgt); ctx.clip();
      ctx.strokeStyle = 'rgba(255,220,210,0.4)';
      ctx.lineWidth = 2;
      for (let xx = x0 - hgt; xx < x1; xx += 18) {
        ctx.beginPath(); ctx.moveTo(xx, y); ctx.lineTo(xx + hgt, y - hgt); ctx.stroke();
      }
      ctx.restore();
    }
  }

  /* ================= PARTICLES ================= */
  class Particle {
    constructor() { this.active = false; }
    init(x, y, vx, vy, life, size, color, kind) {
      this.active = true; this.x = x; this.y = y; this.vx = vx; this.vy = vy;
      this.life = life; this.maxLife = life; this.size = size; this.color = color; this.kind = kind || 'spark';
      this.rot = Math.random() * TAU; this.vr = (Math.random() - 0.5) * 8;
    }
    update(dt) {
      this.life -= dt;
      if (this.life <= 0) { this.active = false; return; }
      this.x += this.vx * dt; this.y += this.vy * dt;
      if (this.kind === 'confetti') { this.vy += 260 * dt; this.vx *= 0.99; this.rot += this.vr * dt; }
      else if (this.kind === 'rise') { this.vy -= 40 * dt; }
      else { this.vx *= 0.96; this.vy = this.vy * 0.96 + 30 * dt; }
    }
    draw(ctx) {
      const t = this.life / this.maxLife;
      if (this.kind === 'ring') {
        ctx.globalAlpha = t * 0.8;
        ctx.strokeStyle = this.color;
        ctx.lineWidth = 2.5 * t + 0.5;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size * (1 + (1 - t) * 2.6), 0, TAU);
        ctx.stroke();
      } else if (this.kind === 'confetti') {
        ctx.globalAlpha = Math.min(1, t * 2);
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.rot);
        ctx.fillStyle = this.color;
        ctx.fillRect(-this.size, -this.size * 0.4, this.size * 2, this.size * 0.8);
        ctx.restore();
      } else {
        ctx.globalAlpha = t;
        glow(ctx, this.x, this.y, this.size * 2.2, this.color, t * 0.7);
        ctx.fillStyle = this.color;
        ctx.beginPath(); ctx.arc(this.x, this.y, this.size * t, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }
  class Particles {
    constructor(n) { this.pool = new Pool(() => new Particle(), n); }
    clear() { this.pool.clear(); }
    burst(x, y, color, count, power, kind) {
      const n = Math.max(2, Math.round(count));
      for (let i = 0; i < n; i++) {
        const p = this.pool.get();
        if (!p.active && p.life > 0) continue;
        const a = Math.random() * TAU;
        const sp = (0.3 + Math.random() * 0.7) * power;
        p.init(x, y, Math.cos(a) * sp, Math.sin(a) * sp - power * 0.25,
          0.35 + Math.random() * 0.5, 2 + Math.random() * 3, color, kind || 'spark');
      }
    }
    ring(x, y, color, size) {
      const p = this.pool.get();
      p.init(x, y, 0, 0, 0.5, size, color, 'ring');
    }
    confetti(x, y, colors, count) {
      for (let i = 0; i < count; i++) {
        const p = this.pool.get();
        p.init(x + (Math.random() - 0.5) * 60, y + (Math.random() - 0.5) * 30,
          (Math.random() - 0.5) * 400, -Math.random() * 380 - 80,
          1.2 + Math.random() * 0.8, 3 + Math.random() * 4,
          colors[i % colors.length], 'confetti');
      }
    }
    update(dt) { this.pool.each((p) => p.update(dt)); }
    draw(ctx) { this.pool.each((p) => p.draw(ctx)); }
  }

  /* ================= FLOATING TEXT ================= */
  class FloatText {
    constructor() { this.active = false; }
    init(x, y, text, color, size, glyph, life) {
      this.active = true; this.x = x; this.y = y; this.text = text; this.color = color;
      this.size = size; this.glyph = glyph; this.life = life || 0.8; this.maxLife = this.life;
      this.pop = 0;
    }
    update(dt) {
      this.life -= dt;
      if (this.life <= 0) { this.active = false; return; }
      this.y -= 46 * dt;
      this.pop = Math.min(1, this.pop + dt * 6);
    }
    draw(ctx) {
      const t = this.life / this.maxLife;
      const pop = 1 + 0.35 * Math.sin(Math.min(1, this.pop) * Math.PI);
      ctx.save();
      ctx.globalAlpha = Math.min(1, t * 2.2);
      ctx.font = `800 ${Math.round(this.size * pop)}px 'Segoe UI', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (this.glyph) {
        ctx.fillStyle = this.color;
        ctx.fillText(this.glyph + ' ' + this.text, this.x, this.y);
      } else {
        ctx.fillStyle = this.color;
        ctx.fillText(this.text, this.x, this.y);
      }
      ctx.restore();
    }
  }
  class FloatTexts {
    constructor(n) { this.pool = new Pool(() => new FloatText(), n); }
    clear() { this.pool.clear(); }
    add(x, y, text, color, size, glyph, life) {
      const f = this.pool.get();
      f.init(x, y, text, color, size, glyph, life);
    }
    update(dt) { this.pool.each((f) => f.update(dt)); }
    draw(ctx) { this.pool.each((f) => f.draw(ctx)); }
  }

  /* ================= BEAT RINGS (world pulses on every beat) ================= */
  class BeatRing {
    constructor() { this.active = false; }
    spawn(x, y, color, strong) { this.active = true; this.x = x; this.y = y; this.color = color; this.strong = strong; this.t = 0; }
    update(dt) { this.t += dt; if (this.t > 0.7) this.active = false; }
    draw(ctx, L) {
      const p = this.t / 0.7;
      const R = lerp(L.targetR * 1.2, this.strong ? L.w * 0.42 : L.w * 0.2, easeOutCubic(p));
      ctx.globalAlpha = (1 - p) * (this.strong ? 0.5 : 0.3);
      ctx.strokeStyle = this.color;
      ctx.lineWidth = this.strong ? 3.5 : 2;
      ctx.beginPath();
      ctx.ellipse(this.x, this.y, R, R * 0.32, 0, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  RS.Entities = {
    Pool, Target, Hold, Hazard, Orb, Peak, Gate, Wall, Particles, FloatTexts, BeatRing,
    LANE_COLORS, JUDGE_COLORS, JUDGE_GLYPHS, JUDGE_LABELS, glow, glowSprite
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = RS.Entities;
})();

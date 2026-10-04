// Motore degli strumenti di disegno: overlay canvas sopra lightweight-charts.
// I punti sono memorizzati in (tempo, prezzo) e quindi restano ancorati al grafico a ogni timeframe.
import { uid } from './util.js';

export const TOOLS = {
  trend:    { name: 'Trendline', need: 2 },
  ray:      { name: 'Semiretta', need: 2 },
  arrow:    { name: 'Freccia', need: 2 },
  hline:    { name: 'Linea orizzontale', need: 1 },
  vline:    { name: 'Linea verticale', need: 1 },
  channel:  { name: 'Canale parallelo', need: 3 },
  rect:     { name: 'Rettangolo', need: 2 },
  fib:      { name: 'Ritracciamento Fibonacci', need: 2 },
  longpos:  { name: 'Posizione Long', need: 2 },
  shortpos: { name: 'Posizione Short', need: 2 },
  text:     { name: 'Testo', need: 1 },
  brush:    { name: 'Pennello', need: 0 },
  measure:  { name: 'Righello', need: 2 },
};
const FIB = [[0, '#787b86'], [0.236, '#f23645'], [0.382, '#ff9800'], [0.5, '#4caf50'], [0.618, '#089981'], [0.786, '#00bcd4'], [1, '#787b86'], [1.618, '#2962ff']];
const HIT = 6;

const distSeg = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};
const distRay = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, t);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

export class Drawings {
  /**
   * o = { chart, series, wrap, canvas, getBars(), getTfSec(), tick, fmt,
   *       onChange(items), onSelect(item|null), getExternal(), onExternalMove(id, price), onExternalCommit(id, price) }
   */
  constructor(o) {
    Object.assign(this, o);
    this.items = []; this.tool = null; this.stay = false; this.draft = null; this.meas = null;
    this.sel = null; this.drag = null; this.magnet = false; this.hidden = false; this.lockAll = false;
    this.undo = []; this.redo = []; this.mouse = null; this.defaults = { color: '#2962ff', width: 2, dash: 0 };
    this.ctx = this.canvas.getContext('2d');
    this.ts = this.chart.timeScale();
    const w = this.wrap;
    w.addEventListener('mousedown', e => this.onDown(e), true);
    window.addEventListener('mousemove', e => this.onMove(e), true);
    window.addEventListener('mouseup', e => this.onUp(e), true);
    w.addEventListener('dblclick', e => this.onDbl(e), true);
    w.addEventListener('mouseleave', () => { this.mouse = null; });
    window.addEventListener('keydown', e => this.onKey(e));
    const loop = () => { this.render(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  // ---------- Mappatura tempo/prezzo <-> pixel ----------
  t2l(t) {
    const bars = this.getBars(), n = bars.length - 1, tf = this.getTfSec();
    if (n < 0) return null;
    if (t >= bars[n].time) return n + (t - bars[n].time) / tf;
    if (t <= bars[0].time) return (t - bars[0].time) / tf;
    let lo = 0, hi = n;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; bars[m].time <= t ? lo = m : hi = m; }
    return lo + (t - bars[lo].time) / (bars[hi].time - bars[lo].time);
  }
  l2t(l) {
    const bars = this.getBars(), n = bars.length - 1, tf = this.getTfSec();
    if (n < 0) return null;
    if (l >= n) return bars[n].time + (l - n) * tf;
    if (l <= 0) return bars[0].time + l * tf;
    const lo = Math.floor(l);
    return bars[lo].time + (l - lo) * (bars[lo + 1].time - bars[lo].time);
  }
  // logicalToCoordinate di lightweight-charts non accetta indici frazionari (ritorna 0): si interpola tra interi.
  lx(l) {
    const a = Math.floor(l), ca = this.ts.logicalToCoordinate(a), cb = this.ts.logicalToCoordinate(a + 1);
    return ca == null || cb == null ? null : ca + (l - a) * (cb - ca);
  }
  x(t) { const l = this.t2l(t); return l == null ? null : this.lx(l); }
  y(p) { return this.series.priceToCoordinate(p); }
  toPoint(px, py) { // pixel -> {t,p}, con magnete opzionale
    const l = this.ts.coordinateToLogical(px), p = this.series.coordinateToPrice(py);
    if (l == null || p == null) return null;
    let pt = { t: this.l2t(l), p };
    if (this.magnet) {
      const bars = this.getBars(), k = Math.round(l);
      if (k >= 0 && k < bars.length) {
        const b = bars[k]; let best = null, bd = 14;
        for (const v of [b.open, b.high, b.low, b.close]) { const d = Math.abs(this.y(v) - py); if (d < bd) { bd = d; best = v; } }
        if (best != null) pt = { t: b.time, p: best };
      }
    }
    return pt;
  }
  local(e) { const r = this.wrap.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  plotSize() {
    const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
    let pw = 0, th = 0;
    try { pw = this.chart.priceScale('right').width(); th = this.ts.height(); } catch { /* ignore */ }
    return { w: w - pw, h: h - th, fullW: w };
  }
  inPlot(pt) { const s = this.plotSize(); return pt.x >= 0 && pt.x <= s.w && pt.y >= 0 && pt.y <= s.h; }

  // ---------- API pubblica ----------
  setItems(items) { this.items = items || []; this.select(null); }
  setTool(t, stay) {
    this.tool = t || null; this.draft = null; this.meas = null;
    if (stay !== undefined) this.stay = stay;
    if (t) this.select(null);
    this.wrap.style.cursor = t ? 'crosshair' : '';
    this.onToolChange && this.onToolChange(this.tool);
  }
  select(id) {
    this.sel = id;
    this.onSelect && this.onSelect(this.items.find(d => d.id === id) || null);
  }
  selected() { return this.items.find(d => d.id === this.sel) || null; }
  snapshot() { this.undo.push(JSON.stringify(this.items)); if (this.undo.length > 100) this.undo.shift(); this.redo = []; }
  commit() { this.onChange && this.onChange(this.items); }
  update(patch) { const d = this.selected(); if (!d) return; this.snapshot(); Object.assign(d, patch); this.commit(); }
  setDefaults(p) { Object.assign(this.defaults, p); }
  remove(id) { this.snapshot(); this.items = this.items.filter(d => d.id !== id); if (this.sel === id) this.select(null); this.commit(); }
  clear() { if (!this.items.length) return; this.snapshot(); this.items = []; this.select(null); this.commit(); }
  clone() {
    const d = this.selected(); if (!d) return;
    this.snapshot();
    const c = JSON.parse(JSON.stringify(d)); c.id = uid();
    const dl = 3; c.pts.forEach(p => { p.t = this.l2t(this.t2l(p.t) + dl); });
    this.items.push(c); this.select(c.id); this.commit();
  }
  undoLast() {
    if (!this.undo.length) return;
    this.redo.push(JSON.stringify(this.items)); this.items = JSON.parse(this.undo.pop()); this.select(null); this.commit();
  }
  redoLast() {
    if (!this.redo.length) return;
    this.undo.push(JSON.stringify(this.items)); this.items = JSON.parse(this.redo.pop()); this.select(null); this.commit();
  }

  // ---------- Geometria e hit-test ----------
  screen(d) { return d.pts.map(p => ({ x: this.x(p.t), y: this.y(p.p) })); }
  handlesOf(d) {
    const n = d.pts.length;
    switch (d.type) {
      case 'rect': return [{ tx: 0, py: 0 }, { tx: 1, py: 1 }, { tx: 0, py: 1 }, { tx: 1, py: 0 }];
      case 'hline': case 'vline': case 'text': case 'brush': return [];
      case 'longpos': case 'shortpos': return [{ tx: 0, py: 0 }, { tx: 1, py: 1 }, { tx: 1, py: 2 }];
      default: return Array.from({ length: n }, (_, i) => ({ tx: i, py: i }));
    }
  }
  handlePos(d, h) { return { x: this.x(d.pts[h.tx].t), y: this.y(d.pts[h.py].p) }; }
  hitBody(d, px, py) {
    const S = this.screen(d), w = this.plotSize().w;
    if (S.some(s => s.x == null || s.y == null) && d.type !== 'hline' && d.type !== 'vline') return false;
    switch (d.type) {
      case 'trend': case 'arrow': return distSeg(px, py, S[0].x, S[0].y, S[1].x, S[1].y) < HIT;
      case 'ray': return distRay(px, py, S[0].x, S[0].y, S[1].x, S[1].y) < HIT;
      case 'hline': return Math.abs(py - S[0].y) < HIT;
      case 'vline': return Math.abs(px - S[0].x) < HIT;
      case 'rect': return px >= Math.min(S[0].x, S[1].x) - HIT && px <= Math.max(S[0].x, S[1].x) + HIT && py >= Math.min(S[0].y, S[1].y) - HIT && py <= Math.max(S[0].y, S[1].y) + HIT;
      case 'channel': {
        const off = this.chanOffset(S);
        return distSeg(px, py, S[0].x, S[0].y, S[1].x, S[1].y) < HIT || distSeg(px, py, S[0].x, S[0].y + off, S[1].x, S[1].y + off) < HIT;
      }
      case 'fib': {
        const x1 = Math.min(S[0].x, S[1].x), x2 = Math.max(S[0].x, S[1].x);
        if (px < x1 - HIT || px > x2 + HIT) return false;
        return FIB.some(([l]) => Math.abs(py - this.y(d.pts[1].p + (d.pts[0].p - d.pts[1].p) * l)) < HIT);
      }
      case 'longpos': case 'shortpos': {
        const x1 = S[0].x, x2 = S[1].x, ys = [S[0].y, S[1].y, S[2].y];
        return px >= Math.min(x1, x2) && px <= Math.max(x1, x2) && py >= Math.min(...ys) && py <= Math.max(...ys);
      }
      case 'text': { const wd = (d.text || '').length * 7 + 10; return px >= S[0].x - 4 && px <= S[0].x + wd && py >= S[0].y - 16 && py <= S[0].y + 6; }
      case 'brush': for (let i = 1; i < S.length; i++) if (S[i].x != null && S[i - 1].x != null && distSeg(px, py, S[i - 1].x, S[i - 1].y, S[i].x, S[i].y) < HIT) return true; return false;
      default: return false;
    }
  }
  chanOffset(S) { // scostamento verticale (px) tra le due linee del canale, misurato alla x del terzo punto
    const dx = S[1].x - S[0].x, slope = dx ? (S[1].y - S[0].y) / dx : 0;
    return S[2].y - (S[0].y + slope * (S[2].x - S[0].x));
  }
  findHit(px, py) {
    const sel = this.selected();
    if (sel && !sel.locked) {
      const hs = this.handlesOf(sel);
      for (let i = 0; i < hs.length; i++) {
        const p = this.handlePos(sel, hs[i]);
        if (p.x != null && p.y != null && Math.hypot(px - p.x, py - p.y) < 9) return { d: sel, handle: i };
      }
    }
    for (let i = this.items.length - 1; i >= 0; i--) if (this.hitBody(this.items[i], px, py)) return { d: this.items[i], handle: -1 };
    return null;
  }
  findExternal(px, py) {
    const s = this.plotSize();
    if (px > s.w) return null;
    for (const e of this.getExternal ? this.getExternal() : []) {
      if (!e.draggable) continue;
      const y = this.y(e.price);
      if (y != null && Math.abs(py - y) < 5) return e;
    }
    return null;
  }

  // ---------- Eventi ----------
  newItem(type, pts) {
    return { id: uid(), type, pts, color: this.defaults.color, width: this.defaults.width, dash: this.defaults.dash, text: '', fill: 0.15 };
  }
  finishDraft() {
    const d = this.draft; this.draft = null;
    if (d.type === 'measure') { this.meas = d; return; }
    if (d.type === 'longpos' || d.type === 'shortpos') {
      const [a, b] = d.pts, risk = Math.abs(b.p - a.p) || 1;
      d.pts = [a, { t: b.t, p: b.p }, { t: b.t, p: a.p + (d.type === 'longpos' ? -risk : risk) }];
      d.color = d.type === 'longpos' ? '#089981' : '#f23645';
    }
    if (d.type === 'text') { const t = prompt('Testo:', ''); if (!t) return; d.text = t; }
    this.snapshot(); this.items.push(d);
    this.select(d.id); this.commit();
    if (!this.stay) this.setTool(null);
  }
  onDown(e) {
    if (e.button !== 0) return;
    const pt = this.local(e);
    if (!this.inPlot(pt)) return;
    if (this.meas && !this.draft) this.meas = null;
    if (this.tool) {
      e.stopPropagation(); e.preventDefault();
      const p = this.toPoint(pt.x, pt.y); if (!p) return;
      const need = TOOLS[this.tool].need;
      if (this.tool === 'brush') { this.draft = this.newItem('brush', [p]); this.downPos = pt; return; }
      if (!this.draft) {
        this.draft = this.newItem(this.tool, [p, { ...p }]);
        this.downPos = pt; this.dragged = false;
        if (need === 1) { this.draft.pts = [p]; this.finishDraft(); }
        return;
      }
      this.draft.pts[this.draft.pts.length - 1] = p;
      const need2 = this.tool === 'longpos' || this.tool === 'shortpos' ? 2 : need;
      if (this.draft.pts.length >= need2) this.finishDraft(); else this.draft.pts.push({ ...p });
      return;
    }
    const ext = this.findExternal(pt.x, pt.y);
    if (ext) { e.stopPropagation(); e.preventDefault(); this.drag = { kind: 'ext', id: ext.id }; return; }
    const hit = this.findHit(pt.x, pt.y);
    if (hit) {
      e.stopPropagation(); e.preventDefault();
      if (this.sel !== hit.d.id) this.select(hit.d.id);
      if (hit.d.locked || this.lockAll) return;
      const p = this.toPoint(pt.x, pt.y);
      this.drag = {
        kind: hit.handle >= 0 ? 'handle' : 'move', h: hit.handle, orig: JSON.parse(JSON.stringify(hit.d.pts)),
        l0: this.ts.coordinateToLogical(pt.x), p0: p.p, moved: false,
      };
    } else if (this.sel) this.select(null);
  }
  onMove(e) {
    const pt = this.local(e);
    this.mouse = pt;
    if (this.draft) {
      const p = this.toPoint(pt.x, pt.y); if (!p) return;
      const d = this.draft;
      if (d.type === 'brush') { const last = this.screenPt(d.pts[d.pts.length - 1]); if (!last || Math.hypot(last.x - pt.x, last.y - pt.y) > 3) d.pts.push(p); }
      else d.pts[d.pts.length - 1] = p;
      if (this.downPos && Math.hypot(this.downPos.x - pt.x, this.downPos.y - pt.y) > 6) this.dragged = true;
      return;
    }
    if (this.drag) {
      e.stopPropagation();
      if (this.drag.kind === 'ext') { const p = this.series.coordinateToPrice(pt.y); if (p != null) this.onExternalMove(this.drag.id, Math.round(p / this.tick) * this.tick); return; }
      const d = this.selected(); if (!d) return;
      if (!this.drag.moved) { this.snapshot(); this.drag.moved = true; }
      if (this.drag.kind === 'move') {
        const dl = this.ts.coordinateToLogical(pt.x) - this.drag.l0, p = this.series.coordinateToPrice(pt.y), dp = p - this.drag.p0;
        d.pts = this.drag.orig.map(o => ({ t: this.l2t(this.t2l(o.t) + dl), p: o.p + dp }));
      } else {
        const h = this.handlesOf(d)[this.drag.h], p = this.toPoint(pt.x, pt.y);
        if (p) {
          d.pts[h.tx].t = p.t; d.pts[h.py].p = p.p;
          if (d.type === 'longpos' || d.type === 'shortpos') d.pts[2].t = d.pts[1].t;
        }
      }
      return;
    }
    // hover: cambia il cursore se sopra un oggetto trascinabile
    if (!this.tool && this.inPlot(pt)) {
      const over = this.findExternal(pt.x, pt.y) ? 'ns-resize' : (this.findHit(pt.x, pt.y) ? 'pointer' : '');
      this.wrap.style.cursor = over;
    }
  }
  screenPt(p) { const x = this.x(p.t), y = this.y(p.p); return x == null || y == null ? null : { x, y }; }
  onUp(e) {
    if (this.draft) {
      const d = this.draft;
      if (d.type === 'brush') { this.draft = null; if (d.pts.length > 2) { this.snapshot(); this.items.push(d); this.select(d.id); this.commit(); if (!this.stay) this.setTool(null); } return; }
      if (this.dragged) {
        this.dragged = false;
        const need = TOOLS[d.type].need;
        if (d.pts.length === 2 && need === 2 || (d.pts.length === 2 && (d.type === 'longpos' || d.type === 'shortpos'))) { this.finishDraft(); }
        else if (d.pts.length === 2 && need === 3) d.pts.push({ ...d.pts[1] });
      }
      return;
    }
    if (this.drag) {
      e.stopPropagation();
      const dr = this.drag; this.drag = null;
      if (dr.kind === 'ext') {
        const pt = this.local(e), p = this.series.coordinateToPrice(pt.y);
        if (p != null) this.onExternalCommit(dr.id, Math.round(p / this.tick) * this.tick);
      } else if (dr.moved) this.commit();
    }
  }
  onDbl(e) {
    if (this.tool) return;
    const pt = this.local(e), hit = this.findHit(pt.x, pt.y);
    if (hit && (hit.d.type === 'text' || hit.d.type === 'trend')) {
      const t = prompt('Testo:', hit.d.text || '');
      if (t !== null) { this.select(hit.d.id); this.update({ text: t }); }
    }
  }
  onKey(e) {
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'Escape') { if (this.draft || this.meas) { this.draft = null; this.meas = null; } else if (this.tool) this.setTool(null); else this.select(null); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) { e.preventDefault(); const d = this.selected(); if (d && !d.locked) this.remove(d.id); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redoLast() : this.undoLast(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redoLast(); }
  }

  // ---------- Rendering ----------
  render() {
    const cv = this.canvas, dpr = devicePixelRatio || 1;
    const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    const ext = this.getExternal ? this.getExternal() : [];
    if (this.hidden && !ext.length) return;
    const s = this.plotSize();
    c.save(); c.beginPath(); c.rect(0, 0, s.w, s.h); c.clip();
    c.font = '11px system-ui, sans-serif';
    if (!this.hidden) {
      for (const d of this.items) this.drawItem(c, d, s, d.id === this.sel);
      if (this.draft) this.drawItem(c, this.draft, s, false);
      if (this.meas) this.drawMeasure(c, this.meas);
    }
    for (const e of ext) this.drawExternal(c, e, s);
    c.restore();
  }
  style(c, d) {
    c.strokeStyle = c.fillStyle = d.color; c.lineWidth = d.width || 1;
    c.setLineDash(d.dash === 1 ? [6, 4] : d.dash === 2 ? [2, 3] : []);
  }
  drawItem(c, d, s, selected) {
    if ((d.type === 'longpos' || d.type === 'shortpos') && d.pts.length === 2) { // bozza: stop simmetrico al target
      const [a, b] = d.pts;
      d = { ...d, pts: [a, b, { t: b.t, p: a.p - (b.p - a.p) }] };
    }
    const S = this.screen(d);
    const ok = d.type === 'hline' ? S[0].y != null : d.type === 'vline' ? S[0].x != null : S.every(p => p.x != null && p.y != null);
    if (!ok) return;
    c.save(); this.style(c, d);
    const line = (x1, y1, x2, y2) => { c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); };
    switch (d.type) {
      case 'trend': line(S[0].x, S[0].y, S[1].x, S[1].y); if (d.text) { c.setLineDash([]); c.fillText(d.text, (S[0].x + S[1].x) / 2 + 4, (S[0].y + S[1].y) / 2 - 6); } break;
      case 'arrow': {
        line(S[0].x, S[0].y, S[1].x, S[1].y);
        const a = Math.atan2(S[1].y - S[0].y, S[1].x - S[0].x), L = 10 + (d.width || 1) * 2;
        c.setLineDash([]); c.beginPath(); c.moveTo(S[1].x, S[1].y);
        c.lineTo(S[1].x - L * Math.cos(a - 0.4), S[1].y - L * Math.sin(a - 0.4)); c.lineTo(S[1].x - L * Math.cos(a + 0.4), S[1].y - L * Math.sin(a + 0.4)); c.closePath(); c.fill(); break;
      }
      case 'ray': {
        const dx = S[1].x - S[0].x, dy = S[1].y - S[0].y, k = dx === 0 && dy === 0 ? 0 : 5000 / Math.hypot(dx, dy);
        line(S[0].x, S[0].y, S[0].x + dx * k, S[0].y + dy * k); break;
      }
      case 'hline': line(0, S[0].y, s.w, S[0].y); c.setLineDash([]); this.tag(c, this.fmt(d.pts[0].p), s.w - 4, S[0].y, d.color, true); break;
      case 'vline': line(S[0].x, 0, S[0].x, s.h); break;
      case 'rect': {
        c.globalAlpha = d.fill; c.fillRect(S[0].x, S[0].y, S[1].x - S[0].x, S[1].y - S[0].y); c.globalAlpha = 1;
        c.strokeRect(S[0].x, S[0].y, S[1].x - S[0].x, S[1].y - S[0].y); break;
      }
      case 'channel': {
        const off = this.chanOffset(S), dx = S[1].x - S[0].x;
        line(S[0].x, S[0].y, S[1].x, S[1].y); line(S[0].x, S[0].y + off, S[1].x, S[1].y + off);
        c.globalAlpha = d.fill * 0.6; c.beginPath(); c.moveTo(S[0].x, S[0].y); c.lineTo(S[1].x, S[1].y); c.lineTo(S[1].x, S[1].y + off); c.lineTo(S[0].x, S[0].y + off); c.closePath(); c.fill(); c.globalAlpha = 1;
        c.setLineDash([4, 4]); line(S[0].x, S[0].y + off / 2, S[1].x, S[1].y + off / 2); void dx; break;
      }
      case 'fib': {
        const x1 = Math.min(S[0].x, S[1].x), x2 = Math.max(S[0].x, S[1].x);
        let prev = null;
        for (const [l, col] of FIB) {
          const p = d.pts[1].p + (d.pts[0].p - d.pts[1].p) * l, y = this.y(p);
          if (y == null) continue;
          c.strokeStyle = c.fillStyle = col; c.setLineDash([]); line(x1, y, x2, y);
          if (prev != null && l <= 1) { c.globalAlpha = 0.07; c.fillRect(x1, prev, x2 - x1, y - prev); c.globalAlpha = 1; }
          c.fillStyle = col; c.fillText(`${l} (${this.fmt(p)})`, x1 + 4, y - 3);
          prev = y;
        }
        c.strokeStyle = d.color; c.setLineDash([3, 3]); line(S[0].x, S[0].y, S[1].x, S[1].y); break;
      }
      case 'longpos': case 'shortpos': {
        const long = d.type === 'longpos', x1 = S[0].x, x2 = S[1].x, e = d.pts[0].p, tp = d.pts[1].p, sl = d.pts[2].p;
        const w = x2 - x1;
        c.globalAlpha = 0.25; c.fillStyle = '#089981'; c.fillRect(x1, S[0].y, w, S[1].y - S[0].y);
        c.fillStyle = '#f23645'; c.fillRect(x1, S[0].y, w, S[2].y - S[0].y); c.globalAlpha = 1;
        c.strokeStyle = '#787b86'; c.setLineDash([]); line(x1, S[0].y, x2, S[0].y);
        const reward = Math.abs(tp - e), risk = Math.abs(e - sl), rr = risk ? reward / risk : 0;
        c.fillStyle = '#fff'; c.textAlign = 'center';
        this.tag(c, `Target: ${this.fmt(reward)} pt`, x1 + w / 2, S[1].y + (S[1].y < S[0].y ? 12 : -4), '#089981', false, true);
        this.tag(c, `Stop: ${this.fmt(risk)} pt  ·  R:R ${rr.toFixed(2)}`, x1 + w / 2, S[2].y + (S[2].y > S[0].y ? -4 : 14), '#f23645', false, true);
        void long; break;
      }
      case 'text': c.setLineDash([]); c.font = `${10 + (d.width || 1) * 2}px system-ui, sans-serif`; c.fillText(d.text, S[0].x, S[0].y); break;
      case 'brush': c.lineJoin = 'round'; c.lineCap = 'round'; c.beginPath(); S.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.stroke(); break;
      case 'measure': this.drawMeasure(c, d); break;
      default: break;
    }
    c.restore();
    if (selected && !d.locked) {
      c.save(); c.setLineDash([]); c.fillStyle = '#fff'; c.strokeStyle = '#2962ff'; c.lineWidth = 2;
      for (const h of this.handlesOf(d)) {
        const p = this.handlePos(d, h); if (p.x == null || p.y == null) continue;
        c.beginPath(); c.arc(p.x, p.y, 5, 0, 7); c.fill(); c.stroke();
      }
      c.restore();
    }
  }
  drawMeasure(c, d) {
    const S = this.screen(d); if (S.some(p => p.x == null || p.y == null)) return;
    const up = d.pts[1].p >= d.pts[0].p, col = up ? '#2962ff' : '#f23645';
    c.save();
    c.globalAlpha = 0.15; c.fillStyle = col; c.fillRect(S[0].x, S[0].y, S[1].x - S[0].x, S[1].y - S[0].y); c.globalAlpha = 1;
    c.strokeStyle = col; c.setLineDash([]); c.lineWidth = 1; c.beginPath(); c.moveTo(S[0].x, S[0].y); c.lineTo(S[1].x, S[1].y); c.stroke();
    const dp = d.pts[1].p - d.pts[0].p, bars = Math.round(this.t2l(d.pts[1].t) - this.t2l(d.pts[0].t));
    const mins = Math.round((d.pts[1].t - d.pts[0].t) / 60), hh = Math.floor(Math.abs(mins) / 60), mm = Math.abs(mins) % 60;
    const txt = `${dp >= 0 ? '+' : ''}${this.fmt(dp)} (${(dp / d.pts[0].p * 100).toFixed(2)}%)  ·  ${bars} barre  ·  ${hh}h ${mm}m`;
    this.tag(c, txt, (S[0].x + S[1].x) / 2, Math.min(S[0].y, S[1].y) - 8, col, false, true);
    c.restore();
  }
  tag(c, text, x, y, color, right, center) {
    c.save(); c.setLineDash([]); c.font = '11px system-ui, sans-serif';
    const w = c.measureText(text).width + 10;
    const bx = center ? x - w / 2 : right ? x - w : x;
    c.globalAlpha = 0.95; c.fillStyle = color; c.fillRect(bx, y - 9, w, 17); c.globalAlpha = 1;
    c.fillStyle = '#fff'; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(text, bx + 5, y);
    c.restore();
  }
  drawExternal(c, e, s) {
    const y = this.y(e.price); if (y == null) return;
    c.save(); c.strokeStyle = e.color; c.lineWidth = 1; c.setLineDash(e.dash ? [6, 4] : []);
    c.beginPath(); c.moveTo(0, y); c.lineTo(s.w, y); c.stroke();
    this.tag(c, e.label, 70, y, e.color, false, false);
    c.restore();
  }
}

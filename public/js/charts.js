// Grafici minimali su canvas (nessuna dipendenza), con tooltip al passaggio del mouse.
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

let tipEl = null;
function tip(html, ev) {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'chart-tip'; document.body.append(tipEl); }
  if (!html) { tipEl.style.display = 'none'; return; }
  tipEl.innerHTML = html; tipEl.style.display = 'block';
  const w = tipEl.offsetWidth, x = Math.min(ev.clientX + 14, innerWidth - w - 8);
  tipEl.style.left = x + 'px'; tipEl.style.top = ev.clientY + 14 + 'px';
}

function setup(canvas) {
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(h * dpr));
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  c.font = '11px system-ui, sans-serif';
  return { c, w, h };
}
export function niceTicks(min, max, count = 5) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p, out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.abs(v) < 1e-9 ? 0 : v);
  return out;
}
const compact = v => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1) + 'k' : String(Math.round(v * 100) / 100));
const onHover = (canvas, fn) => {
  canvas.onmousemove = e => { const r = canvas.getBoundingClientRect(); fn(e.clientX - r.left, e.clientY - r.top, e); };
  canvas.onmouseleave = () => { tip(null); canvas.__redraw && canvas.__redraw(); };
};

// points: [{x, y}], x numerico (es. tempo). opts: { color, fillTo0, fmtX, fmtY, zero }
export function lineChart(canvas, points, opts = {}) {
  const draw = hover => {
    const { c, w, h } = setup(canvas), P = { l: 46, r: 10, t: 8, b: 20 };
    if (points.length < 2) { c.fillStyle = css('--dim'); c.fillText('Servono almeno due punti', 12, 20); return; }
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    let y0 = Math.min(...ys, opts.zero ? 0 : Infinity), y1 = Math.max(...ys, opts.zero ? 0 : -Infinity);
    if (y0 === y1) { y0 -= 1; y1 += 1; }
    const pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
    const x0 = xs[0], x1 = xs[xs.length - 1] || x0 + 1;
    const X = x => P.l + (x - x0) / (x1 - x0 || 1) * (w - P.l - P.r), Y = y => P.t + (1 - (y - y0) / (y1 - y0)) * (h - P.t - P.b);
    c.strokeStyle = css('--line'); c.fillStyle = css('--dim'); c.textAlign = 'right'; c.lineWidth = 1;
    for (const v of niceTicks(y0, y1, 4)) { c.beginPath(); c.moveTo(P.l, Y(v)); c.lineTo(w - P.r, Y(v)); c.stroke(); c.fillText((opts.fmtY ? opts.fmtY(v, true) : compact(v)), P.l - 6, Y(v) + 4); }
    for (let k = 0; k <= 4; k++) { const x = x0 + (x1 - x0) * k / 4; c.textAlign = k === 0 ? 'left' : k === 4 ? 'right' : 'center'; c.fillText(opts.fmtX ? opts.fmtX(x, true) : compact(x), X(x), h - 5); }
    const col = opts.color || css('--accent');
    if (opts.zero) { c.strokeStyle = css('--dim'); c.setLineDash([3, 3]); c.beginPath(); c.moveTo(P.l, Y(0)); c.lineTo(w - P.r, Y(0)); c.stroke(); c.setLineDash([]); }
    c.beginPath(); points.forEach((p, i) => i ? c.lineTo(X(p.x), Y(p.y)) : c.moveTo(X(p.x), Y(p.y)));
    c.strokeStyle = col; c.lineWidth = 2; c.stroke();
    if (opts.fill !== false) {
      c.lineTo(X(x1), Y(Math.max(y0, Math.min(y1, opts.zero ? 0 : y0)))); c.lineTo(X(x0), Y(Math.max(y0, Math.min(y1, opts.zero ? 0 : y0)))); c.closePath();
      c.globalAlpha = 0.12; c.fillStyle = col; c.fill(); c.globalAlpha = 1;
    }
    if (hover) { c.strokeStyle = css('--dim'); c.beginPath(); c.moveTo(X(hover.x), P.t); c.lineTo(X(hover.x), h - P.b); c.stroke(); c.fillStyle = col; c.beginPath(); c.arc(X(hover.x), Y(hover.y), 4, 0, 7); c.fill(); }
    canvas.__geom = { X, P, w };
  };
  canvas.__redraw = () => draw(null); draw(null);
  onHover(canvas, (mx, my, e) => {
    const g = canvas.__geom; if (!g) return;
    let best = points[0], bd = Infinity;
    for (const p of points) { const d = Math.abs(g.X(p.x) - mx); if (d < bd) { bd = d; best = p; } }
    draw(best); tip(`<b>${opts.fmtY ? opts.fmtY(best.y) : compact(best.y)}</b><br>${opts.fmtX ? opts.fmtX(best.x) : best.x}${best.note ? '<br>' + best.note : ''}`, e);
  });
}

// bars: [{ label, value, note? }]. Verde se >= 0, rosso se < 0.
export function barChart(canvas, bars, opts = {}) {
  const draw = hover => {
    const { c, w, h } = setup(canvas), P = { l: 46, r: 8, t: 8, b: opts.rotate ? 56 : 20 };
    if (!bars.length) { c.fillStyle = css('--dim'); c.fillText('Nessun dato', 12, 20); return; }
    let y0 = Math.min(0, ...bars.map(b => b.value)), y1 = Math.max(0, ...bars.map(b => b.value));
    if (y0 === y1) y1 = y0 + 1;
    const Y = y => P.t + (1 - (y - y0) / (y1 - y0)) * (h - P.t - P.b), bw = (w - P.l - P.r) / bars.length;
    c.strokeStyle = css('--line'); c.fillStyle = css('--dim'); c.textAlign = 'right';
    for (const v of niceTicks(y0, y1, 4)) { c.beginPath(); c.moveTo(P.l, Y(v)); c.lineTo(w - P.r, Y(v)); c.stroke(); c.fillText(opts.fmtY ? opts.fmtY(v, true) : compact(v), P.l - 6, Y(v) + 4); }
    bars.forEach((b, i) => {
      const x = P.l + i * bw + bw * 0.15, ww = Math.max(1, bw * 0.7), yv = Y(b.value), yz = Y(0);
      c.fillStyle = b.color || (b.value >= 0 ? css('--up') : css('--down')); c.globalAlpha = hover === i ? 1 : 0.85;
      c.fillRect(x, Math.min(yv, yz), ww, Math.max(1, Math.abs(yz - yv)));
      c.globalAlpha = 1;
      const every = Math.ceil(bars.length / Math.max(1, Math.floor((w - P.l) / (opts.rotate ? 22 : 38))));
      if (i % every === 0 && b.label !== undefined) {
        c.fillStyle = css('--dim'); c.textAlign = 'center';
        if (opts.rotate) { c.save(); c.translate(x + ww / 2 + 4, h - P.b + 8); c.rotate(-Math.PI / 4); c.textAlign = 'right'; c.fillText(String(b.label).slice(0, 14), 0, 0); c.restore(); } else c.fillText(b.label, x + ww / 2, h - 5);
      }
    });
    c.strokeStyle = css('--dim'); c.beginPath(); c.moveTo(P.l, Y(0)); c.lineTo(w - P.r, Y(0)); c.stroke();
    canvas.__geom = { P, bw };
  };
  canvas.__redraw = () => draw(-1); draw(-1);
  onHover(canvas, (mx, my, e) => {
    const g = canvas.__geom; if (!g) return;
    const i = Math.floor((mx - g.P.l) / g.bw);
    if (i < 0 || i >= bars.length) { tip(null); return; }
    draw(i); const b = bars[i];
    tip(`<b>${opts.fmtY ? opts.fmtY(b.value) : compact(b.value)}</b><br>${b.tip || b.label}${b.note ? '<br>' + b.note : ''}`, e);
  });
}

// segs: [{ label, value, color }]
export function donut(canvas, segs, centerText) {
  const { c, w, h } = setup(canvas), total = segs.reduce((a, s) => a + s.value, 0);
  const R = Math.min(w, h) / 2 - 6, cx = w / 2, cy = h / 2;
  if (R < 10) return;
  if (!total) { c.fillStyle = css('--dim'); c.textAlign = 'center'; c.fillText('Nessun dato', cx, cy); return; }
  let a = -Math.PI / 2;
  for (const s of segs) {
    const da = s.value / total * Math.PI * 2;
    c.beginPath(); c.arc(cx, cy, R, a, a + da); c.arc(cx, cy, R * 0.62, a + da, a, true); c.closePath(); c.fillStyle = s.color; c.fill();
    a += da;
  }
  if (centerText) { c.fillStyle = css('--text'); c.textAlign = 'center'; c.font = '600 18px system-ui, sans-serif'; c.fillText(centerText, cx, cy + 6); }
  canvas.onmousemove = e => {
    const r = canvas.getBoundingClientRect(), dx = e.clientX - r.left - cx, dy = e.clientY - r.top - cy, d = Math.hypot(dx, dy);
    if (d > R || d < R * 0.62) { tip(null); return; }
    let ang = Math.atan2(dy, dx) + Math.PI / 2; if (ang < 0) ang += Math.PI * 2;
    let acc = 0; for (const s of segs) { acc += s.value / total * Math.PI * 2; if (ang <= acc) { tip(`<b>${s.label}</b>: ${s.value} (${(s.value / total * 100).toFixed(0)}%)`, e); return; } }
  };
  canvas.onmouseleave = () => tip(null);
}

// axes: [{ label, value (0-100) }]
export function radar(canvas, axes) {
  const { c, w, h } = setup(canvas), n = axes.length, cx = w / 2, cy = h / 2 + 4, R = Math.min(w, h) / 2 - 34;
  if (R < 10) return;
  const pt = (i, v) => { const a = -Math.PI / 2 + i / n * Math.PI * 2; return [cx + Math.cos(a) * R * v / 100, cy + Math.sin(a) * R * v / 100]; };
  c.strokeStyle = css('--line'); c.fillStyle = css('--dim'); c.textAlign = 'center';
  for (const lv of [25, 50, 75, 100]) { c.beginPath(); axes.forEach((_, i) => { const [x, y] = pt(i, lv); i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.closePath(); c.stroke(); }
  axes.forEach((a, i) => { const [x, y] = pt(i, 100), [lx, ly] = pt(i, 122); c.beginPath(); c.moveTo(cx, cy); c.lineTo(x, y); c.stroke(); c.fillText(a.label, lx, ly + 4); });
  c.beginPath(); axes.forEach((a, i) => { const [x, y] = pt(i, Math.max(2, a.value)); i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.closePath();
  c.fillStyle = css('--accent'); c.globalAlpha = 0.25; c.fill(); c.globalAlpha = 1; c.strokeStyle = css('--accent'); c.lineWidth = 2; c.stroke();
}

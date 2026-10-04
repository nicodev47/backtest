// Un riquadro grafico: simbolo + timeframe + disegni, agganciato a un Feed del replay.
import { fmt } from './util.js';
import { TFS, tfSec, bucketOf, buildBars, newBar, addTo } from './data.js';
import { Drawings } from './drawings.js';

const LW = window.LightweightCharts;
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export function candleColors(style) {
  const dark = document.documentElement.dataset.theme !== 'light';
  if (style === 'classic') return { up: css('--up'), down: css('--down'), upBorder: css('--up'), downBorder: css('--down'), wick: null };
  const fg = dark ? '#e6e6e6' : '#111', bg = dark ? '#000' : '#fff';
  return { up: bg, down: fg, upBorder: fg, downBorder: fg, wick: fg };
}

export class Pane {
  /** app: { T(), style(), activate(pane), extFor(pane), extMove, extCommit, drawingsChanged, selected(item), toolChanged(t), isActive(pane), crosshair(pane,time), sync() } */
  constructor(app, conf, feed, parent) {
    this.app = app; this.conf = conf; this.feed = feed; this.tf = conf.tf || '5';
    this.bars = []; this.builtI = -1; this.base = null; this.partialApplied = false; this.dirtyFrom = Infinity;
    const el = this.el = document.createElement('div');
    el.className = 'pane';
    el.innerHTML = '<div class="phead"><div class="ptitle"></div><div class="plegend"></div></div><div class="pbody"><div class="pchart"></div><canvas class="ov"></canvas></div>';
    parent.append(el);
    this.body = el.querySelector('.pbody');
    el.addEventListener('mousedown', () => app.activate(this), true);
    this.chart = LW.createChart(el.querySelector('.pchart'), {
      autoSize: true, crosshair: { mode: 0 },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 10, barSpacing: 8 },
      rightPriceScale: { scaleMargins: { top: 0.08, bottom: 0.08 } },
    });
    this.series = this.chart.addCandlestickSeries({
      priceFormat: { type: 'price', precision: 2, minMove: feed.cfg.tickSize }, lastValueVisible: false, priceLineVisible: false,
      autoscaleInfoProvider: orig => { // l'asse include SL/TP/ordini così le linee trascinabili restano visibili
        const r = orig(), ps = app.extFor(this).map(e => e.price);
        if (r && ps.length) { r.priceRange.minValue = Math.min(r.priceRange.minValue, ...ps); r.priceRange.maxValue = Math.max(r.priceRange.maxValue, ...ps); }
        return r;
      },
    });
    this.chart.subscribeCrosshairMove(p => { this.legend(p && p.time); app.crosshair(this, p && p.time ? p.time : null); });
    this.dr = new Drawings({
      chart: this.chart, series: this.series, wrap: this.body, canvas: el.querySelector('.ov'),
      getBars: () => this.bars, getTfSec: () => tfSec(this.tf), tick: feed.cfg.tickSize, fmt: n => fmt(n, 2),
      onChange: items => { conf.drawings = items; app.drawingsChanged(this); },
      onSelect: item => app.selected(this, item),
      onToolChange: t => app.toolChanged(t),
      getExternal: () => app.extFor(this), onExternalMove: (id, p) => app.extMove(this, id, p), onExternalCommit: (id, p) => app.extCommit(this, id, p),
      isActive: () => app.isActive(this), renderExtra: (c, s) => this.renderLastPrice(c, s),
      onContext: info => app.contextMenu(this, info),
    });
    this.dr.setItems(conf.drawings || []);
    this.applyTheme();
    this.title();
  }
  title() {
    const a = this.feed.asset;
    this.el.querySelector('.ptitle').textContent = `${a.name.toUpperCase()} · ${TFS.find(t => t.id === this.tf).label} · CME${this.feed.store ? ' · TICK' : ''}`;
  }
  setActive(on) { this.el.classList.toggle('active', on); }
  applyTheme() {
    this.chart.applyOptions({
      layout: { background: { type: 'solid', color: css('--chart') }, textColor: css('--dim') },
      grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
      rightPriceScale: { borderColor: css('--line') }, timeScale: { borderColor: css('--line') },
    });
    const c = candleColors(this.app.style());
    this.series.applyOptions({
      upColor: c.up, downColor: c.down, borderUpColor: c.upBorder, borderDownColor: c.downBorder,
      wickUpColor: c.wick || c.upBorder, wickDownColor: c.wick || c.downBorder, borderVisible: true,
    });
    this.markers();
  }
  setFeed(feed) { this.feed = feed; this.conf.symbol = feed.sym; this.dr.tick = feed.cfg.tickSize; this.series.applyOptions({ priceFormat: { type: 'price', precision: 2, minMove: feed.cfg.tickSize } }); this.rebuild(true); }
  setTf(tf) { this.tf = tf; this.conf.tf = tf; this.rebuild(true); }

  // ---- dati ----
  rebuild(fit) {
    const f = this.feed;
    this.bars = buildBars(f.D, f.i, this.tf);
    this.builtI = f.i; this.partialApplied = false; this.base = null; this.ver = f.ver;
    this.applyPartial();
    this.series.setData(this.bars);
    this.dirtyFrom = Infinity;
    this.markers();
    if (fit) { const n = this.bars.length; this.chart.timeScale().setVisibleLogicalRange({ from: n - 140, to: n + 12 }); }
    this.title(); this.legend();
  }
  applyPartial() {
    const f = this.feed, pt = f.partial;
    if (!pt) return;
    const D = f.D, k = pt.k, bt = bucketOf(D.t[k], this.tf), last = this.bars[this.bars.length - 1];
    this.base = last && last.time === bt ? { ...last } : null;
    const b = this.base;
    const nb = b
      ? { time: bt, open: b.open, high: Math.max(b.high, pt.h), low: Math.min(b.low, pt.l), close: pt.c, volume: b.volume + pt.v }
      : { time: bt, open: pt.o, high: pt.h, low: pt.l, close: pt.c, volume: pt.v };
    if (b) this.bars[this.bars.length - 1] = nb; else this.bars.push(nb);
    this.partialApplied = true;
    this.dirtyFrom = Math.min(this.dirtyFrom, this.bars.length - 1);
  }
  // Allinea le barre al feed dopo uno o più step del replay (incrementale).
  refresh() {
    const f = this.feed, D = f.D;
    if (this.ver === f.ver) return;
    this.ver = f.ver;
    if (this.partialApplied) { // toglie il minuto in formazione applicato prima
      if (this.base) this.bars[this.bars.length - 1] = this.base; else this.bars.pop();
      this.dirtyFrom = Math.min(this.dirtyFrom, Math.max(0, this.bars.length - (this.base ? 1 : 0)));
      this.partialApplied = false; this.base = null;
    }
    for (let k = this.builtI + 1; k <= f.i; k++) {
      const bt = bucketOf(D.t[k], this.tf), last = this.bars[this.bars.length - 1];
      if (last && last.time === bt) addTo(last, D, k); else this.bars.push(newBar(bt, D, k));
      this.dirtyFrom = Math.min(this.dirtyFrom, this.bars.length - 1);
    }
    this.builtI = f.i;
    this.applyPartial();
  }
  flush() {
    if (this.dirtyFrom === Infinity) return;
    for (let k = this.dirtyFrom; k < this.bars.length; k++) this.series.update(this.bars[k]);
    this.dirtyFrom = Infinity;
    this.legend();
  }
  markers() {
    const acc = this.feed.acc, m = [], up = css('--up'), down = css('--down'), tf = this.tf;
    const mk = (t, long, entry, text, color) => ({
      time: bucketOf(t, tf), position: entry ? (long ? 'belowBar' : 'aboveBar') : (long ? 'aboveBar' : 'belowBar'),
      color, shape: entry ? (long ? 'arrowUp' : 'arrowDown') : 'circle', text,
    });
    for (const t of acc.trades) {
      const long = t.side === 'long';
      m.push(mk(t.entryTime, long, true, `${long ? 'L' : 'S'} ${t.qty}`, long ? up : down));
      m.push(mk(t.exitTime, long, false, `${t.pnl >= 0 ? '+' : ''}${Math.round(t.pnl)}$`, t.pnl >= 0 ? up : down));
    }
    const p = acc.position;
    if (p) m.push(mk(p.entryTime, p.dir === 1, true, `${p.dir === 1 ? 'L' : 'S'} ${p.qty}`, p.dir === 1 ? up : down));
    m.sort((a, b) => a.time - b.time);
    this.series.setMarkers(m);
  }
  legend(time) {
    let b = this.bars[this.bars.length - 1];
    if (time) { const f = this.bars.find(x => x.time === time); if (f) b = f; }
    const el = this.el.querySelector('.plegend');
    const col = b && b.close >= b.open ? 'up' : 'down';
    const html = b ? `<span>O <b class="${col}">${fmt(b.open)}</b></span><span>H <b class="${col}">${fmt(b.high)}</b></span><span>L <b class="${col}">${fmt(b.low)}</b></span><span>C <b class="${col}">${fmt(b.close)}</b></span>` : '';
    if (el.dataset.sig !== html) { el.dataset.sig = html; el.innerHTML = html; }
  }
  setCrosshairTime(time) {
    if (time == null) { this.chart.clearCrosshairPosition(); return; }
    const bt = bucketOf(time, this.tf), b = this.bars.find(x => x.time === bt);
    if (b) this.chart.setCrosshairPosition(b.close, bt, this.series); else this.chart.clearCrosshairPosition();
  }
  showRange(days) {
    if (!this.bars.length) return;
    const last = this.bars[this.bars.length - 1].time, from = Math.max(this.bars[0].time, last - days * 86400);
    this.chart.timeScale().setVisibleRange({ from, to: last + 12 * tfSec(this.tf) });
  }
  fit() { this.chart.timeScale().setVisibleLogicalRange({ from: this.bars.length - 140, to: this.bars.length + 12 }); this.chart.priceScale('right').applyOptions({ autoScale: true }); }

  // Linea e etichetta dell'ultimo prezzo con conto alla rovescia della candela.
  renderLastPrice(c, s) {
    const b = this.bars[this.bars.length - 1]; if (!b) return;
    const y = this.series.priceToCoordinate(b.close); if (y == null) return;
    const cc = candleColors(this.app.style()), up = b.close >= b.open;
    const col = this.app.style() === 'classic' ? (up ? cc.up : cc.down) : cc.downBorder;
    const txt = this.app.style() === 'classic' ? '#fff' : (document.documentElement.dataset.theme === 'light' ? '#fff' : '#000');
    c.save();
    c.strokeStyle = col; c.globalAlpha = 0.6; c.setLineDash([1, 3]); c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, y); c.lineTo(s.w, y); c.stroke();
    c.globalAlpha = 1; c.setLineDash([]);
    const rem = Math.max(0, Math.ceil(b.time + tfSec(this.tf) - this.app.T())), pad = (n) => String(n).padStart(2, '0');
    const cd = rem >= 3600 ? `${Math.floor(rem / 3600)}:${pad(Math.floor(rem % 3600 / 60))}:${pad(rem % 60)}` : `${pad(Math.floor(rem / 60))}:${pad(rem % 60)}`;
    const w = s.fullW - s.w - 2;
    c.fillStyle = col; c.fillRect(s.w + 1, y - 17, w, 34);
    c.fillStyle = txt; c.font = '11px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(fmt(b.close), s.w + 1 + w / 2, y - 6); c.font = '10px system-ui, sans-serif'; c.fillText(cd, s.w + 1 + w / 2, y + 7);
    c.restore();
  }
  destroy() { this.chart.remove(); this.el.remove(); }
}

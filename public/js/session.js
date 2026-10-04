import { $, $$, fmt, money, fmtDT, toInputValue, fromInputValue, api } from './util.js';
import { initTheme } from './theme.js';
import { TFS, tfSec, bucketOf, loadCandles, firstIndexAtOrAfter, buildBars, newBar, addTo } from './data.js';
import * as Broker from './broker.js';
import { Drawings, TOOLS } from './drawings.js';

const LW = window.LightweightCharts;
const sid = location.pathname.split('/').pop();
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

let S, asset, D, cfg, acc;
// i = indice dell'ultimo minuto COMPLETO; sub = minuto in formazione rivelato fino al secondo `sub.s` (1..59)
let i = 0, sub = null, tf = '5', bars = [], dirtyFrom = Infinity;
let chart, main, dr;
let playing = false, stopReq = false, silent = false, saveTimer = null, saveDirty = false;
let extOrig = {};

// ====================== Avvio ======================
(async function init() {
  try {
    S = await api('/sessions/' + sid);
    const assets = await api('/assets');
    asset = assets.find(a => a.symbol === S.symbol);
    D = await loadCandles(S.symbol);
  } catch (e) {
    document.body.innerHTML = `<p style="padding:24px">Sessione non trovata o dati non disponibili. <a href="/">Torna alla dashboard</a></p>`;
    return;
  }
  cfg = { capital: S.capital, pointValue: asset.pointValue, tickSize: asset.tickSize, commission: S.commission || 0 };
  acc = S.account && S.account.nextId ? S.account : Broker.newAccount();
  tf = S.timeframe && TFS.some(t => t.id === S.timeframe) ? S.timeframe : '5';
  const st = S.settings || {};
  if (S.cursorTime != null) {
    i = firstIndexAtOrAfter(D.t, S.cursorTime);
    if (i >= D.t.length || D.t[i] > S.cursorTime) i = Math.max(0, i - 1);
    if (st.sub > 0 && i + 1 < D.t.length) resumeSub(st.sub | 0);
  } else i = Math.max(0, firstIndexAtOrAfter(D.t, S.startTime) - 1); // si parte dall'istante di inizio, prima della sua candela

  document.title = `${S.name} – Backtest`;
  $('#sname').textContent = S.name; $('#sym').textContent = S.symbol;
  initTheme($('#themeBtn'), applyTheme);
  buildTfButtons(); buildTools(); buildChart(); bindUI(); restoreTicket(st.ticket);
  loadAll(true);
  dr.setItems(S.drawings || []);
  if (location.search.includes('debug')) window.__bt = { dr };
  requestAnimationFrame(frame);
})();

// ====================== Grafico ======================
function applyTheme() {
  if (!chart) return;
  chart.applyOptions({
    layout: { background: { type: 'solid', color: css('--chart') }, textColor: css('--dim') },
    grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
    rightPriceScale: { borderColor: css('--line') }, timeScale: { borderColor: css('--line') },
  });
  styleMain(); refreshMarkers();
}
function buildChart() {
  chart = LW.createChart($('#chart'), {
    autoSize: true,
    crosshair: { mode: 0 },
    timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 10, barSpacing: 8 },
    rightPriceScale: { scaleMargins: { top: 0.08, bottom: 0.08 } },
  });
  chart.subscribeCrosshairMove(p => updateLegend(p && p.time));
  main = chart.addCandlestickSeries({ priceFormat: { type: 'price', precision: 2, minMove: asset.tickSize }, lastValueVisible: true, priceLineVisible: true,
    // l'asse dei prezzi include sempre entry/SL/TP/ordini pendenti, così le linee trascinabili restano visibili
    autoscaleInfoProvider: orig => {
      const r = orig(), ps = acc ? getExternal().map(e => e.price) : [];
      if (r && ps.length) { r.priceRange.minValue = Math.min(r.priceRange.minValue, ...ps); r.priceRange.maxValue = Math.max(r.priceRange.maxValue, ...ps); }
      return r;
    } });
  dr = new Drawings({
    chart, series: main, wrap: $('#chartWrap'), canvas: $('#ov'),
    getBars: () => bars, getTfSec: () => tfSec(tf), tick: cfg.tickSize, fmt: n => fmt(n, 2),
    onChange: items => { S.drawings = items; markSave(); },
    onSelect: item => buildPropbar(item),
    onToolChange: t => syncTools(t),
    getExternal, onExternalMove: extMove, onExternalCommit: extCommit,
  });
  applyTheme();
}
function styleMain() {
  main.applyOptions({ upColor: css('--up'), downColor: css('--down'), wickUpColor: css('--up'), wickDownColor: css('--down'), borderVisible: false });
}

// Ricostruisce tutte le barre fino al cursore e riempie il grafico.
function loadAll(fit) {
  bars = buildBars(D, i, tf);
  if (sub) { sub.base = baseBar(i + 1); renderForming(i + 1, partialRow(i + 1)); }
  main.setData(bars);
  refreshMarkers();
  dirtyFrom = Infinity;
  if (fit) { const n = bars.length; chart.timeScale().setVisibleLogicalRange({ from: n - 140, to: n + 12 }); }
  updateLegend(); renderAll();
}
// Aggiorna in modo incrementale le barre toccate dagli ultimi step.
function flush() {
  if (dirtyFrom === Infinity) return;
  for (let k = dirtyFrom; k < bars.length; k++) main.update(bars[k]);
  dirtyFrom = Infinity;
  updateLegend();
}
function refreshMarkers() {
  const m = [], up = css('--up'), down = css('--down');
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
  main.setMarkers(m);
}

function updateLegend(time) {
  let b = bars[bars.length - 1];
  if (time) { const f = bars.find(x => x.time === time); if (f) b = f; }
  const lg = $('#legend');
  const col = b && b.close >= b.open ? 'up' : 'down';
  const sig = b ? `<div class="ohlc"><b>${S.symbol} · ${TFS.find(t => t.id === tf).label}</b> &nbsp;<span>O <b class="${col}">${fmt(b.open)}</b></span><span>H <b class="${col}">${fmt(b.high)}</b></span><span>L <b class="${col}">${fmt(b.low)}</b></span><span>C <b class="${col}">${fmt(b.close)}</b></span></div>` : '';
  if (lg.dataset.sig !== sig) { lg.dataset.sig = sig; lg.innerHTML = sig; }
}

// ====================== Replay ======================
// I dati sono a 1 minuto: i secondi sono SIMULATI percorrendo la candela O -> L -> H -> C (rialzista)
// oppure O -> H -> L -> C (ribassista), in 60 passi. Open, high, low e close della candela restano esatti.
let pathCache = { k: -1, p: null };
function secPath(k) {
  if (pathCache.k === k) return pathCache.p;
  const o = D.o[k], h = D.h[k], l = D.l[k], c = D.c[k];
  const kp = c >= o ? [o, l, h, c] : [o, h, l, c], p = new Array(61);
  for (let s = 0; s <= 60; s++) {
    const x = s / 20, seg = Math.min(2, Math.floor(x)), f = x - seg;
    p[s] = Math.round((kp[seg] + (kp[seg + 1] - kp[seg]) * f) / cfg.tickSize) * cfg.tickSize;
  }
  p[0] = o; p[60] = c;
  pathCache = { k, p };
  return p;
}
const curTime = () => (sub ? D.t[i + 1] + sub.s : D.t[i] + 60);
const curPrice = () => (sub ? secPath(i + 1)[sub.s] : D.c[i]);
function bar1() { const p = curPrice(); return { t: curTime(), o: p, h: p, l: p, c: p }; }
function resumeSub(sec) {
  const p = secPath(i + 1); let h = p[0], l = p[0];
  for (let s = 1; s <= sec; s++) { h = Math.max(h, p[s]); l = Math.min(l, p[s]); }
  sub = { s: sec, h, l, base: null };
}
function baseBar(k) { const last = bars[bars.length - 1]; return last && last.time === bucketOf(D.t[k], tf) ? { ...last } : null; }
function partialRow(k) {
  const p = secPath(k);
  return { o: D.o[k], h: sub.h, l: sub.l, c: p[sub.s], v: D.v[k] * sub.s / 60 };
}
function renderForming(k, row) {
  const bt = bucketOf(D.t[k], tf), last = bars[bars.length - 1], base = sub && sub.base;
  const nb = base
    ? { time: bt, open: base.open, high: Math.max(base.high, row.h), low: Math.min(base.low, row.l), close: row.c, volume: base.volume + row.v }
    : { time: bt, open: row.o, high: row.h, low: row.l, close: row.c, volume: row.v };
  if (last && last.time === bt) bars[bars.length - 1] = nb; else bars.push(nb);
  dirtyFrom = Math.min(dirtyFrom, bars.length - 1);
}
function advanceSecond() {
  const k = i + 1;
  if (k >= D.t.length) return false;
  const p = secPath(k), s = (sub ? sub.s : 0) + 1, prev = p[s - 1], cur = p[s];
  if (!sub) sub = { s: 0, h: D.o[k], l: D.o[k], base: baseBar(k) };
  handleEvents(Broker.onBar(cfg, acc, { t: D.t[k] + s, o: prev, h: Math.max(prev, cur), l: Math.min(prev, cur), c: cur }));
  sub.s = s; sub.h = Math.max(sub.h, cur); sub.l = Math.min(sub.l, cur);
  if (s === 60) {
    renderForming(k, { o: D.o[k], h: D.h[k], l: D.l[k], c: D.c[k], v: D.v[k] });
    i = k; sub = null;
  } else renderForming(k, partialRow(k));
  return true;
}
function advanceMinute() {
  if (sub) { while (sub) if (!advanceSecond()) return false; return true; }
  const k = i + 1;
  if (k >= D.t.length) return false;
  handleEvents(Broker.onBar(cfg, acc, { t: D.t[k] + 60, o: D.o[k], h: D.h[k], l: D.l[k], c: D.c[k] }));
  i = k;
  const bt = bucketOf(D.t[k], tf), last = bars[bars.length - 1];
  if (last && last.time === bt) addTo(last, D, k); else bars.push(newBar(bt, D, k));
  dirtyFrom = Math.min(dirtyFrom, bars.length - 1);
  return true;
}
let jumpSummary = null;
function handleEvents(ev) {
  if (!ev.length) return;
  needMarkers = true; needUI = true; markSave();
  for (const e of ev) {
    if (jumpSummary) { if (e.type === 'close') jumpSummary.n++; continue; }
    if (e.type === 'close') {
      const t = e.trade, why = { sl: 'Stop loss', tp: 'Take profit', manual: 'Chiusura' }[t.reason];
      toast(`${why}: ${t.side === 'long' ? 'Long' : 'Short'} ${t.qty} · ${money(t.pnl)}${t.r != null ? ` (${fmt(t.r)} R)` : ''}`, t.pnl >= 0 ? 'win' : 'loss');
      if (t.reason !== 'manual' && $('#pauseFill').checked) stopReq = true;
    } else if (e.type === 'open' || e.type === 'add') {
      if (playing) { toast(`Ordine eseguito: ${e.side === 'buy' ? 'Buy' : 'Sell'} ${e.qty} @ ${fmt(e.price)}`); if ($('#pauseFill').checked) stopReq = true; }
    }
  }
}
let needMarkers = false, needUI = true;
function setPlaying(p) {
  playing = p; stopReq = false; accT = 0;
  $('#play').textContent = p ? '⏸ Pausa' : '▶ Play';
  if (!p) saveNow();
}
let lastT = performance.now(), accT = 0, uiT = 0;
function frame(now) {
  const dt = Math.min(0.25, (now - lastT) / 1000); lastT = now;
  if (playing) {
    const rate = +$('#speed').value; // secondi di mercato per secondo reale
    accT += dt * rate;
    const secs = Math.floor(accT);
    let ok = true;
    if (rate < 60) { accT -= secs; for (let n = Math.min(secs, 60); n > 0 && ok; n--) { ok = advanceSecond(); if (stopReq) break; } }
    else { const mins = Math.floor(accT / 60); accT -= mins * 60; for (let n = Math.min(mins, 600); n > 0 && ok; n--) { ok = advanceMinute(); if (stopReq) break; } }
    if (!ok) { setPlaying(false); toast('Fine dei dati disponibili'); }
    else if (stopReq) setPlaying(false);
    markSave();
  }
  flush();
  if (needMarkers) { refreshMarkers(); needMarkers = false; }
  if (needUI || playing && now - uiT > 200) { renderAll(); uiT = now; needUI = false; }
  requestAnimationFrame(frame);
}
function stepSec() { if (playing) setPlaying(false); if (advanceSecond()) { flush(); needUI = true; markSave(); } }
function stepOne() { if (playing) setPlaying(false); if (advanceMinute()) { flush(); needUI = true; markSave(); } }
function stepBarBtn() {
  if (playing) setPlaying(false);
  if (!advanceMinute()) return;
  while (i < D.t.length - 1 && bucketOf(D.t[i + 1], tf) === bars[bars.length - 1].time) advanceMinute();
  flush(); needUI = true; markSave();
}
function jumpTo(idx) { // idx = indice del minuto da cui ripartire (ora = D.t[idx])
  if (D.t[idx] <= curTime()) { toast('Puoi saltare solo in avanti nel tempo'); return; }
  if (playing) setPlaying(false);
  jumpSummary = { n: 0 };
  const stopAt = Math.min(idx, D.t.length) - 1;
  if (sub) advanceMinute();
  while (i < stopAt) { const k = i + 1; handleEvents(Broker.onBar(cfg, acc, { t: D.t[k] + 60, o: D.o[k], h: D.h[k], l: D.l[k], c: D.c[k] })); i = k; }
  const n = jumpSummary.n; jumpSummary = null;
  loadAll(true); markSave();
  if (n) toast(`Durante il salto sono state chiuse ${n} operazioni`);
}

// ====================== Ordini ======================
function sizeInfo() {
  const px = curPrice(), type = $('#otype .on').dataset.t;
  const price = type === 'market' ? px : +$('#oprice').value;
  const slp = +$('#osl').value || 0, tpp = +$('#otp').value || 0;
  const eq = Broker.equity(cfg, acc, px);
  let qty = Math.floor(+$('#oqty').value) || 0;
  if ($('#sizeMode .on').dataset.m === 'risk') qty = slp > 0 ? Math.floor(eq * (+$('#orisk').value || 0) / 100 / (slp * cfg.pointValue)) : 0;
  return { px, type, price, slp, tpp, qty, eq };
}
function updateTicket() {
  const s = sizeInfo(), end = i >= D.t.length - 1;
  $('#sellPx').textContent = $('#buyPx').textContent = fmt(s.px);
  $('#priceRow').hidden = s.type === 'market';
  const risk = $('#sizeMode .on').dataset.m === 'risk';
  $('#qtyRow').hidden = risk; $('#riskRow').hidden = !risk;
  const parts = [];
  if (risk) parts.push(`Contratti: <b>${s.qty}</b>`);
  if (s.slp > 0 && s.qty) parts.push(`Rischio: <b class="down">${money(s.slp * cfg.pointValue * s.qty)}</b>`);
  if (s.tpp > 0 && s.qty) parts.push(`Target: <b class="up">${money(s.tpp * cfg.pointValue * s.qty)}</b>`);
  if (s.slp > 0 && s.tpp > 0) parts.push(`R:R <b>${fmt(s.tpp / s.slp)}</b>`);
  if (risk && !s.slp) parts.push('Imposta uno stop loss per calcolare la size');
  $('#oinfo').innerHTML = parts.join(' · ');
  $('#buy').disabled = $('#sell').disabled = end || s.qty < 1;
}
function submitOrder(side) {
  const s = sizeInfo(), d = Broker.dirOf(side), err = $('#oerr');
  err.textContent = '';
  if (s.type !== 'market' && !(s.price > 0)) { err.textContent = 'Inserisci il prezzo'; return; }
  const sl = s.slp > 0 ? Broker.snap(s.price - d * s.slp, cfg.tickSize) : null;
  const tp = s.tpp > 0 ? Broker.snap(s.price + d * s.tpp, cfg.tickSize) : null;
  const r = Broker.placeOrder(cfg, acc, { type: s.type, side, qty: s.qty, price: s.price, sl, tp }, bar1());
  if (r.error) { err.textContent = r.error; return; }
  handleEvents(r.events); needMarkers = true; needUI = true; markSave();
}
function closeAll() {
  handleEvents(Broker.closePosition(cfg, acc, bar1()));
}
function reverse() {
  const p = acc.position; if (!p) return;
  const side = p.dir === 1 ? 'sell' : 'buy', q = p.qty;
  handleEvents(Broker.placeOrder(cfg, acc, { type: 'market', side, qty: q * 2 }, bar1()).events);
}
function addLevel(key) { // crea SL (20 pt) o TP (40 pt) dal prezzo attuale: poi si trascina sul grafico
  const p = acc.position; if (!p) return;
  const px = curPrice(), v = key === 'sl' ? px - p.dir * 20 : px + p.dir * 40;
  Broker.setLevels(acc, { [key]: Broker.snap(v, cfg.tickSize) });
  if (p.sl != null) p.risk = Math.abs(p.entry - p.sl) * p.qty * cfg.pointValue;
  needUI = true; markSave();
}
function breakeven() {
  const p = acc.position; if (!p) return;
  if ((curPrice() - p.entry) * p.dir <= 0) { toast('Il prezzo non è in profitto: impossibile spostare lo stop a pareggio'); return; }
  Broker.setLevels(acc, { sl: Broker.snap(p.entry, cfg.tickSize) }); needUI = true; markSave();
}

// Linee operative sul grafico (trascinabili): posizione, SL, TP, ordini pendenti
function getExternal() {
  const out = [], px = curPrice(), p = acc.position;
  if (p) {
    const pnl = p => (px - p.entry) * p.dir * p.qty * cfg.pointValue;
    out.push({ id: 'pos:entry', price: p.entry, color: css('--accent'), label: `${p.dir === 1 ? 'LONG' : 'SHORT'} ${p.qty}  ${money(pnl(p))}` });
    const val = lvl => (lvl - p.entry) * p.dir * p.qty * cfg.pointValue;
    if (p.sl != null) out.push({ id: 'pos:sl', price: p.sl, color: '#f23645', dash: 1, draggable: true, label: `SL ${money(val(p.sl))}` });
    if (p.tp != null) out.push({ id: 'pos:tp', price: p.tp, color: '#089981', dash: 1, draggable: true, label: `TP ${money(val(p.tp))}` });
  }
  for (const o of acc.orders) {
    out.push({ id: `ord:${o.id}:price`, price: o.price, color: '#ff9800', dash: 1, draggable: true, label: `${o.type.toUpperCase()} ${o.side.toUpperCase()} ${o.qty}` });
    const d = Broker.dirOf(o.side);
    if (o.sl != null) out.push({ id: `ord:${o.id}:sl`, price: o.sl, color: '#f23645', dash: 1, draggable: true, label: `SL ${money((o.sl - o.price) * d * o.qty * cfg.pointValue)}` });
    if (o.tp != null) out.push({ id: `ord:${o.id}:tp`, price: o.tp, color: '#089981', dash: 1, draggable: true, label: `TP ${money((o.tp - o.price) * d * o.qty * cfg.pointValue)}` });
  }
  return out;
}
function extTarget(id) {
  const [kind, a, b] = id.split(':');
  if (kind === 'pos') return { obj: acc.position, key: a };
  const o = acc.orders.find(x => x.id === +a);
  return { obj: o, key: b, order: o };
}
function extMove(id, price) {
  const { obj, key } = extTarget(id); if (!obj) return;
  if (!(id in extOrig)) extOrig[id] = obj[key];
  obj[key] = price; needUI = true;
}
function extCommit(id, price) {
  const { obj, key, order } = extTarget(id); if (!obj) { extOrig = {}; return; }
  const px = curPrice(), orig = extOrig[id]; delete extOrig[id];
  const dir = order ? Broker.dirOf(order.side) : obj.dir;
  const ref = order ? order.price : px;
  let ok = true;
  if (key === 'sl') ok = (ref - price) * dir > 0;
  else if (key === 'tp') ok = (price - ref) * dir > 0;
  else if (key === 'price') ok = order.type === 'limit' ? (dir === 1 ? price < px : price > px) : (dir === 1 ? price > px : price < px);
  if (!ok) { obj[key] = orig; toast('Livello non valido, ripristinato'); }
  else {
    obj[key] = price;
    if (obj === acc.position && obj.sl != null) obj.risk = Math.abs(obj.entry - obj.sl) * obj.qty * cfg.pointValue;
  }
  needUI = true; markSave();
}

// ====================== Pannelli ======================
let posSig = '';
function renderAll() {
  const px = curPrice(), eq = Broker.equity(cfg, acc, px), op = Broker.openPnl(cfg, acc, px), rp = Broker.realizedPnl(acc);
  $('#eq').textContent = money(eq);
  $('#openPnl').textContent = money(op); $('#openPnl').className = op >= 0 ? 'up' : 'down';
  $('#realPnl').textContent = money(rp); $('#realPnl').className = rp >= 0 ? 'up' : 'down';
  $('#px').textContent = fmt(px); $('#clock').textContent = fmtDT(curTime(), true) + ' ET';
  updateTicket(); renderPosCard(); renderTabs();
}
function renderPosCard() {
  const p = acc.position, el = $('#posCard');
  const sig = p ? `${p.dir}|${p.qty}|${p.entry}|${p.sl != null}|${p.tp != null}` : 'none';
  if (sig !== el.dataset.sig) {
    el.dataset.sig = sig;
    if (!p) el.innerHTML = '<div class="muted">Nessuna posizione aperta.</div>';
    else el.innerHTML = `
      <div class="kv">Posizione<b class="${p.dir === 1 ? 'up' : 'down'}">${p.dir === 1 ? 'LONG' : 'SHORT'} ${p.qty} × ${S.symbol}</b></div>
      <div class="kv">Prezzo medio<b>${fmt(p.entry)}</b></div>
      <div class="kv">P&amp;L aperto<b id="pcPnl"></b></div>
      <div class="two" style="margin-top:6px">
        <label class="fld">Stop loss<input id="pcSl" type="number" step="${cfg.tickSize}" placeholder="—"></label>
        <label class="fld">Take profit<input id="pcTp" type="number" step="${cfg.tickSize}" placeholder="—"></label>
      </div>
      <div class="muted small" style="margin-top:6px">Trascina le linee SL/TP sul grafico per modificarle.</div>
      <div class="btns"><button id="pcClose" class="btn danger">Chiudi</button><button id="pcRev" class="btn">Inverti</button><button id="pcBe" class="btn">SL a pareggio</button>
      ${p.sl == null ? '<button id="pcAddSl" class="btn">+ Stop loss</button>' : ''}${p.tp == null ? '<button id="pcAddTp" class="btn">+ Take profit</button>' : ''}</div>`;
    if (p) {
      $('#pcClose').onclick = closeAll; $('#pcRev').onclick = reverse; $('#pcBe').onclick = breakeven;
      if ($('#pcAddSl')) $('#pcAddSl').onclick = () => addLevel('sl');
      if ($('#pcAddTp')) $('#pcAddTp').onclick = () => addLevel('tp');
      for (const [id, key] of [['#pcSl', 'sl'], ['#pcTp', 'tp']]) $(id).onchange = e => {
        const v = e.target.value === '' ? null : Broker.snap(+e.target.value, cfg.tickSize), pos = acc.position, px = curPrice();
        if (v != null && ((key === 'sl' && (px - v) * pos.dir <= 0) || (key === 'tp' && (v - px) * pos.dir <= 0))) { toast('Livello non valido rispetto al prezzo attuale'); needUI = true; el.dataset.sig = ''; return; }
        Broker.setLevels(acc, { [key]: v });
        if (pos.sl != null) pos.risk = Math.abs(pos.entry - pos.sl) * pos.qty * cfg.pointValue;
        markSave();
      };
    }
  }
  if (p) {
    const u = Broker.openPnl(cfg, acc, curPrice());
    $('#pcPnl').textContent = money(u); $('#pcPnl').className = u >= 0 ? 'up' : 'down';
    for (const [id, v] of [['#pcSl', p.sl], ['#pcTp', p.tp]]) { const inp = $(id); if (document.activeElement !== inp) inp.value = v ?? ''; }
  }
}
let tabSig = {};
function renderTabs() {
  const px = curPrice(), p = acc.position;
  const open = $('#tab-pos'), hist = $('#tab-hist'), st = $('#tab-stats');
  // Posizioni e ordini
  const s1 = JSON.stringify([p, acc.orders]);
  if (!open.hidden) {
    if (tabSig.pos !== s1) {
      tabSig.pos = s1;
      let h = '<table><thead><tr><th class="l">Tipo</th><th>Lato</th><th>Qtà</th><th>Prezzo</th><th>SL</th><th>TP</th><th>P&amp;L</th><th></th></tr></thead><tbody>';
      if (p) h += `<tr><td class="l">Posizione</td><td class="${p.dir === 1 ? 'up' : 'down'}">${p.dir === 1 ? 'Long' : 'Short'}</td><td>${p.qty}</td><td>${fmt(p.entry)}</td><td>${p.sl != null ? fmt(p.sl) : '–'}</td><td>${p.tp != null ? fmt(p.tp) : '–'}</td><td id="tpPnl"></td><td><button data-close>Chiudi</button></td></tr>`;
      for (const o of acc.orders) h += `<tr><td class="l">${o.type === 'limit' ? 'Limit' : 'Stop'}</td><td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? 'Buy' : 'Sell'}</td><td>${o.qty}</td><td>${fmt(o.price)}</td><td>${o.sl != null ? fmt(o.sl) : '–'}</td><td>${o.tp != null ? fmt(o.tp) : '–'}</td><td>–</td><td><button data-cancel="${o.id}">Annulla</button></td></tr>`;
      if (!p && !acc.orders.length) h += '<tr><td class="l muted" colspan="8">Nessuna posizione o ordine aperto</td></tr>';
      open.innerHTML = h + '</tbody></table>';
      const c = open.querySelector('[data-close]'); if (c) c.onclick = closeAll;
      open.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => { Broker.cancelOrder(acc, +b.dataset.cancel); needUI = true; tabSig = {}; markSave(); });
    }
    const pn = $('#tpPnl'); if (pn) { const u = Broker.openPnl(cfg, acc, px); pn.textContent = money(u); pn.className = u >= 0 ? 'up' : 'down'; }
  }
  if (!hist.hidden) {
    const s2 = acc.trades.length + '|' + (acc.trades.at(-1)?.id);
    if (tabSig.hist !== s2) {
      tabSig.hist = s2;
      let h = '<table><thead><tr><th>#</th><th class="l">Lato</th><th>Qtà</th><th>Ingresso</th><th>Prezzo</th><th>Uscita</th><th>Prezzo</th><th>P&amp;L</th><th>R</th><th class="l">Motivo</th></tr></thead><tbody>';
      for (const t of [...acc.trades].reverse()) h += `<tr><td>${t.id}</td><td class="l ${t.side === 'long' ? 'up' : 'down'}">${t.side === 'long' ? 'Long' : 'Short'}</td><td>${t.qty}</td><td>${fmtDT(t.entryTime)}</td><td>${fmt(t.entry)}</td><td>${fmtDT(t.exitTime)}</td><td>${fmt(t.exit)}</td><td class="${t.pnl >= 0 ? 'up' : 'down'}">${money(t.pnl)}</td><td>${t.r != null ? fmt(t.r) : '–'}</td><td class="l">${{ sl: 'Stop loss', tp: 'Take profit', manual: 'Manuale' }[t.reason]}</td></tr>`;
      if (!acc.trades.length) h += '<tr><td class="l muted" colspan="10">Nessuna operazione chiusa</td></tr>';
      hist.innerHTML = h + '</tbody></table>';
    }
  }
  if (!st.hidden && tabSig.stats !== String(acc.trades.length)) {
    tabSig.stats = String(acc.trades.length);
    const s = Broker.stats(cfg, acc), pf = s.profitFactor === Infinity ? '∞' : fmt(s.profitFactor);
    const cell = (l, v, c = '') => `<div><span>${l}</span><b class="${c}">${v}</b></div>`;
    st.innerHTML = `<div class="statgrid">
      ${cell('P&L totale', s.n ? money(s.total) : '–', s.total >= 0 ? 'up' : 'down')}${cell('Operazioni', s.n)}${cell('Win rate', s.winRate != null ? fmt(s.winRate * 100, 1) + '%' : '–')}
      ${cell('Profit factor', s.n ? pf : '–')}${cell('R medio', s.avgR != null ? fmt(s.avgR) + ' R' : '–')}${cell('Max drawdown', s.n ? money(s.maxDrawdown) : '–', 'down')}
      ${cell('Media vincente', money(s.avgWin))}${cell('Media perdente', money(s.avgLoss))}${cell('Expectancy', money(s.expectancy))}
      ${cell('Miglior trade', money(s.best))}${cell('Peggior trade', money(s.worst))}</div><canvas id="curve"></canvas>`;
    drawCurve(s.curve);
  }
}
function drawCurve(curve) {
  const cv = $('#curve'); if (!cv) return;
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const c = cv.getContext('2d'); c.scale(dpr, dpr);
  const vs = curve.map(p => p.v), lo = Math.min(...vs), hi = Math.max(...vs), pad = (hi - lo || 1) * 0.1;
  const X = k => 8 + (curve.length < 2 ? 0 : k / (curve.length - 1) * (w - 16)), Y = v => h - 12 - (v - lo + pad) / (hi - lo + 2 * pad) * (h - 24);
  c.strokeStyle = css('--line'); c.beginPath(); c.moveTo(0, Y(cfg.capital)); c.lineTo(w, Y(cfg.capital)); c.stroke();
  c.strokeStyle = css('--accent'); c.lineWidth = 2; c.beginPath();
  curve.forEach((p, k) => k ? c.lineTo(X(k), Y(p.v)) : c.moveTo(X(k), Y(p.v)));
  if (curve.length < 2) { c.fillStyle = css('--dim'); c.fillText('Equity curve (si popola con le operazioni chiuse)', 10, 20); }
  c.stroke();
}
function exportCsv() {
  const rows = [['id', 'lato', 'qty', 'ingresso_ET', 'prezzo_ingresso', 'uscita_ET', 'prezzo_uscita', 'pnl', 'R', 'motivo']];
  for (const t of acc.trades) rows.push([t.id, t.side, t.qty, fmtDT(t.entryTime), t.entry, fmtDT(t.exitTime), t.exit, t.pnl.toFixed(2), t.r != null ? t.r.toFixed(2) : '', t.reason]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' }));
  a.download = `${S.name.replace(/[^\w-]+/g, '_')}_trades.csv`; a.click();
}

// ====================== Salvataggio ======================
function summaryObj() {
  const s = Broker.stats(cfg, acc);
  return { n: s.n, total: s.total, winRate: s.winRate, equity: Broker.equity(cfg, acc, curPrice()) };
}
function stateObj() {
  return {
    cursorTime: D.t[i], timeframe: tf, account: acc, drawings: S.drawings || [],
    settings: { sub: sub ? sub.s : 0, ticket: collectTicket() }, summary: summaryObj(),
  };
}
function markSave() {
  saveDirty = true; $('#saveState').textContent = 'Modifiche non salvate';
  if (!saveTimer) saveTimer = setTimeout(saveNow, 2500);
}
async function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!saveDirty) return;
  saveDirty = false;
  try { await api('/sessions/' + sid, { method: 'PUT', body: stateObj() }); $('#saveState').textContent = 'Salvato'; }
  catch { saveDirty = true; $('#saveState').textContent = 'Errore di salvataggio'; saveTimer = setTimeout(saveNow, 5000); }
}
addEventListener('pagehide', () => { if (saveDirty && S) navigator.sendBeacon('/api/sessions/' + sid + '/save', new Blob([JSON.stringify(stateObj())], { type: 'application/json' })); });
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

// ====================== UI ======================
function toast(msg, cls = '') {
  const d = document.createElement('div'); d.textContent = msg; if (cls) d.className = cls;
  $('#toast').append(d); setTimeout(() => d.remove(), 4500);
  while ($('#toast').children.length > 4) $('#toast').firstChild.remove();
}
function buildTfButtons() {
  const box = $('#tfs');
  box.innerHTML = TFS.map(t => `<button data-tf="${t.id}" class="${t.id === tf ? 'on' : ''}">${t.label}</button>`).join('');
  box.onclick = e => {
    const b = e.target.closest('button'); if (!b || b.dataset.tf === tf) return;
    tf = b.dataset.tf; $$('button', box).forEach(x => x.classList.toggle('on', x === b));
    loadAll(true); markSave();
  };
}
const ICON = {
  cursor: '<path d="M5 3l13 8-6 2-3 6z"/>',
  trend: '<path d="M4 19L20 5"/><circle cx="4" cy="19" r="1.5"/><circle cx="20" cy="5" r="1.5"/>',
  ray: '<path d="M4 18L21 6"/><circle cx="4" cy="18" r="1.5"/>',
  arrow: '<path d="M4 20L20 4M20 4h-7M20 4v7"/>',
  hline: '<path d="M3 12h18"/><circle cx="12" cy="12" r="1.5"/>',
  vline: '<path d="M12 3v18"/><circle cx="12" cy="12" r="1.5"/>',
  channel: '<path d="M3 14L17 4M7 21L21 11"/>',
  rect: '<rect x="4" y="6" width="16" height="12"/>',
  fib: '<path d="M3 5h18M3 10h18M3 15h18M3 20h18"/>',
  longpos: '<path d="M12 11V3M9 6l3-3 3 3"/><rect x="5" y="11" width="14" height="9"/>',
  shortpos: '<path d="M12 13v8M9 18l3 3 3-3"/><rect x="5" y="4" width="14" height="9"/>',
  text: '<path d="M6 5h12M12 5v14M9 19h6"/>',
  brush: '<path d="M4 20c3 0 4-1 4-3l9-9-2-2-9 9c-2 0-2 3-2 5z"/>',
  measure: '<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>',
  magnet: '<path d="M5 3v9a7 7 0 0014 0V3h-4v9a3 3 0 01-6 0V3z"/>',
  stay: '<path d="M12 3l3 6 5 1-4 4 1 6-5-3-5 3 1-6-4-4 5-1z"/>',
  lock: '<rect x="5" y="11" width="14" height="9"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  undo: '<path d="M8 6L3 11l5 5"/><path d="M3 11h11a6 6 0 010 10h-3"/>',
};
function buildTools() {
  const mk = (key, title, extra = '') => `<button data-k="${key}" title="${title}" ${extra}><svg viewBox="0 0 24 24">${ICON[key]}</svg></button>`;
  $('#tools').innerHTML =
    mk('cursor', 'Cursore (Esc)') + '<hr>' +
    ['trend', 'ray', 'arrow', 'hline', 'vline', 'channel', 'fib', 'rect', 'longpos', 'shortpos', 'text', 'brush', 'measure'].map(k => mk(k, TOOLS[k].name)).join('') + '<hr>' +
    mk('magnet', 'Magnete (aggancia a O/H/L/C)') + mk('stay', 'Resta in modalità disegno') + mk('lock', 'Blocca tutti i disegni') + mk('eye', 'Mostra/nascondi disegni') + mk('undo', 'Annulla (Ctrl+Z)') + mk('trash', 'Elimina tutti i disegni');
  $('#tools').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    const k = b.dataset.k;
    if (k === 'cursor') dr.setTool(null);
    else if (TOOLS[k]) dr.setTool(dr.tool === k ? null : k);
    else if (k === 'magnet') { dr.magnet = !dr.magnet; b.classList.toggle('on', dr.magnet); }
    else if (k === 'stay') { dr.stay = !dr.stay; b.classList.toggle('on', dr.stay); }
    else if (k === 'lock') { dr.lockAll = !dr.lockAll; b.classList.toggle('on', dr.lockAll); }
    else if (k === 'eye') { dr.hidden = !dr.hidden; b.classList.toggle('on', dr.hidden); }
    else if (k === 'undo') dr.undoLast();
    else if (k === 'trash') { if (dr.items.length && confirm('Eliminare tutti i disegni?')) dr.clear(); }
  };
}
function syncTools(t) { $$('#tools button').forEach(b => { if (TOOLS[b.dataset.k] || b.dataset.k === 'cursor') b.classList.toggle('on', b.dataset.k === (t || 'cursor')); }); }

function buildPropbar(item) {
  const bar = $('#propbar');
  if (!item) { bar.hidden = true; return; }
  bar.hidden = false;
  const hasFill = item.type === 'rect' || item.type === 'channel';
  bar.innerHTML = `<input type="color" id="pColor" value="${item.color.length === 7 ? item.color : '#2962ff'}" title="Colore">
    <select id="pWidth" title="Spessore">${[1, 2, 3, 4].map(w => `<option ${w === item.width ? 'selected' : ''}>${w}</option>`).join('')}</select>
    <select id="pDash" title="Stile"><option value="0">—</option><option value="1" ${item.dash === 1 ? 'selected' : ''}>- - -</option><option value="2" ${item.dash === 2 ? 'selected' : ''}>· · ·</option></select>
    ${hasFill ? `<input type="range" id="pFill" min="0" max="0.6" step="0.05" value="${item.fill}" title="Riempimento">` : ''}
    ${item.type === 'text' || item.type === 'trend' ? '<button id="pText" class="btn small">Testo</button>' : ''}
    <button id="pLock" class="btn small ${item.locked ? 'on' : ''}" title="Blocca">${item.locked ? '🔒' : '🔓'}</button>
    <button id="pClone" class="btn small" title="Duplica">⧉</button><button id="pDel" class="btn small danger" title="Elimina">✕</button>`;
  $('#pColor').oninput = e => { dr.setDefaults({ color: e.target.value }); dr.update({ color: e.target.value }); };
  $('#pWidth').onchange = e => dr.update({ width: +e.target.value });
  $('#pDash').onchange = e => dr.update({ dash: +e.target.value });
  if (hasFill) $('#pFill').oninput = e => dr.update({ fill: +e.target.value });
  if ($('#pText')) $('#pText').onclick = () => { const t = prompt('Testo:', item.text || ''); if (t !== null) dr.update({ text: t }); };
  $('#pLock').onclick = () => { dr.update({ locked: !item.locked }); buildPropbar(dr.selected()); };
  $('#pClone').onclick = () => dr.clone();
  $('#pDel').onclick = () => dr.remove(item.id);
}

function collectTicket() {
  return { otype: $('#otype .on').dataset.t, sizeMode: $('#sizeMode .on').dataset.m, oqty: $('#oqty').value, orisk: $('#orisk').value, osl: $('#osl').value, otp: $('#otp').value };
}
function restoreTicket(t) {
  if (!t) return;
  const seg = (sel, attr, v) => $$(sel + ' button').forEach(b => b.classList.toggle('on', b.dataset[attr] === v));
  seg('#otype', 't', t.otype || 'market'); seg('#sizeMode', 'm', t.sizeMode || 'qty');
  for (const k of ['oqty', 'orisk', 'osl', 'otp']) if (t[k] !== undefined) $('#' + k).value = t[k];
}

function bindUI() {
  $('#fitBtn').onclick = () => { chart.timeScale().setVisibleLogicalRange({ from: bars.length - 140, to: bars.length + 12 }); chart.priceScale('right').applyOptions({ autoScale: true }); };
  $('#sname').onclick = async () => {
    const n = prompt('Nome sessione:', S.name); if (!n || !n.trim()) return;
    S.name = n.trim(); $('#sname').textContent = S.name; document.title = `${S.name} – Backtest`;
    try { await api('/sessions/' + sid, { method: 'PUT', body: { name: S.name } }); } catch { /* ignore */ }
  };
  $('#play').onclick = () => setPlaying(!playing);
  $('#step1s').onclick = stepSec; $('#step1').onclick = stepOne; $('#stepBar').onclick = stepBarBtn;
  $('#jumpTime').value = toInputValue(curTime());
  $('#jumpBtn').onclick = () => { const v = $('#jumpTime').value; if (v) jumpTo(firstIndexAtOrAfter(D.t, fromInputValue(v))); };
  $('#jumpOpen').onclick = () => {
    for (let k = i + 1; k < D.t.length; k++) if (D.t[k] % 86400 === 34200) { jumpTo(k); return; }
    toast('Nessuna altra apertura 09:30 nei dati');
  };
  $$('#otype button').forEach(b => b.onclick = () => { $$('#otype button').forEach(x => x.classList.toggle('on', x === b)); if (b.dataset.t !== 'market' && !$('#oprice').value) $('#oprice').value = fmt(curPrice(), 2).replace(/\./g, '').replace(',', '.'); updateTicket(); markSave(); });
  $$('#sizeMode button').forEach(b => b.onclick = () => { $$('#sizeMode button').forEach(x => x.classList.toggle('on', x === b)); updateTicket(); markSave(); });
  ['oqty', 'orisk', 'osl', 'otp', 'oprice'].forEach(id => $('#' + id).addEventListener('input', () => { updateTicket(); markSave(); }));
  $('#buy').onclick = () => submitOrder('buy'); $('#sell').onclick = () => submitOrder('sell');
  $$('.tabs [data-tab]').forEach(b => b.onclick = () => {
    $$('.tabs [data-tab]').forEach(x => x.classList.toggle('on', x === b));
    ['pos', 'hist', 'stats'].forEach(t => { $('#tab-' + t).hidden = t !== b.dataset.tab; });
    tabSig = {}; renderTabs();
  });
  $('#exportBtn').onclick = exportCsv;
  addEventListener('keydown', e => {
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || e.ctrlKey || e.metaKey) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); e.shiftKey ? stepBarBtn() : e.altKey ? stepSec() : stepOne(); }
  });
  document.addEventListener('click', e => { const b = e.target.closest('button'); if (b && e.detail > 0) b.blur(); });
}

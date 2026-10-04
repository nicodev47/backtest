import { $, $$, fmt, money, fmtDT, toInputValue, fromInputValue, api, uid, esc } from './util.js';
import { initTheme } from './theme.js';
import { TFS, tfSec, loadCandles, loadTickIndex, loadTickDay, firstIndexAtOrAfter, sessionKey } from './data.js';
import * as Broker from './broker.js';
import { Feed, Replay, TickStore } from './feed.js';
import { Pane } from './pane.js';
import { TOOLS } from './drawings.js';
import { renderAnalytics } from './analytics.js';

const sid = location.pathname.split('/').pop();
const RATES = [1, 2, 3, 5, 8, 12, 20, 30, 60, 120]; // passi al secondo associati alla slider 1..10
const QUICK_TFS = ['1', '15', '60'];
const LAYOUTS = { '1': ['Singolo', 1], '2h': ['2 affiancati', 2], '2v': ['2 sovrapposti', 2], '4': ['4 (griglia)', 4] };

let S, assets, replay, active = null, panes = [], playbooks = [];
const feeds = new Map(), candleCache = new Map(), tickCache = new Map();
let playing = false, saveTimer = null, saveDirty = false, jumpSummary = null, needUI = true, needMarkers = false;
let extOrig = {}, syncing = false, ruleBreached = false;

// ====================== Avvio ======================
(async function init() {
  try {
    S = await api('/sessions/' + sid);
    assets = await api('/assets');
    migrate();
    playbooks = await api('/playbooks').catch(() => []);
    const missing = [...new Set(S.layout.panes.map(p => p.symbol))].filter(sym => !assets.some(a => a.symbol === sym));
    if (missing.length || S.startTime < Math.max(...assets.filter(a => S.layout.panes.some(p => p.symbol === a.symbol)).map(a => a.from))) {
      document.body.innerHTML = `<p style="padding:24px;max-width:560px">Questa sessione usava dati che non sono più disponibili${missing.length ? ' (' + esc(missing.join(', ')) + ')' : ''}. <a href="/">Torna alla dashboard</a> per eliminarla e crearne una nuova.</p>`;
      return;
    }
    await Promise.all([...new Set(S.layout.panes.map(p => p.symbol))].map(ensureData));
  } catch (e) {
    document.body.innerHTML = '<p style="padding:24px">Sessione non trovata o dati non disponibili. <a href="/">Torna alla dashboard</a></p>';
    return;
  }
  S.settings = { candleStyle: 'mono', sync: true, ...(S.settings || {}) };
  S.rules = S.rules || { enabled: false };
  S.runtime = S.runtime || {};
  migrateJournal();
  for (const sym of new Set(S.layout.panes.map(p => p.symbol))) makeFeed(sym);
  const T0 = initialTime();
  await Promise.all([...feeds.values()].map(f => f.preload(T0))); // tick del giorno di partenza
  replay = new Replay(feeds, T0);
  replay.onEvents = handleEvents;
  document.title = `${S.name} – Backtest`;
  $('#sname').textContent = S.name;
  initTheme($('#themeBtn'), () => { panes.forEach(p => p.applyTheme()); });
  buildPanes();
  buildTools(); bindUI(); restoreTicket(S.settings.ticket);
  buildTfButtons(); renderAll();
  requestAnimationFrame(frame);
})();

// Sessioni create con la versione a grafico singolo: converte nel nuovo formato.
function migrateJournal() {
  S.journal = S.journal || {};
  S.journal.notes = S.journal.notes || ''; S.journal.trades = S.journal.trades || {}; S.journal.pos = S.journal.pos || {};
  for (const [k, v] of Object.entries(S.journal.tradeNotes || {})) if (v && !S.journal.trades[k]) S.journal.trades[k] = { notes: v };
  S.journal.tradeNotes = {};
}
function migrate() {
  if (S.layout) return;
  S.symbols = [S.symbol];
  S.layout = { type: '1', panes: [{ id: 'p1', symbol: S.symbol, tf: S.timeframe || '5', drawings: S.drawings || [] }] };
  S.accounts = S.account ? { [S.symbol]: S.account } : {};
  S._legacyCursor = S.cursorTime != null ? { t: S.cursorTime, sub: (S.settings && S.settings.sub) | 0 } : null;
  S.cursorTime = null;
}
function initialTime() {
  if (S._legacyCursor) {
    const D = candleCache.get(S.symbol), i = firstIndexAtOrAfter(D.t, S._legacyCursor.t), sub = S._legacyCursor.sub;
    return sub > 0 && i + 1 < D.t.length ? D.t[i + 1] + sub : D.t[i] + 60;
  }
  return S.cursorTime != null ? S.cursorTime : S.startTime - (S.startTime % 60);
}
async function ensureData(sym) {
  if (candleCache.has(sym)) return;
  candleCache.set(sym, await loadCandles(sym));
  const asset = assets.find(a => a.symbol === sym);
  let store = null;
  if (asset && asset.ticks) {
    const index = await loadTickIndex(sym).catch(() => null);
    if (index) {
      store = new TickStore(sym, index, loadTickDay);
      store.onError = () => toast(`Tick di ${sym} non disponibili per un giorno: uso i secondi simulati`, 'loss');
    }
  }
  tickCache.set(sym, store);
}
function makeFeed(sym) {
  const asset = assets.find(a => a.symbol === sym);
  S.accounts = S.accounts || {};
  const f = new Feed(asset, candleCache.get(sym), S.commission || 0, S.accounts[sym], tickCache.get(sym));
  f.cfg.slippage = S.slippage || 0;
  S.accounts[sym] = f.acc;
  feeds.set(sym, f);
  return f;
}
async function feedFor(sym) {
  if (feeds.has(sym)) return feeds.get(sym);
  await ensureData(sym);
  const f = makeFeed(sym);
  await f.preload(replay.T);
  replay.addFeed(f);
  return f;
}

// ====================== Conto ======================
const totalOpen = () => [...feeds.values()].reduce((a, f) => a + Broker.openPnl(f.cfg, f.acc, f.price()), 0);
const totalRealized = () => [...feeds.values()].reduce((a, f) => a + Broker.realizedPnl(f.acc), 0);
const totalEquity = () => S.capital + totalRealized() + totalOpen();
function allTrades() {
  const out = [];
  for (const f of feeds.values()) for (const t of f.acc.trades) out.push({ ...t, symbol: t.symbol || f.sym, key: `${f.sym}:${t.id}` });
  return out.sort((a, b) => a.exitTime - b.exitTime);
}
const statsAll = () => Broker.stats({ capital: S.capital }, { trades: allTrades() });

// ====================== Pannelli grafici ======================
const app = {
  T: () => replay.T,
  style: () => S.settings.candleStyle,
  activate: p => setActive(p),
  extFor: p => getExternal(p.feed),
  extMove, extCommit,
  drawingsChanged: () => { markSave(); if (!$('#drawer').hidden && drawerMode === 'layers') renderDrawer(); },
  selected: (p, item) => { if (p === active) buildPropbar(item); },
  toolChanged: t => { panes.forEach(p => { if (p.dr.tool !== t) p.dr.setTool(t); }); syncTools(t); },
  isActive: p => p === active,
  contextMenu: (p, info) => showContext(p, info),
  crosshair: (p, time) => {
    if (!S.settings.sync || syncing) return;
    syncing = true; panes.forEach(o => { if (o !== p) o.setCrosshairTime(time); }); syncing = false;
  },
};
function buildPanes() {
  panes.forEach(p => p.destroy()); panes = []; active = null;
  const wrap = $('#panes');
  wrap.className = 'layout-' + S.layout.type;
  const n = LAYOUTS[S.layout.type][1];
  S.layout.panes = S.layout.panes.slice(0, n);
  for (const conf of S.layout.panes) {
    const p = new Pane(app, conf, feeds.get(conf.symbol), wrap);
    p.rebuild(true); panes.push(p);
  }
  setActive(panes.find(p => p.conf.id === S.layout.active) || panes[0]);
  needUI = true;
}
function setActive(p) {
  if (!p) return;
  const changed = active !== p;
  active = p; S.layout.active = p.conf.id;
  panes.forEach(o => { o.setActive(o === p); if (o !== p) o.dr.select(null); });
  $('#symTxt').textContent = p.feed.sym;
  if (changed && replay) { buildTfButtons(); cardSig = ''; renderAll(); buildPropbar(p.dr.selected()); if (!$('#drawer').hidden) renderDrawer(); }
}
const refreshAll = () => { panes.forEach(p => { p.refresh(); p.flush(); }); };

// ====================== Replay ======================
function handleEvents(feed, ev) {
  needMarkers = true; needUI = true; markSave();
  for (const e of ev) {
    if (jumpSummary) { if (e.type === 'close') jumpSummary.n++; continue; }
    if (e.type === 'close') {
      const t = e.trade, why = { sl: 'Stop loss', tp: 'Take profit', manual: 'Chiusura' }[t.reason];
      toast(`${feed.sym} · ${why}: ${t.side === 'long' ? 'Long' : 'Short'} ${t.qty} · ${money(t.pnl)}${t.r != null ? ` (${fmt(t.r)} R)` : ''} — clic per il journal`, t.pnl >= 0 ? 'win' : 'loss', () => openJournal(`${feed.sym}:${t.id}`));
      queueShot(feed, 'exit', t);
      if (t.reason !== 'manual' && $('#pauseFill').checked) replay.stopReq = true;
    } else if (e.type === 'open' || e.type === 'add') {
      if (e.type === 'open') queueShot(feed, 'entry', { pid: e.pid });
      if (playing) { toast(`${feed.sym} · Ordine eseguito: ${e.side === 'buy' ? 'Buy' : 'Sell'} ${e.qty} @ ${fmt(e.price)}`); if ($('#pauseFill').checked) replay.stopReq = true; }
    } else if (e.type === 'alert') {
      toast(`🔔 ${feed.sym} ha raggiunto ${fmt(e.alert.price)}`, 'win'); replay.stopReq = true;
    }
  }
}

// ---- Screenshot automatici di ingresso/uscita (salvati sul server, collegati al journal del trade) ----
const tradeJ = key => (S.journal.trades[key] = S.journal.trades[key] || {});
let shotsPending = 0;
async function captureShot(pane, name) {
  const src = pane.chart.takeScreenshot(), ov = pane.el.querySelector('.ov');
  src.getContext('2d').drawImage(ov, 0, 0, src.width, src.height);
  const k = Math.min(1, 900 / src.width), out = document.createElement('canvas');
  out.width = Math.round(src.width * k); out.height = Math.round(src.height * k);
  out.getContext('2d').drawImage(src, 0, 0, out.width, out.height);
  const blob = await new Promise(r => out.toBlob(r, 'image/jpeg', 0.72));
  const res = await fetch(`/api/sessions/${sid}/shots?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
  return res.ok ? (await res.json()).url : null;
}
function queueShot(feed, kind, t) {
  if (S.settings.autoShots === false || jumpSummary || shotsPending >= 3) return;
  const pane = panes.find(p => p.feed === feed); if (!pane) return;
  shotsPending++;
  setTimeout(async () => {
    try {
      const name = kind === 'entry' ? `${feed.sym}-p${t.pid}-entry` : `${feed.sym}-t${t.id}-exit`;
      const url = await captureShot(pane, name);
      if (!url) return;
      if (kind === 'entry') {
        S.journal.pos[`${feed.sym}:${t.pid}`] = url;
        for (const x of feed.acc.trades) if (x.pid === t.pid) { const j = tradeJ(`${feed.sym}:${x.id}`); j.shots = { ...j.shots, entry: url }; }
      } else {
        const j = tradeJ(`${feed.sym}:${t.id}`), entry = S.journal.pos[`${feed.sym}:${t.pid}`];
        j.shots = { ...j.shots, exit: url, ...(entry ? { entry } : {}) };
      }
      markSave();
    } catch { /* gli screenshot sono facoltativi */ } finally { shotsPending--; }
  }, 300);
}

const unitVal = () => $('#unit').value; // 'tick' oppure secondi
const advanceUnit = () => (unitVal() === 'tick' ? replay.stepEvent() : replay.advance(+unitVal()));
function setPlaying(p) {
  playing = p; replay.stopReq = false; accT = 0;
  $('#play').textContent = p ? '⏸' : '▶';
  if (!p) saveNow();
}
let lastT = performance.now(), accT = 0, uiT = 0, prefetchT = 0;
function frame(now) {
  const dt = Math.min(0.25, (now - lastT) / 1000); lastT = now;
  if (playing) {
    accT += dt * RATES[+$('#speed').value - 1];
    let n = Math.min(Math.floor(accT), 200); accT -= Math.floor(accT);
    let ok = true;
    while (n-- > 0 && ok && !replay.stopReq) { ok = advanceUnit(); if (replay.waiting) break; } // se attende i tick riprova al frame dopo
    if (!ok) { setPlaying(false); toast('Fine dei dati disponibili'); }
    else if (replay.stopReq) setPlaying(false);
    markSave(); needUI = needUI || now - uiT > 200;
  }
  if (now - prefetchT > 1000) { prefetchT = now; replay.all().forEach(f => f.preload(replay.T)); }
  refreshAll();
  if (needMarkers) { panes.forEach(p => p.markers()); needMarkers = false; }
  if (needUI) { renderAll(); uiT = now; needUI = false; }
  requestAnimationFrame(frame);
}
function stepUnit() {
  if (playing) setPlaying(false);
  replay.stopReq = false;
  if (!advanceUnit() && !replay.waiting) toast('Fine dei dati disponibili');
  if (replay.waiting) toast('Caricamento dei tick in corso… riprova tra un istante');
  needUI = true; markSave();
}
function stepBar() {
  if (playing) setPlaying(false);
  replay.stopReq = false;
  const b = active.bars[active.bars.length - 1], sec = tfSec(active.tf);
  const rem = b ? b.time + sec - replay.T : sec;
  replay.advance(rem > 0 ? rem : sec);
  needUI = true; markSave();
}
async function jumpTo(target) {
  if (target <= replay.T) { toast('Puoi saltare solo in avanti nel tempo'); return false; }
  if (playing) setPlaying(false);
  jumpSummary = { n: 0 };
  await replay.jumpTo(target);
  const n = jumpSummary.n; jumpSummary = null;
  panes.forEach(p => p.rebuild(true)); needUI = true; markSave();
  if (n) toast(`Durante il salto sono state chiuse ${n} operazioni`);
  return true;
}
function nextOpen(from) { // prossima apertura regolare 09:30 ET dopo `from`
  let d = Math.floor(from / 86400) * 86400 + 34200;
  if (d <= from) d += 86400;
  return d;
}

// ====================== Ordini ======================
const act = () => active.feed;
function sizeInfo(f = act()) {
  const px = f.price(), type = $('#otype .on').dataset.t;
  const price = type === 'market' ? px : +$('#oprice').value;
  const slp = +$('#osl').value || 0, tpp = +$('#otp').value || 0, trail = +$('#otrail').value || 0;
  let qty = Math.floor(+$('#oqty').value) || 0;
  if ($('#sizeMode .on').dataset.m === 'risk') qty = slp > 0 ? Math.floor(totalEquity() * (+$('#orisk').value || 0) / 100 / (slp * f.cfg.pointValue)) : 0;
  return { px, type, price, slp, tpp, trail, qty };
}
function feedBar(f) { const p = f.price(); return { t: replay.T, o: p, h: p, l: p, c: p }; }
function updateTicket() {
  const f = act(), s = sizeInfo(f), end = replay.nextMinute() === Infinity && !replay.all().some(x => x.m);
  $('#otitle').textContent = `Ordine · ${f.sym}`;
  $('#sellPx').textContent = $('#buyPx').textContent = fmt(s.px);
  $('#priceRow').hidden = s.type === 'market';
  const risk = $('#sizeMode .on').dataset.m === 'risk';
  $('#qtyRow').hidden = risk; $('#riskRow').hidden = !risk;
  const parts = [];
  if (risk) parts.push(`Contratti: <b>${s.qty}</b>`);
  if (s.slp > 0 && s.qty) parts.push(`Rischio: <b class="down">${money(s.slp * f.cfg.pointValue * s.qty)}</b>`);
  if (s.tpp > 0 && s.qty) parts.push(`Target: <b class="up">${money(s.tpp * f.cfg.pointValue * s.qty)}</b>`);
  if (s.slp > 0 && s.tpp > 0) parts.push(`R:R <b>${fmt(s.tpp / s.slp)}</b>`);
  if (risk && !s.slp) parts.push('Imposta uno stop loss per calcolare la size');
  $('#oinfo').innerHTML = parts.join(' · ');
  const dis = end || s.qty < 1;
  $('#buy').disabled = $('#sell').disabled = $('#fBuy').disabled = $('#fSell').disabled = dis;
}
const tagTrades = (f, ev) => { ev.forEach(e => { if (e.trade) e.trade.symbol = f.sym; }); return ev; };
function submitOrder(side, fromFooter, over) {
  const f = act(), s = sizeInfo(f), d = Broker.dirOf(side), errEl = fromFooter || over ? $('#fErr') : $('#oerr');
  $('#fErr').textContent = ''; $('#oerr').textContent = '';
  const type = over ? over.type : fromFooter ? 'market' : s.type, raw = over ? over.price : fromFooter ? s.px : s.price;
  if (type !== 'market' && !(raw > 0)) { errEl.textContent = 'Inserisci il prezzo'; return; }
  const price = type === 'market' ? raw : Broker.snap(raw, f.cfg.tickSize);
  const sl = s.slp > 0 ? Broker.snap(price - d * s.slp, f.cfg.tickSize) : null;
  const tp = s.tpp > 0 ? Broker.snap(price + d * s.tpp, f.cfg.tickSize) : null;
  const r = Broker.placeOrder(f.cfg, f.acc, { type, side, qty: s.qty, price, sl, tp, trail: s.trail > 0 ? s.trail : null }, feedBar(f));
  if (r.error) { errEl.textContent = r.error; toast(r.error, 'loss'); return; }
  handleEvents(f, tagTrades(f, r.events)); needMarkers = true; needUI = true; markSave();
}
const closeAll = f => handleEvents(f, tagTrades(f, Broker.closePosition(f.cfg, f.acc, feedBar(f))));
const closePart = (f, qty) => handleEvents(f, tagTrades(f, Broker.closePosition(f.cfg, f.acc, feedBar(f), 'manual', qty)));
function reverse(f) {
  const p = f.acc.position; if (!p) return;
  const r = Broker.placeOrder(f.cfg, f.acc, { type: 'market', side: p.dir === 1 ? 'sell' : 'buy', qty: p.qty * 2 }, feedBar(f));
  handleEvents(f, tagTrades(f, r.events));
}
function addLevel(f, key) { // crea SL (20 pt) o TP (40 pt) dal prezzo attuale: poi si trascina sul grafico
  const p = f.acc.position; if (!p) return;
  const px = f.price(), v = key === 'sl' ? px - p.dir * 20 : px + p.dir * 40;
  Broker.setLevels(f.acc, { [key]: Broker.snap(v, f.cfg.tickSize) });
  if (p.sl != null) p.risk = Math.abs(p.entry - p.sl) * p.qty * f.cfg.pointValue;
  needUI = true; markSave();
}
function breakeven(f) {
  const p = f.acc.position; if (!p) return;
  if ((f.price() - p.entry) * p.dir <= 0) { toast('Il prezzo non è in profitto: impossibile spostare lo stop a pareggio'); return; }
  Broker.setLevels(f.acc, { sl: Broker.snap(p.entry, f.cfg.tickSize) }); needUI = true; markSave();
}

// Linee operative sul grafico (trascinabili): posizione, SL, TP, ordini pendenti
function getExternal(f) {
  const out = [], px = f.price(), p = f.acc.position, cfg = f.cfg;
  if (p) {
    const pnl = (px - p.entry) * p.dir * p.qty * cfg.pointValue, val = lvl => (lvl - p.entry) * p.dir * p.qty * cfg.pointValue;
    out.push({ id: 'pos:entry', price: p.entry, color: '#2962ff', label: `${p.dir === 1 ? 'LONG' : 'SHORT'} ${p.qty}  ${money(pnl)}` });
    if (p.sl != null) out.push({ id: 'pos:sl', price: p.sl, color: '#f23645', dash: 1, draggable: true, label: `SL ${money(val(p.sl))}` });
    if (p.tp != null) out.push({ id: 'pos:tp', price: p.tp, color: '#089981', dash: 1, draggable: true, label: `TP ${money(val(p.tp))}` });
  }
  for (const a of f.acc.alerts || []) out.push({ id: `alert:${a.id}:price`, price: a.price, color: '#ffb300', dash: 1, draggable: true, label: `🔔 ${fmt(a.price)}` });
  for (const o of f.acc.orders) {
    const d = Broker.dirOf(o.side);
    out.push({ id: `ord:${o.id}:price`, price: o.price, color: '#ff9800', dash: 1, draggable: true, label: `${o.type.toUpperCase()} ${o.side.toUpperCase()} ${o.qty}` });
    if (o.sl != null) out.push({ id: `ord:${o.id}:sl`, price: o.sl, color: '#f23645', dash: 1, draggable: true, label: `SL ${money((o.sl - o.price) * d * o.qty * cfg.pointValue)}` });
    if (o.tp != null) out.push({ id: `ord:${o.id}:tp`, price: o.tp, color: '#089981', dash: 1, draggable: true, label: `TP ${money((o.tp - o.price) * d * o.qty * cfg.pointValue)}` });
  }
  return out;
}
function extTarget(f, id) {
  const [kind, a, b] = id.split(':');
  if (kind === 'pos') return { obj: f.acc.position, key: a };
  if (kind === 'alert') return { obj: (f.acc.alerts || []).find(x => x.id === +a), key: 'price', alert: true };
  const o = f.acc.orders.find(x => x.id === +a);
  return { obj: o, key: b, order: o };
}
function extMove(pane, id, price) {
  const { obj, key } = extTarget(pane.feed, id); if (!obj) return;
  const k = pane.feed.sym + id;
  if (!(k in extOrig)) extOrig[k] = obj[key];
  obj[key] = price; needUI = true;
}
function extCommit(pane, id, price) {
  const f = pane.feed, { obj, key, order, alert } = extTarget(pane.feed, id), k = f.sym + id;
  if (!obj) { delete extOrig[k]; return; }
  const px = f.price(), orig = extOrig[k]; delete extOrig[k];
  if (alert) { obj.price = price; obj.dir = price >= px ? 'up' : 'down'; needUI = true; markSave(); return; }
  const dir = order ? Broker.dirOf(order.side) : obj.dir, ref = order ? order.price : px;
  let ok = true;
  if (key === 'sl') ok = (ref - price) * dir > 0;
  else if (key === 'tp') ok = (price - ref) * dir > 0;
  else if (key === 'price') ok = order.type === 'limit' ? (dir === 1 ? price < px : price > px) : (dir === 1 ? price > px : price < px);
  if (!ok) { obj[key] = orig; toast('Livello non valido, ripristinato'); }
  else {
    obj[key] = price;
    if (obj === f.acc.position && obj.sl != null) obj.risk = Math.abs(obj.entry - obj.sl) * obj.qty * f.cfg.pointValue;
  }
  needUI = true; markSave();
}

// ====================== Rendering UI ======================
function renderAll() {
  if (!active) return;
  const eq = totalEquity();
  $('#balance').textContent = money(eq); $('#balance').className = 'balance ' + (eq >= S.capital ? 'up' : 'down');
  const tk = replay.all().some(f => f.ticksMode);
  $('#clock').textContent = fmtDT(replay.T, true, tk) + ' ET' + (replay.waiting ? ' · carico i tick…' : '');
  updateTicket(); renderPosCard(); renderTabs(); evalRules();
  if (!$('#drawer').hidden && drawerMode === 'journal' && journalCount !== allTrades().length && !$('#drawer').contains(document.activeElement)) renderDrawer();
}
let cardSig = '';
function renderPosCard() {
  const f = act(), p = f.acc.position, el = $('#posCard');
  const sig = f.sym + (p ? `${p.dir}|${p.qty}|${p.entry}|${p.sl != null}|${p.tp != null}` : 'none');
  if (sig !== cardSig) {
    cardSig = sig;
    if (!p) el.innerHTML = `<div class="muted">Nessuna posizione aperta su ${f.sym}.</div>`;
    else {
      el.innerHTML = `
      <div class="kv">Posizione<b class="${p.dir === 1 ? 'up' : 'down'}">${p.dir === 1 ? 'LONG' : 'SHORT'} ${p.qty} × ${f.sym}</b></div>
      <div class="kv">Prezzo medio<b>${fmt(p.entry)}</b></div>
      <div class="kv">P&amp;L aperto<b id="pcPnl"></b></div>
      <div class="two" style="margin-top:6px">
        <label class="fld">Stop loss<input id="pcSl" type="number" step="${f.cfg.tickSize}" placeholder="—"></label>
        <label class="fld">Take profit<input id="pcTp" type="number" step="${f.cfg.tickSize}" placeholder="—"></label>
      </div>
      <label class="fld" style="margin-top:6px">Trailing stop (pt, vuoto = off)<input id="pcTrail" type="number" min="0" step="${f.cfg.tickSize}" placeholder="—"></label>
      <div class="muted small" style="margin-top:6px">Trascina le linee SL/TP sul grafico per modificarle.</div>
      <div class="partial"><button class="btn" data-pct="25" ${p.qty < 2 ? 'disabled' : ''}>25%</button><button class="btn" data-pct="50" ${p.qty < 2 ? 'disabled' : ''}>50%</button><button class="btn" data-pct="75" ${p.qty < 2 ? 'disabled' : ''}>75%</button><input id="pcQ" type="number" min="1" max="${p.qty}" value="1" title="Contratti da chiudere"><button class="btn" id="pcQb">Chiudi qtà</button></div>
      <div class="btns"><button id="pcClose" class="btn danger">Chiudi tutto</button><button id="pcRev" class="btn">Inverti</button><button id="pcBe" class="btn">SL a pareggio</button>
      ${p.sl == null ? '<button id="pcAddSl" class="btn">+ Stop loss</button>' : ''}${p.tp == null ? '<button id="pcAddTp" class="btn">+ Take profit</button>' : ''}</div>`;
      $('#pcClose').onclick = () => closeAll(f); $('#pcRev').onclick = () => reverse(f); $('#pcBe').onclick = () => breakeven(f);
      if ($('#pcAddSl')) $('#pcAddSl').onclick = () => addLevel(f, 'sl');
      if ($('#pcAddTp')) $('#pcAddTp').onclick = () => addLevel(f, 'tp');
      el.querySelectorAll('[data-pct]').forEach(b => b.onclick = () => closePart(f, Math.max(1, Math.round(f.acc.position.qty * +b.dataset.pct / 100))));
      $('#pcQb').onclick = () => closePart(f, Math.floor(+$('#pcQ').value) || 1);
      $('#pcTrail').onchange = e => { const v = +e.target.value; Broker.setLevels(f.acc, { trail: v > 0 ? v : null }); markSave(); };
      for (const [id, key] of [['#pcSl', 'sl'], ['#pcTp', 'tp']]) $(id).onchange = e => {
        const v = e.target.value === '' ? null : Broker.snap(+e.target.value, f.cfg.tickSize), pos = f.acc.position, px = f.price();
        if (v != null && ((key === 'sl' && (px - v) * pos.dir <= 0) || (key === 'tp' && (v - px) * pos.dir <= 0))) { toast('Livello non valido rispetto al prezzo attuale'); cardSig = ''; needUI = true; return; }
        Broker.setLevels(f.acc, { [key]: v });
        if (pos.sl != null) pos.risk = Math.abs(pos.entry - pos.sl) * pos.qty * f.cfg.pointValue;
        markSave();
      };
    }
  }
  if (p) {
    const u = Broker.openPnl(f.cfg, f.acc, f.price());
    $('#pcPnl').textContent = money(u); $('#pcPnl').className = u >= 0 ? 'up' : 'down';
    for (const [id, v] of [['#pcSl', p.sl], ['#pcTp', p.tp], ['#pcTrail', p.trail]]) { const inp = $(id); if (inp && document.activeElement !== inp) inp.value = v ?? ''; }
  }
}
let tabSig = {};
function renderTabs() {
  if ($('#bottom').hidden) return;
  const open = $('#tab-pos'), hist = $('#tab-hist'), st = $('#tab-stats');
  if (!open.hidden) {
    const rows = [];
    for (const f of feeds.values()) if (f.acc.position) rows.push({ f, p: f.acc.position });
    const s1 = JSON.stringify([rows.map(r => [r.f.sym, r.p]), [...feeds.values()].map(f => f.acc.orders)]);
    if (tabSig.pos !== s1) {
      tabSig.pos = s1;
      let h = '<table><thead><tr><th class="l">Simbolo</th><th>Tipo</th><th>Lato</th><th>Qtà</th><th>Prezzo</th><th>SL</th><th>TP</th><th>P&amp;L</th><th></th></tr></thead><tbody>';
      for (const { f, p } of rows) h += `<tr><td class="l">${f.sym}</td><td>Posizione</td><td class="${p.dir === 1 ? 'up' : 'down'}">${p.dir === 1 ? 'Long' : 'Short'}</td><td>${p.qty}</td><td>${fmt(p.entry)}</td><td>${p.sl != null ? fmt(p.sl) : '–'}</td><td>${p.tp != null ? fmt(p.tp) : '–'}</td><td data-pnl="${f.sym}"></td><td><button data-close="${f.sym}">Chiudi</button></td></tr>`;
      for (const f of feeds.values()) for (const o of f.acc.orders) h += `<tr><td class="l">${f.sym}</td><td>${o.type === 'limit' ? 'Limit' : 'Stop'}</td><td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? 'Buy' : 'Sell'}</td><td>${o.qty}</td><td>${fmt(o.price)}</td><td>${o.sl != null ? fmt(o.sl) : '–'}</td><td>${o.tp != null ? fmt(o.tp) : '–'}</td><td>–</td><td><button data-cancel="${f.sym}:${o.id}">Annulla</button></td></tr>`;
      if (!h.includes('<td')) h += '<tr><td class="l muted" colspan="9">Nessuna posizione o ordine aperto</td></tr>';
      open.innerHTML = h + '</tbody></table>';
      open.querySelectorAll('[data-close]').forEach(b => b.onclick = () => closeAll(feeds.get(b.dataset.close)));
      open.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => { const [sym, id] = b.dataset.cancel.split(':'); Broker.cancelOrder(feeds.get(sym).acc, +id); needUI = true; tabSig = {}; markSave(); });
    }
    open.querySelectorAll('[data-pnl]').forEach(c => { const f = feeds.get(c.dataset.pnl), u = Broker.openPnl(f.cfg, f.acc, f.price()); c.textContent = money(u); c.className = u >= 0 ? 'up' : 'down'; });
  }
  if (!hist.hidden) {
    const tr = allTrades(), s2 = tr.length + '|' + (tr.at(-1)?.key);
    if (tabSig.hist !== s2) {
      tabSig.hist = s2;
      let h = '<table><thead><tr><th>#</th><th class="l">Simbolo</th><th class="l">Lato</th><th>Qtà</th><th>Ingresso</th><th>Prezzo</th><th>Uscita</th><th>Prezzo</th><th>P&amp;L</th><th>R</th><th class="l">Motivo</th></tr></thead><tbody>';
      tr.map((t, k) => ({ t, n: k + 1 })).reverse().forEach(({ t, n }) => {
        h += `<tr><td>${n}</td><td class="l">${t.symbol}</td><td class="l ${t.side === 'long' ? 'up' : 'down'}">${t.side === 'long' ? 'Long' : 'Short'}</td><td>${t.qty}</td><td>${fmtDT(t.entryTime, true)}</td><td>${fmt(t.entry)}</td><td>${fmtDT(t.exitTime, true)}</td><td>${fmt(t.exit)}</td><td class="${t.pnl >= 0 ? 'up' : 'down'}">${money(t.pnl)}</td><td>${t.r != null ? fmt(t.r) : '–'}</td><td class="l">${{ sl: 'Stop loss', tp: 'Take profit', manual: 'Manuale' }[t.reason]}</td></tr>`;
      });
      if (!tr.length) h += '<tr><td class="l muted" colspan="11">Nessuna operazione chiusa</td></tr>';
      hist.innerHTML = h + '</tbody></table>';
    }
  }
  if (!st.hidden && tabSig.stats !== String(allTrades().length)) {
    tabSig.stats = String(allTrades().length);
    const s = statsAll(), pf = s.profitFactor === Infinity ? '∞' : fmt(s.profitFactor);
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
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const c = cv.getContext('2d'); c.scale(dpr, dpr);
  const vs = curve.map(p => p.v), lo = Math.min(...vs), hi = Math.max(...vs), pad = (hi - lo || 1) * 0.1;
  const X = k => 8 + (curve.length < 2 ? 0 : k / (curve.length - 1) * (w - 16)), Y = v => h - 12 - (v - lo + pad) / (hi - lo + 2 * pad) * (h - 24);
  c.strokeStyle = css('--line'); c.beginPath(); c.moveTo(0, Y(S.capital)); c.lineTo(w, Y(S.capital)); c.stroke();
  c.strokeStyle = css('--accent'); c.lineWidth = 2; c.beginPath();
  curve.forEach((p, k) => k ? c.lineTo(X(k), Y(p.v)) : c.moveTo(X(k), Y(p.v)));
  if (curve.length < 2) { c.fillStyle = css('--dim'); c.fillText('Equity curve (si popola con le operazioni chiuse)', 10, 20); }
  c.stroke();
}
function exportCsv() {
  const rows = [['simbolo', 'lato', 'qty', 'ingresso_ET', 'prezzo_ingresso', 'uscita_ET', 'prezzo_uscita', 'pnl', 'R', 'motivo', 'nota']];
  for (const t of allTrades()) rows.push([t.symbol, t.side, t.qty, fmtDT(t.entryTime, true), t.entry, fmtDT(t.exitTime, true), t.exit, t.pnl.toFixed(2), t.r != null ? t.r.toFixed(2) : '', t.reason, JSON.stringify(((S.journal.trades[t.key] || {}).notes) || '')]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' }));
  a.download = `${S.name.replace(/[^\w-]+/g, '_')}_trades.csv`; a.click();
}

// ====================== Prop Firm Rules ======================
function evalRules() {
  const r = S.rules, dot = $('#rulesDot');
  if (!r.enabled) { dot.className = ''; const b = $('#ruleBanner'); if (b) b.remove(); return; }
  const eq = totalEquity(), rt = S.runtime, dk = sessionKey(replay.T);
  if (rt.dayKey !== dk) { rt.dayKey = dk; rt.dayStartEq = eq; }
  rt.peak = Math.max(rt.peak ?? S.capital, eq);
  const dd = (r.trailing ? rt.peak : S.capital) - eq, dl = rt.dayStartEq - eq;
  const bad = (r.maxDailyLoss > 0 && dl >= r.maxDailyLoss) || (r.maxDrawdown > 0 && dd >= r.maxDrawdown);
  dot.className = bad ? 'bad' : 'ok';
  if (bad && !ruleBreached) {
    ruleBreached = true; toast('Regola Prop Firm violata!', 'loss'); if (playing) setPlaying(false);
    if (r.autoFlatten) for (const f of feeds.values()) { f.acc.orders = []; if (f.acc.position) closeAll(f); } // chiude tutto e annulla gli ordini
  }
  if (!bad) ruleBreached = false;
  const ban = $('#ruleBanner');
  if (bad && !ban) { const b = document.createElement('div'); b.id = 'ruleBanner'; b.className = 'banner'; b.textContent = 'Limite delle regole Prop Firm raggiunto'; $('#stage').prepend(b); }
  if (!bad && ban) ban.remove();
}
function openRules() {
  const r = S.rules, rt = S.runtime, eq = totalEquity();
  const dl = rt.dayStartEq != null ? rt.dayStartEq - eq : 0, dd = (r.trailing ? (rt.peak ?? S.capital) : S.capital) - eq, pr = eq - S.capital;
  const bar = (v, max, bad) => `<div class="bar ${bad ? 'bad' : ''}"><i style="width:${max > 0 ? Math.max(0, Math.min(100, v / max * 100)) : 0}%"></i></div>`;
  openModal(`<h3>Prop Firm Rules</h3>
    <div class="row"><label>Regole attive</label><input type="checkbox" id="rEn" ${r.enabled ? 'checked' : ''}></div>
    <div class="row"><label>Obiettivo di profitto ($)</label><input type="number" id="rTarget" min="0" step="100" value="${r.target || ''}"></div>
    <div class="row"><label>Perdita massima giornaliera ($)</label><input type="number" id="rDaily" min="0" step="100" value="${r.maxDailyLoss || ''}"></div>
    <div class="row"><label>Drawdown massimo ($)</label><input type="number" id="rDd" min="0" step="100" value="${r.maxDrawdown || ''}"></div>
    <div class="row"><label>Drawdown trailing (dal massimo di equity)</label><input type="checkbox" id="rTrail" ${r.trailing ? 'checked' : ''}></div>
    <div class="row"><label>Chiudi tutto e annulla gli ordini alla violazione</label><input type="checkbox" id="rFlat" ${r.autoFlatten ? 'checked' : ''}></div>
    ${r.enabled ? `<div style="margin-top:10px">Profitto: <b>${money(pr)}</b>${r.target ? ` / ${money(r.target)}` : ''}${bar(pr, r.target, false)}
    Perdita di oggi: <b>${money(Math.max(0, dl))}</b>${r.maxDailyLoss ? ` / ${money(r.maxDailyLoss)}` : ''}${bar(dl, r.maxDailyLoss, r.maxDailyLoss && dl >= r.maxDailyLoss)}
    Drawdown: <b>${money(Math.max(0, dd))}</b>${r.maxDrawdown ? ` / ${money(r.maxDrawdown)}` : ''}${bar(dd, r.maxDrawdown, r.maxDrawdown && dd >= r.maxDrawdown)}</div>` : ''}
    <div style="text-align:right;margin-top:12px"><button class="btn primary" id="rOk">Salva</button></div>`, () => {
    $('#rOk').onclick = () => {
      S.rules = { enabled: $('#rEn').checked, target: +$('#rTarget').value || 0, maxDailyLoss: +$('#rDaily').value || 0, maxDrawdown: +$('#rDd').value || 0, trailing: $('#rTrail').checked, autoFlatten: $('#rFlat').checked };
      S.runtime = {}; ruleBreached = false; needUI = true; markSave(); closeModal();
    };
  });
}

// ====================== Salvataggio ======================
function stateObj() {
  const sm = statsAll();
  return {
    cursorTime: replay.T, schema: 2, layout: S.layout, accounts: S.accounts, journal: S.journal, rules: S.rules, runtime: S.runtime,
    settings: { ...S.settings, ticket: collectTicket() },
    summary: { n: sm.n, total: sm.total, winRate: sm.winRate, equity: totalEquity() },
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
addEventListener('pagehide', () => { if (saveDirty && S && replay) navigator.sendBeacon('/api/sessions/' + sid + '/save', new Blob([JSON.stringify(stateObj())], { type: 'application/json' })); });
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

// ====================== UI generica ======================
function toast(msg, cls = '', onClick = null) {
  const d = document.createElement('div'); d.textContent = msg; if (cls) d.className = cls;
  if (onClick) { d.classList.add('act'); d.onclick = () => { d.remove(); onClick(); }; }
  $('#toast').append(d); setTimeout(() => d.remove(), onClick ? 9000 : 4500);
  while ($('#toast').children.length > 4) $('#toast').firstChild.remove();
}
function openModal(html, mount) {
  const m = $('#modal'); m.hidden = false;
  m.innerHTML = `<div class="dlg">${html}</div>`;
  m.onclick = e => { if (e.target === m) closeModal(); };
  mount && mount(m);
}
const closeModal = () => { $('#modal').hidden = true; };
function popMenuAt(x, y, items, onPick, current) {
  $$('.menu').forEach(m => m.remove());
  const m = document.createElement('div'); m.className = 'menu';
  m.innerHTML = items.map(([v, l]) => `<button data-v="${v}" class="${v === current ? 'on' : ''}">${esc(l)}</button>`).join('');
  document.body.append(m);
  m.style.left = Math.max(4, Math.min(x, innerWidth - m.offsetWidth - 8)) + 'px'; m.style.top = Math.max(4, Math.min(y, innerHeight - m.offsetHeight - 8)) + 'px';
  m.onclick = e => { const b = e.target.closest('button'); if (b) { m.remove(); onPick(b.dataset.v); } };
  setTimeout(() => document.addEventListener('mousedown', function h(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', h); } }), 0);
}
function popMenu(anchor, items, onPick, current) { const r = anchor.getBoundingClientRect(); popMenuAt(r.left, r.bottom + 4, items, onPick, current); }

// Menu del clic destro sul grafico: ordini a prezzo, alert, linea orizzontale
function showContext(pane, info) {
  setActive(pane);
  const f = pane.feed, px = f.price(), tick = f.cfg.tickSize, price = Broker.snap(info.price, tick), P = fmt(price);
  const near = Math.abs(price - px) < tick / 2;
  const buyT = near ? 'market' : price < px ? 'limit' : 'stop', sellT = near ? 'market' : price > px ? 'limit' : 'stop';
  const items = [];
  if (info.ext && info.ext.startsWith('alert:')) items.push(['del-alert', '🔔 Elimina questo alert']);
  if (info.ext && info.ext.startsWith('ord:') && info.ext.endsWith(':price')) items.push(['del-order', '✕ Annulla questo ordine']);
  items.push(['buy', `▲ Compra ${buyT} @ ${P}`], ['sell', `▼ Vendi ${sellT} @ ${P}`], ['alert', `🔔 Alert a ${P}`], ['hline', `— Linea orizzontale a ${P}`], ['copy', `⧉ Copia prezzo ${P}`]);
  popMenuAt(info.clientX, info.clientY, items, v => {
    if (v === 'buy') submitOrder('buy', false, { type: buyT, price });
    else if (v === 'sell') submitOrder('sell', false, { type: sellT, price });
    else if (v === 'alert') { Broker.addAlert(f.acc, price, px); toast(`Alert impostato a ${P}`); needUI = true; markSave(); }
    else if (v === 'del-alert') { Broker.removeAlert(f.acc, +info.ext.split(':')[1]); needUI = true; markSave(); }
    else if (v === 'del-order') { Broker.cancelOrder(f.acc, +info.ext.split(':')[1]); needUI = true; tabSig = {}; markSave(); }
    else if (v === 'hline') {
      const d = pane.dr.newItem('hline', [{ t: info.time ?? pane.bars[pane.bars.length - 1].time, p: price }]);
      pane.dr.snapshot(); pane.dr.items.push(d); pane.dr.select(d.id); pane.dr.commit();
    } else if (v === 'copy') navigator.clipboard && navigator.clipboard.writeText(String(price)).catch(() => {});
  });
}
function openAlerts() {
  const f = act();
  const draw = () => {
    openModal(`<h3>Alert · ${f.sym}</h3>
      <div class="row"><label>Nuovo alert al prezzo</label><input type="number" id="alP" step="${f.cfg.tickSize}" value="${f.price()}"><button class="btn primary" id="alAdd">Aggiungi</button></div>
      ${(f.acc.alerts || []).length ? f.acc.alerts.map(a => `<div class="row"><label>${a.dir === 'up' ? '▲ sopra' : '▼ sotto'} ${fmt(a.price)}</label><button class="btn small danger" data-del="${a.id}">Elimina</button></div>`).join('') : '<p class="muted">Nessun alert. Puoi anche usare il clic destro sul grafico.</p>'}
      <p class="muted small">Quando il prezzo raggiunge il livello il replay si mette in pausa.</p>
      <div style="text-align:right;margin-top:10px"><button class="btn primary" id="alOk">Chiudi</button></div>`, () => {
      $('#alAdd').onclick = () => { const v = +$('#alP').value; if (v > 0) { Broker.addAlert(f.acc, Broker.snap(v, f.cfg.tickSize), f.price()); markSave(); needUI = true; draw(); } };
      $$('#modal [data-del]').forEach(b => b.onclick = () => { Broker.removeAlert(f.acc, +b.dataset.del); markSave(); needUI = true; draw(); });
      $('#alOk').onclick = closeModal;
    });
  };
  draw();
}
function makeDraggable(el) {
  const grip = el.querySelector('.grip');
  grip.addEventListener('mousedown', e => {
    e.preventDefault();
    const st = $('#stage').getBoundingClientRect(), r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    el.style.transform = 'none'; el.style.right = 'auto';
    const mv = ev => { el.style.left = Math.max(0, Math.min(st.width - 60, ev.clientX - st.left - dx)) + 'px'; el.style.top = Math.max(0, Math.min(st.height - 30, ev.clientY - st.top - dy)) + 'px'; };
    const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  });
}

function buildTfButtons() {
  const box = $('#tfs'), tf = active.tf;
  const list = QUICK_TFS.includes(tf) ? QUICK_TFS : [...QUICK_TFS, tf];
  box.innerHTML = list.map(id => `<button data-tf="${id}" class="${id === tf ? 'on' : ''}">${TFS.find(t => t.id === id).label}</button>`).join('') + '<button data-more="1">▾</button>';
  box.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.more) { popMenu(b, TFS.map(t => [t.id, t.label]), setTf, active.tf); return; }
    setTf(b.dataset.tf);
  };
}
function setTf(id) { active.setTf(id); buildTfButtons(); markSave(); }

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
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
};
function buildTools() {
  const mk = (key, title) => `<button data-k="${key}" title="${title}"><svg viewBox="0 0 24 24">${ICON[key]}</svg></button>`;
  $('#tools').innerHTML =
    mk('cursor', 'Cursore (Esc)') + '<hr>' +
    ['trend', 'ray', 'arrow', 'hline', 'vline', 'channel', 'fib', 'rect', 'longpos', 'shortpos', 'text', 'brush', 'measure'].map(k => mk(k, TOOLS[k].name)).join('') + '<hr>' +
    mk('magnet', 'Magnete (aggancia a O/H/L/C)') + mk('stay', 'Resta in modalità disegno') + mk('lock', 'Blocca tutti i disegni') + mk('eye', 'Mostra/nascondi disegni') + mk('link', 'Sincronizza il cursore tra i grafici') + mk('trash', 'Elimina tutti i disegni');
  $('#tools [data-k=link]').classList.toggle('on', S.settings.sync);
  $('#tools').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    const k = b.dataset.k, all = fn => panes.forEach(fn);
    if (k === 'cursor') all(p => p.dr.setTool(null));
    else if (TOOLS[k]) { const cur = active.dr.tool; all(p => p.dr.setTool(cur === k ? null : k)); }
    else if (k === 'magnet') { const v = !active.dr.magnet; all(p => { p.dr.magnet = v; }); b.classList.toggle('on', v); }
    else if (k === 'stay') { const v = !active.dr.stay; all(p => { p.dr.stay = v; }); b.classList.toggle('on', v); }
    else if (k === 'lock') { const v = !active.dr.lockAll; all(p => { p.dr.lockAll = v; }); b.classList.toggle('on', v); }
    else if (k === 'eye') { const v = !active.dr.hidden; all(p => { p.dr.hidden = v; }); b.classList.toggle('on', v); }
    else if (k === 'link') { S.settings.sync = !S.settings.sync; b.classList.toggle('on', S.settings.sync); if (!S.settings.sync) panes.forEach(p => p.setCrosshairTime(null)); markSave(); }
    else if (k === 'trash') { if (active.dr.items.length && confirm('Eliminare tutti i disegni di questo grafico?')) active.dr.clear(); }
  };
  syncTools(null);
}
function syncTools(t) { $$('#tools button').forEach(b => { if (TOOLS[b.dataset.k] || b.dataset.k === 'cursor') b.classList.toggle('on', b.dataset.k === (t || 'cursor')); }); }

function buildPropbar(item) {
  const bar = $('#propbar');
  if (!item) { bar.hidden = true; return; }
  const dr = active.dr;
  bar.hidden = false;
  const hasFill = item.type === 'rect' || item.type === 'channel';
  bar.innerHTML = `<input type="color" id="pColor" value="${item.color.length === 7 ? item.color : '#2962ff'}" title="Colore">
    <select id="pWidth" title="Spessore">${[1, 2, 3, 4].map(w => `<option ${w === item.width ? 'selected' : ''}>${w}</option>`).join('')}</select>
    <select id="pDash" title="Stile"><option value="0">—</option><option value="1" ${item.dash === 1 ? 'selected' : ''}>- - -</option><option value="2" ${item.dash === 2 ? 'selected' : ''}>· · ·</option></select>
    ${hasFill ? `<input type="range" id="pFill" min="0" max="0.6" step="0.05" value="${item.fill}" title="Riempimento">` : ''}
    ${item.type === 'text' || item.type === 'trend' ? '<button id="pText" class="btn small">Testo</button>' : ''}
    <button id="pLock" class="btn small" title="Blocca">${item.locked ? '🔒' : '🔓'}</button>
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
  return { otype: $('#otype .on').dataset.t, sizeMode: $('#sizeMode .on').dataset.m, oqty: $('#oqty').value, orisk: $('#orisk').value, osl: $('#osl').value, otp: $('#otp').value, otrail: $('#otrail').value };
}
function restoreTicket(t) {
  if (t) {
    const seg = (sel, attr, v) => $$(sel + ' button').forEach(b => b.classList.toggle('on', b.dataset[attr] === v));
    seg('#otype', 't', t.otype || 'market'); seg('#sizeMode', 'm', t.sizeMode || 'qty');
    for (const k of ['oqty', 'orisk', 'osl', 'otp', 'otrail']) if (t[k] !== undefined) $('#' + k).value = t[k];
  }
  $('#fQty').value = $('#oqty').value; $('#fSl').value = $('#osl').value; $('#fTp').value = $('#otp').value;
}

// ---- Drawer laterale: oggetti sul grafico / journal ----
let drawerMode = null, journalCount = -1;
function toggleDrawer(mode) {
  const d = $('#drawer');
  if (!d.hidden && drawerMode === mode) { d.hidden = true; drawerMode = null; return; }
  drawerMode = mode; d.hidden = false; renderDrawer();
}
function openJournal(key) {
  drawerMode = 'journal'; $('#drawer').hidden = false; renderDrawer();
  const det = $(`#drawer details[data-key="${key}"]`);
  if (det) { det.open = true; det.scrollIntoView({ block: 'nearest' }); }
}
const DEF_TAGS = ['breakout', 'pullback', 'reversal', 'trend', 'range', 'news', 'scalp'];
const DEF_MISTAKES = ['fomo', 'stop spostato', 'overtrading', 'ingresso anticipato', 'non ho rispettato il piano', 'size troppo grande', 'uscita anticipata'];
const splitList = v => v.split(',').map(x => x.trim()).filter(Boolean);
function renderDrawer() {
  const d = $('#drawer');
  if (drawerMode === 'layers') {
    const items = active.dr.items;
    d.innerHTML = `<h3>Oggetti · ${active.feed.sym}</h3>` + (items.length ? items.map(it => `<div class="item"><span data-sel="${it.id}" style="cursor:pointer">${TOOLS[it.type].name}${it.text ? ' – ' + esc(it.text) : ''}</span><button class="btn small" data-lock="${it.id}">${it.locked ? '🔒' : '🔓'}</button><button class="btn small danger" data-del="${it.id}">✕</button></div>`).join('') : '<p class="muted">Nessun disegno su questo grafico.</p>');
    d.querySelectorAll('[data-sel]').forEach(b => b.onclick = () => active.dr.select(b.dataset.sel));
    d.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { active.dr.remove(b.dataset.del); renderDrawer(); });
    d.querySelectorAll('[data-lock]').forEach(b => b.onclick = () => { active.dr.select(b.dataset.lock); active.dr.update({ locked: !active.dr.selected().locked }); renderDrawer(); });
  } else if (drawerMode === 'journal') {
    const tr = allTrades().reverse();
    journalCount = tr.length;
    const allTags = [...new Set([...DEF_TAGS, ...tr.flatMap(t => (S.journal.trades[t.key] || {}).tags || [])])];
    const allMis = [...new Set([...DEF_MISTAKES, ...tr.flatMap(t => (S.journal.trades[t.key] || {}).mistakes || [])])];
    d.innerHTML = `<h3>Journal</h3><textarea id="jNotes" placeholder="Note sulla sessione, idee, regole da rispettare…"></textarea>
      <datalist id="dlTags">${allTags.map(x => `<option value="${esc(x)}">`).join('')}</datalist><datalist id="dlMis">${allMis.map(x => `<option value="${esc(x)}">`).join('')}</datalist>
      <h3 style="margin-top:12px">Operazioni (${tr.length}) <a class="muted small" href="/playbooks" target="_blank">gestisci playbook</a></h3><div id="jList"></div>`;
    $('#jNotes').value = S.journal.notes || '';
    $('#jNotes').oninput = e => { S.journal.notes = e.target.value; markSave(); };
    const list = $('#jList');
    if (!tr.length) list.innerHTML = '<p class="muted">Le operazioni chiuse compariranno qui: potrai aggiungere playbook, tag, errori, voto, note e vedere gli screenshot.</p>';
    for (const t of tr) {
      const det = document.createElement('details'); det.className = 'jt'; det.dataset.key = t.key;
      const j0 = S.journal.trades[t.key] || {};
      det.innerHTML = `<summary><b>${esc(t.symbol)}</b> <span class="${t.side === 'long' ? 'up' : 'down'}">${t.side === 'long' ? 'L' : 'S'} ${t.qty}</span> <span class="${t.pnl >= 0 ? 'up' : 'down'}">${money(t.pnl)}</span> <span class="muted small">${fmtDT(t.exitTime)}</span> <span class="grow"></span><span class="stars-ro" style="color:#ffb300">${'★'.repeat(j0.rating || 0)}</span></summary>`;
      det.addEventListener('toggle', () => { if (det.open && !det.querySelector('.body')) buildTradeBody(det, t); });
      list.append(det);
    }
  }
}
function buildTradeBody(det, t) {
  const j = tradeJ(t.key), body = document.createElement('div'); body.className = 'body';
  const pbOpts = ['<option value="">Nessun playbook</option>', ...playbooks.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)].join('');
  body.innerHTML = `
    <label class="fld">Playbook<select data-f="setup">${pbOpts}</select></label>
    <div class="rules" data-rules></div>
    <label class="fld">Tag (separati da virgola)<input data-f="tags" list="dlTags" placeholder="breakout, news…"></label>
    <label class="fld">Errori commessi<input data-f="mistakes" list="dlMis" placeholder="fomo, stop spostato…"></label>
    <div class="fld">Voto dell'esecuzione <span class="stars">${[1, 2, 3, 4, 5].map(n => `<button data-star="${n}">★</button>`).join('')}</span></div>
    <label class="fld">Note<textarea data-f="notes" placeholder="Cosa ha funzionato, cosa no, emozioni…"></textarea></label>
    <div class="shots" data-shots></div>`;
  det.append(body);
  const save = () => { markSave(); const sum = det.querySelector('.stars-ro'); if (sum) sum.textContent = '★'.repeat(j.rating || 0); };
  const sel = body.querySelector('[data-f=setup]'); sel.value = j.setup || '';
  body.querySelector('[data-f=tags]').value = (j.tags || []).join(', ');
  body.querySelector('[data-f=mistakes]').value = (j.mistakes || []).join(', ');
  body.querySelector('[data-f=notes]').value = j.notes || '';
  const drawRules = () => {
    const pb = playbooks.find(p => p.id === j.setup), box = body.querySelector('[data-rules]'), gl = { entry: 'Ingresso', exit: 'Uscita', risk: 'Rischio' };
    j.rules = j.rules || {};
    box.innerHTML = pb ? ['entry', 'exit', 'risk'].filter(g => (pb.rules[g] || []).length).map(g => `<b>${gl[g]}</b>` + pb.rules[g].map((r, i) => `<label><input type="checkbox" data-r="${g}:${i}" ${j.rules[g + ':' + i] ? 'checked' : ''}> ${esc(r)}</label>`).join('')).join('') : '';
    box.querySelectorAll('[data-r]').forEach(c => c.onchange = () => { j.rules[c.dataset.r] = c.checked; save(); });
  };
  drawRules();
  sel.onchange = () => { j.setup = sel.value; drawRules(); save(); };
  body.querySelector('[data-f=tags]').oninput = e => { j.tags = splitList(e.target.value); save(); };
  body.querySelector('[data-f=mistakes]').oninput = e => { j.mistakes = splitList(e.target.value); save(); };
  body.querySelector('[data-f=notes]').oninput = e => { j.notes = e.target.value; save(); };
  const paintStars = () => body.querySelectorAll('[data-star]').forEach(b => b.classList.toggle('on', +b.dataset.star <= (j.rating || 0)));
  body.querySelectorAll('[data-star]').forEach(b => b.onclick = () => { j.rating = j.rating === +b.dataset.star ? 0 : +b.dataset.star; paintStars(); save(); });
  paintStars();
  const sh = j.shots || {};
  body.querySelector('[data-shots]').innerHTML = [['entry', 'Ingresso'], ['exit', 'Uscita']].filter(([k]) => sh[k]).map(([k, l]) => `<a href="${esc(sh[k])}" target="_blank"><img src="${esc(sh[k])}" alt="${l}"><small class="muted">${l}</small></a>`).join('');
}

// ---- Analytics della sessione (stessa dashboard della pagina Analytics) ----
function tradesForAnalytics() {
  return allTrades().map(t => ({ sid, sname: S.name, ...t, pv: (feeds.get(t.symbol) || { cfg: { pointValue: 1 } }).cfg.pointValue, capital: S.capital, j: S.journal.trades[t.key] || {} }));
}
function openAnalytics() {
  const m = $('#modal'); m.hidden = false;
  m.innerHTML = `<div class="dlg huge"><div class="dh"><h3>Analytics · ${esc(S.name)}</h3><button class="btn ghost" id="anClose">✕</button></div><div id="anRoot2"></div></div>`;
  m.onclick = e => { if (e.target === m) closeModal(); };
  $('#anClose').onclick = closeModal;
  renderAnalytics($('#anRoot2'), tradesForAnalytics(), { playbooks, capital: S.capital, link: false });
}

// ---- Scorciatoie da tastiera (configurabili) ----
const toolKey = k => () => panes.forEach(p => p.dr.setTool(active.dr.tool === k ? null : k));
const HK = [
  ['play', 'Play / Pausa', 'Space', () => setPlaying(!playing)],
  ['step', 'Avanti di un passo', 'ArrowRight', () => stepUnit()],
  ['bar', 'Completa la barra del timeframe', 'Shift+ArrowRight', () => stepBar()],
  ['buy', 'Buy a mercato', 'b', () => submitOrder('buy', true)],
  ['sell', 'Sell a mercato', 's', () => submitOrder('sell', true)],
  ['closeAll', 'Chiudi la posizione', 'x', () => closeAll(act())],
  ['reverse', 'Inverti la posizione', 'r', () => reverse(act())],
  ['breakeven', 'Stop loss a pareggio', 'e', () => breakeven(act())],
  ['cancelOrders', 'Annulla gli ordini pendenti', 'c', () => { act().acc.orders = []; needUI = true; tabSig = {}; markSave(); }],
  ['alert', 'Alert al prezzo corrente', 'Alt+a', () => { const f = act(); Broker.addAlert(f.acc, f.price(), f.price()); toast('Alert impostato al prezzo corrente'); needUI = true; markSave(); }],
  ['goto', 'Go To', 'g', () => openGoTo()],
  ['order', 'Pannello Order', 'o', () => widget('order')],
  ['journal', 'Journal', 'j', () => widget('journal')],
  ['analytics', 'Analytics', 'a', () => openAnalytics()],
  ['tfNext', 'Timeframe successivo', 'ArrowUp', () => cycleTf(1)],
  ['tfPrev', 'Timeframe precedente', 'ArrowDown', () => cycleTf(-1)],
  ['trend', 'Strumento: trendline', 'Alt+t', toolKey('trend')], ['ray', 'Strumento: semiretta', 'Alt+y', toolKey('ray')],
  ['hline', 'Strumento: linea orizzontale', 'Alt+h', toolKey('hline')], ['vline', 'Strumento: linea verticale', 'Alt+v', toolKey('vline')],
  ['rect', 'Strumento: rettangolo', 'Alt+r', toolKey('rect')], ['fib', 'Strumento: Fibonacci', 'Alt+f', toolKey('fib')],
  ['longpos', 'Strumento: posizione long', 'Alt+l', toolKey('longpos')], ['shortpos', 'Strumento: posizione short', 'Alt+s', toolKey('shortpos')],
  ['measure', 'Strumento: righello', 'Alt+m', toolKey('measure')], ['text', 'Strumento: testo', 'Alt+x', toolKey('text')],
  ['shot', 'Screenshot del grafico', 'Alt+p', () => takeShot()],
  ['full', 'Schermo intero', 'Alt+Enter', () => $('#fsBtn').click()],
];
const hkOf = id => { const o = (S.settings.hotkeys || {})[id]; return o !== undefined ? o : HK.find(h => h[0] === id)[2]; };
function cycleTf(d) { const i = TFS.findIndex(t => t.id === active.tf); const n = TFS[Math.max(0, Math.min(TFS.length - 1, i + d))]; if (n.id !== active.tf) setTf(n.id); }
function comboOf(e) {
  let k = e.key; if (k === ' ') k = 'Space';
  if (e.altKey && /^Key[A-Z]$/.test(e.code)) k = e.code.slice(3).toLowerCase();
  else if (k.length === 1) k = k.toLowerCase();
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(k)) return '';
  return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', k].filter(Boolean).join('+');
}
function onHotkey(e) {
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || !$('#modal').hidden) return;
  const c = comboOf(e); if (!c || c.startsWith('Ctrl')) return;
  const h = HK.find(x => hkOf(x[0]) === c);
  if (h) { e.preventDefault(); h[3](); }
}
function openHotkeys() {
  const draw = () => openModal(`<h3>Scorciatoie da tastiera</h3>
    <p class="muted small">Clic su una scorciatoia, poi premi la nuova combinazione. Backspace la disattiva, Esc annulla.</p>
    <table class="hk"><tbody>${HK.map(h => `<tr><td>${h[1]}</td><td><button class="btn small" data-id="${h[0]}">${esc(hkOf(h[0]) || '— nessuna —')}</button></td></tr>`).join('')}</tbody></table>
    <div style="display:flex;gap:8px;justify-content:space-between;margin-top:12px"><button class="btn" id="hkReset">Ripristina predefinite</button><button class="btn primary" id="hkOk">Chiudi</button></div>`, () => {
    $('#hkOk').onclick = closeModal;
    $('#hkReset').onclick = () => { S.settings.hotkeys = {}; markSave(); draw(); };
    $$('.hk [data-id]').forEach(b => b.onclick = () => {
      b.textContent = 'Premi un tasto…'; b.classList.add('rec');
      const h = ev => {
        ev.preventDefault(); ev.stopPropagation();
        if (ev.key === 'Escape') { removeEventListener('keydown', h, true); draw(); return; }
        const c = ev.key === 'Backspace' ? '' : comboOf(ev); if (c === '' && ev.key !== 'Backspace') return;
        removeEventListener('keydown', h, true);
        S.settings.hotkeys = S.settings.hotkeys || {};
        if (c) for (const x of HK) if (x[0] !== b.dataset.id && hkOf(x[0]) === c) S.settings.hotkeys[x[0]] = ''; // evita doppioni
        S.settings.hotkeys[b.dataset.id] = c; markSave(); draw();
      };
      addEventListener('keydown', h, true);
    });
  });
  draw();
}

function openGoTo() {
  const min = toInputValue(Math.ceil(replay.T) + 60);
  openModal(`<h3>Go To</h3>
    <div class="row"><label>Data e ora (ET, solo in avanti)</label><input type="datetime-local" id="gDt" min="${min}" value="${min}"></div>
    <div class="list" style="margin-top:10px"><button class="btn" id="gOpen">Prossima apertura 09:30 ET</button><button class="btn" id="gHour">+1 ora</button><button class="btn" id="gDay">+1 giorno</button></div>
    <div style="text-align:right;margin-top:12px"><button class="btn primary" id="gGo">Vai</button></div>`, () => {
    const go = async t => { if (await jumpTo(t)) closeModal(); };
    $('#gOpen').onclick = () => go(nextOpen(replay.T));
    $('#gHour').onclick = () => go(Math.ceil(replay.T) + 3600);
    $('#gDay').onclick = () => go(Math.ceil(replay.T) + 86400);
    $('#gGo').onclick = () => { const v = $('#gDt').value; if (v) go(fromInputValue(v)); };
  });
}
function openSettings() {
  openModal(`<h3>Impostazioni</h3>
    <div class="row"><label>Stile candele</label><select id="sStyle"><option value="mono">Monocromatico</option><option value="classic">Classico (verde/rosso)</option></select></div>
    <div class="row"><label>Sincronizza il cursore tra i grafici</label><input type="checkbox" id="sSync"></div>
    <div class="row"><label>Screenshot automatici a ingresso e uscita (per il journal)</label><input type="checkbox" id="sShots"></div>
    <div class="row"><label>Scorciatoie da tastiera</label><button class="btn" id="sHk">Personalizza…</button></div>
    <div style="text-align:right;margin-top:12px"><button class="btn primary" id="sOk">Chiudi</button></div>`, () => {
    $('#sStyle').value = S.settings.candleStyle; $('#sSync').checked = S.settings.sync; $('#sShots').checked = S.settings.autoShots !== false;
    $('#sStyle').onchange = e => { S.settings.candleStyle = e.target.value; panes.forEach(p => p.applyTheme()); markSave(); };
    $('#sSync').onchange = e => { S.settings.sync = e.target.checked; $('#tools [data-k=link]').classList.toggle('on', S.settings.sync); markSave(); };
    $('#sShots').onchange = e => { S.settings.autoShots = e.target.checked; markSave(); };
    $('#sHk').onclick = openHotkeys;
    $('#sOk').onclick = closeModal;
  });
}
function takeShot() {
  const cv = active.chart.takeScreenshot(), ov = active.el.querySelector('.ov');
  cv.getContext('2d').drawImage(ov, 0, 0, cv.width, cv.height);
  const a = document.createElement('a'); a.href = cv.toDataURL('image/png'); a.download = `${active.feed.sym}_${Math.floor(replay.T)}.png`; a.click();
}

function bindUI() {
  $('#sname').onclick = async () => {
    const n = prompt('Nome sessione:', S.name); if (!n || !n.trim()) return;
    S.name = n.trim(); $('#sname').textContent = S.name; document.title = `${S.name} – Backtest`;
    try { await api('/sessions/' + sid, { method: 'PUT', body: { name: S.name } }); } catch { /* ignore */ }
  };
  $('#symBtn').onclick = e => popMenu(e.currentTarget, assets.map(a => [a.symbol, `${a.symbol} – ${a.name}`]), async sym => {
    const f = await feedFor(sym); active.setFeed(f); $('#symTxt').textContent = sym; cardSig = ''; needUI = true; markSave();
  }, active.feed.sym);
  $('#addPane').onclick = e => {
    if (S.layout.panes.length >= 4) { toast('Massimo 4 grafici'); return; }
    popMenu(e.currentTarget, assets.map(a => [a.symbol, `${a.symbol} – ${a.name}`]), async sym => {
      await feedFor(sym);
      S.layout.panes.push({ id: 'p' + uid(), symbol: sym, tf: active.tf, drawings: [] });
      S.layout.type = S.layout.panes.length === 2 ? '2h' : '4';
      buildPanes(); markSave();
    });
  };
  $('#layoutBtn').onclick = e => popMenu(e.currentTarget, Object.entries(LAYOUTS).map(([k, v]) => [k, v[0]]), k => {
    const n = LAYOUTS[k][1];
    if (S.layout.panes.length > n && !confirm('Alcuni grafici verranno chiusi (i disegni su di essi andranno persi). Continuare?')) return;
    while (S.layout.panes.length < n) S.layout.panes.push({ id: 'p' + uid(), symbol: active.feed.sym, tf: active.tf, drawings: [] });
    S.layout.type = k; buildPanes(); markSave();
  }, S.layout.type);
  $('#undoBtn').onclick = () => active.dr.undoLast(); $('#redoBtn').onclick = () => active.dr.redoLast();
  $('#shotBtn').onclick = takeShot; $('#setBtn').onclick = openSettings;
  $('#fsBtn').onclick = () => { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); };

  // replay flottante
  $('#play').onclick = () => setPlaying(!playing);
  $('#next').onclick = stepUnit;
  makeDraggable($('#floatReplay')); makeDraggable($('#floatGo')); makeDraggable($('#orderPanel'));
  $('#floatGo').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'goClose') $('#floatGo').hidden = true; else widget(b.dataset.w);
  };
  $('#widgets').onclick = e => { const b = e.target.closest('button'); if (b) widget(b.dataset.w); };
  $('#oclose').onclick = () => { $('#orderPanel').hidden = true; };
  $$('#rangebar [data-days]').forEach(b => b.onclick = () => active.showRange(+b.dataset.days));
  $('#autoBtn').onclick = () => active.fit();

  // ordini
  $$('#otype button').forEach(b => b.onclick = () => {
    $$('#otype button').forEach(x => x.classList.toggle('on', x === b));
    if (b.dataset.t !== 'market' && !$('#oprice').value) $('#oprice').value = act().price();
    updateTicket(); markSave();
  });
  $$('#sizeMode button').forEach(b => b.onclick = () => { $$('#sizeMode button').forEach(x => x.classList.toggle('on', x === b)); updateTicket(); markSave(); });
  for (const [a, b] of [['oqty', 'fQty'], ['osl', 'fSl'], ['otp', 'fTp']]) {
    $('#' + a).addEventListener('input', () => { $('#' + b).value = $('#' + a).value; updateTicket(); markSave(); });
    $('#' + b).addEventListener('input', () => { $('#' + a).value = $('#' + b).value; updateTicket(); markSave(); });
  }
  for (const id of ['orisk', 'oprice', 'otrail']) $('#' + id).addEventListener('input', () => { updateTicket(); markSave(); });
  $('#buy').onclick = () => submitOrder('buy'); $('#sell').onclick = () => submitOrder('sell');
  $('#fBuy').onclick = () => submitOrder('buy', true); $('#fSell').onclick = () => submitOrder('sell', true);

  // footer e pannello inferiore
  $('#panelBtn').onclick = () => { $('#bottom').hidden = !$('#bottom').hidden; tabSig = {}; needUI = true; };
  $('#bclose').onclick = () => { $('#bottom').hidden = true; };
  $('#analyticsBtn').onclick = openAnalytics;
  $('#alertBtn').onclick = openAlerts;
  $('#rulesBtn').onclick = openRules;
  $$('.tabs [data-tab]').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  $('#exportBtn').onclick = exportCsv;

  addEventListener('keydown', onHotkey);
  addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  document.addEventListener('click', e => { const b = e.target.closest('button'); if (b && e.detail > 0 && !b.closest('#modal')) b.blur(); });
  if (location.search.includes('debug')) window.__bt = { get panes() { return panes; }, get replay() { return replay; }, feeds, stepEvent: () => { replay.stepEvent(); needUI = true; } };
}
function showTab(t) {
  $$('.tabs [data-tab]').forEach(x => x.classList.toggle('on', x.dataset.tab === t));
  ['pos', 'hist', 'stats'].forEach(k => { $('#tab-' + k).hidden = k !== t; });
  tabSig = {}; needUI = true;
}
function widget(w) {
  if (w === 'order') { const p = $('#orderPanel'); p.hidden = !p.hidden; needUI = true; }
  else if (w === 'goto') openGoTo();
  else if (w === 'journal') toggleDrawer('journal');
  else if (w === 'layers') toggleDrawer('layers');
}

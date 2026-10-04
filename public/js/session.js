import { $, $$, fmt, money, fmtDT, toInputValue, fromInputValue, api, uid } from './util.js';
import { initTheme } from './theme.js';
import { TFS, tfSec, loadCandles, loadTickIndex, loadTickDay, firstIndexAtOrAfter, sessionKey } from './data.js';
import * as Broker from './broker.js';
import { Feed, Replay, TickStore } from './feed.js';
import { Pane } from './pane.js';
import { TOOLS } from './drawings.js';

const sid = location.pathname.split('/').pop();
const RATES = [1, 2, 3, 5, 8, 12, 20, 30, 60, 120]; // passi al secondo associati alla slider 1..10
const QUICK_TFS = ['1', '15', '60'];
const LAYOUTS = { '1': ['Singolo', 1], '2h': ['2 affiancati', 2], '2v': ['2 sovrapposti', 2], '4': ['4 (griglia)', 4] };

let S, assets, replay, active = null, panes = [];
const feeds = new Map(), candleCache = new Map(), tickCache = new Map();
let playing = false, saveTimer = null, saveDirty = false, jumpSummary = null, needUI = true, needMarkers = false;
let extOrig = {}, syncing = false, ruleBreached = false;

// ====================== Avvio ======================
(async function init() {
  try {
    S = await api('/sessions/' + sid);
    assets = await api('/assets');
    migrate();
    await Promise.all([...new Set(S.layout.panes.map(p => p.symbol))].map(ensureData));
  } catch (e) {
    document.body.innerHTML = '<p style="padding:24px">Sessione non trovata o dati non disponibili. <a href="/">Torna alla dashboard</a></p>';
    return;
  }
  S.settings = { candleStyle: 'mono', sync: true, ...(S.settings || {}) };
  S.rules = S.rules || { enabled: false };
  S.runtime = S.runtime || {};
  S.journal = S.journal || { notes: '', tradeNotes: {} };
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
      toast(`${feed.sym} · ${why}: ${t.side === 'long' ? 'Long' : 'Short'} ${t.qty} · ${money(t.pnl)}${t.r != null ? ` (${fmt(t.r)} R)` : ''}`, t.pnl >= 0 ? 'win' : 'loss');
      if (t.reason !== 'manual' && $('#pauseFill').checked) replay.stopReq = true;
    } else if ((e.type === 'open' || e.type === 'add') && playing) {
      toast(`${feed.sym} · Ordine eseguito: ${e.side === 'buy' ? 'Buy' : 'Sell'} ${e.qty} @ ${fmt(e.price)}`);
      if ($('#pauseFill').checked) replay.stopReq = true;
    }
  }
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
  const slp = +$('#osl').value || 0, tpp = +$('#otp').value || 0;
  let qty = Math.floor(+$('#oqty').value) || 0;
  if ($('#sizeMode .on').dataset.m === 'risk') qty = slp > 0 ? Math.floor(totalEquity() * (+$('#orisk').value || 0) / 100 / (slp * f.cfg.pointValue)) : 0;
  return { px, type, price, slp, tpp, qty };
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
function submitOrder(side, fromFooter) {
  const f = act(), s = sizeInfo(f), d = Broker.dirOf(side), errEl = fromFooter ? $('#fErr') : $('#oerr');
  $('#fErr').textContent = ''; $('#oerr').textContent = '';
  const type = fromFooter ? 'market' : s.type, price = fromFooter ? s.px : s.price;
  if (type !== 'market' && !(price > 0)) { errEl.textContent = 'Inserisci il prezzo'; return; }
  const sl = s.slp > 0 ? Broker.snap(price - d * s.slp, f.cfg.tickSize) : null;
  const tp = s.tpp > 0 ? Broker.snap(price + d * s.tpp, f.cfg.tickSize) : null;
  const r = Broker.placeOrder(f.cfg, f.acc, { type, side, qty: s.qty, price, sl, tp }, feedBar(f));
  if (r.error) { errEl.textContent = r.error; return; }
  handleEvents(f, tagTrades(f, r.events)); needMarkers = true; needUI = true; markSave();
}
const closeAll = f => handleEvents(f, tagTrades(f, Broker.closePosition(f.cfg, f.acc, feedBar(f))));
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
  const f = pane.feed, { obj, key, order } = extTarget(f, id), k = f.sym + id;
  if (!obj) { delete extOrig[k]; return; }
  const px = f.price(), orig = extOrig[k]; delete extOrig[k];
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
      <div class="muted small" style="margin-top:6px">Trascina le linee SL/TP sul grafico per modificarle.</div>
      <div class="btns"><button id="pcClose" class="btn danger">Chiudi</button><button id="pcRev" class="btn">Inverti</button><button id="pcBe" class="btn">SL a pareggio</button>
      ${p.sl == null ? '<button id="pcAddSl" class="btn">+ Stop loss</button>' : ''}${p.tp == null ? '<button id="pcAddTp" class="btn">+ Take profit</button>' : ''}</div>`;
      $('#pcClose').onclick = () => closeAll(f); $('#pcRev').onclick = () => reverse(f); $('#pcBe').onclick = () => breakeven(f);
      if ($('#pcAddSl')) $('#pcAddSl').onclick = () => addLevel(f, 'sl');
      if ($('#pcAddTp')) $('#pcAddTp').onclick = () => addLevel(f, 'tp');
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
    for (const [id, v] of [['#pcSl', p.sl], ['#pcTp', p.tp]]) { const inp = $(id); if (inp && document.activeElement !== inp) inp.value = v ?? ''; }
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
  for (const t of allTrades()) rows.push([t.symbol, t.side, t.qty, fmtDT(t.entryTime, true), t.entry, fmtDT(t.exitTime, true), t.exit, t.pnl.toFixed(2), t.r != null ? t.r.toFixed(2) : '', t.reason, JSON.stringify(S.journal.tradeNotes[t.key] || '')]);
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
  if (bad && !ruleBreached) { ruleBreached = true; toast('Regola Prop Firm violata!', 'loss'); if (playing) setPlaying(false); }
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
    ${r.enabled ? `<div style="margin-top:10px">Profitto: <b>${money(pr)}</b>${r.target ? ` / ${money(r.target)}` : ''}${bar(pr, r.target, false)}
    Perdita di oggi: <b>${money(Math.max(0, dl))}</b>${r.maxDailyLoss ? ` / ${money(r.maxDailyLoss)}` : ''}${bar(dl, r.maxDailyLoss, r.maxDailyLoss && dl >= r.maxDailyLoss)}
    Drawdown: <b>${money(Math.max(0, dd))}</b>${r.maxDrawdown ? ` / ${money(r.maxDrawdown)}` : ''}${bar(dd, r.maxDrawdown, r.maxDrawdown && dd >= r.maxDrawdown)}</div>` : ''}
    <div style="text-align:right;margin-top:12px"><button class="btn primary" id="rOk">Salva</button></div>`, () => {
    $('#rOk').onclick = () => {
      S.rules = { enabled: $('#rEn').checked, target: +$('#rTarget').value || 0, maxDailyLoss: +$('#rDaily').value || 0, maxDrawdown: +$('#rDd').value || 0, trailing: $('#rTrail').checked };
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
function toast(msg, cls = '') {
  const d = document.createElement('div'); d.textContent = msg; if (cls) d.className = cls;
  $('#toast').append(d); setTimeout(() => d.remove(), 4500);
  while ($('#toast').children.length > 4) $('#toast').firstChild.remove();
}
function openModal(html, mount) {
  const m = $('#modal'); m.hidden = false;
  m.innerHTML = `<div class="dlg">${html}</div>`;
  m.onclick = e => { if (e.target === m) closeModal(); };
  mount && mount(m);
}
const closeModal = () => { $('#modal').hidden = true; };
function popMenu(anchor, items, onPick, current) {
  $$('.menu').forEach(m => m.remove());
  const m = document.createElement('div'); m.className = 'menu';
  m.innerHTML = items.map(([v, l]) => `<button data-v="${v}" class="${v === current ? 'on' : ''}">${l}</button>`).join('');
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, innerWidth - 220) + 'px'; m.style.top = r.bottom + 4 + 'px';
  m.onclick = e => { const b = e.target.closest('button'); if (b) { m.remove(); onPick(b.dataset.v); } };
  setTimeout(() => document.addEventListener('mousedown', function h(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', h); } }), 0);
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
  return { otype: $('#otype .on').dataset.t, sizeMode: $('#sizeMode .on').dataset.m, oqty: $('#oqty').value, orisk: $('#orisk').value, osl: $('#osl').value, otp: $('#otp').value };
}
function restoreTicket(t) {
  if (t) {
    const seg = (sel, attr, v) => $$(sel + ' button').forEach(b => b.classList.toggle('on', b.dataset[attr] === v));
    seg('#otype', 't', t.otype || 'market'); seg('#sizeMode', 'm', t.sizeMode || 'qty');
    for (const k of ['oqty', 'orisk', 'osl', 'otp']) if (t[k] !== undefined) $('#' + k).value = t[k];
  }
  $('#fQty').value = $('#oqty').value; $('#fSl').value = $('#osl').value; $('#fTp').value = $('#otp').value;
}

// ---- Drawer laterale: oggetti sul grafico / journal ----
let drawerMode = null;
function toggleDrawer(mode) {
  const d = $('#drawer');
  if (!d.hidden && drawerMode === mode) { d.hidden = true; drawerMode = null; return; }
  drawerMode = mode; d.hidden = false; renderDrawer();
}
function renderDrawer() {
  const d = $('#drawer');
  if (drawerMode === 'layers') {
    const items = active.dr.items;
    d.innerHTML = `<h3>Oggetti · ${active.feed.sym}</h3>` + (items.length ? items.map(it => `<div class="item"><span data-sel="${it.id}" style="cursor:pointer">${TOOLS[it.type].name}${it.text ? ' – ' + it.text.replace(/</g, '&lt;') : ''}</span><button class="btn small" data-lock="${it.id}">${it.locked ? '🔒' : '🔓'}</button><button class="btn small danger" data-del="${it.id}">✕</button></div>`).join('') : '<p class="muted">Nessun disegno su questo grafico.</p>');
    d.querySelectorAll('[data-sel]').forEach(b => b.onclick = () => active.dr.select(b.dataset.sel));
    d.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { active.dr.remove(b.dataset.del); renderDrawer(); });
    d.querySelectorAll('[data-lock]').forEach(b => b.onclick = () => { active.dr.select(b.dataset.lock); active.dr.update({ locked: !active.dr.selected().locked }); renderDrawer(); });
  } else if (drawerMode === 'journal') {
    const tr = allTrades().reverse();
    d.innerHTML = `<h3>Journal</h3><textarea id="jNotes" placeholder="Note sulla sessione, idee, regole da rispettare…"></textarea><h3 style="margin-top:12px">Note per operazione</h3>` +
      (tr.length ? tr.map(t => `<div class="tn"><span><b>${t.symbol}</b> ${t.side === 'long' ? 'Long' : 'Short'} ${t.qty} · <span class="${t.pnl >= 0 ? 'up' : 'down'}">${money(t.pnl)}</span> <span class="muted small">${fmtDT(t.exitTime)}</span></span><input data-note="${t.key}" placeholder="Nota…"></div>`).join('') : '<p class="muted">Le operazioni chiuse compariranno qui.</p>');
    $('#jNotes').value = S.journal.notes || '';
    $('#jNotes').oninput = e => { S.journal.notes = e.target.value; markSave(); };
    d.querySelectorAll('[data-note]').forEach(i => { i.value = S.journal.tradeNotes[i.dataset.note] || ''; i.oninput = () => { S.journal.tradeNotes[i.dataset.note] = i.value; markSave(); }; });
  }
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
    <div style="text-align:right;margin-top:12px"><button class="btn primary" id="sOk">Chiudi</button></div>`, () => {
    $('#sStyle').value = S.settings.candleStyle; $('#sSync').checked = S.settings.sync;
    $('#sStyle').onchange = e => { S.settings.candleStyle = e.target.value; panes.forEach(p => p.applyTheme()); markSave(); };
    $('#sSync').onchange = e => { S.settings.sync = e.target.checked; $('#tools [data-k=link]').classList.toggle('on', S.settings.sync); markSave(); };
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
  for (const id of ['orisk', 'oprice']) $('#' + id).addEventListener('input', () => { updateTicket(); markSave(); });
  $('#buy').onclick = () => submitOrder('buy'); $('#sell').onclick = () => submitOrder('sell');
  $('#fBuy').onclick = () => submitOrder('buy', true); $('#fSell').onclick = () => submitOrder('sell', true);

  // footer e pannello inferiore
  $('#panelBtn').onclick = () => { $('#bottom').hidden = !$('#bottom').hidden; tabSig = {}; needUI = true; };
  $('#bclose').onclick = () => { $('#bottom').hidden = true; };
  $('#analyticsBtn').onclick = () => { $('#bottom').hidden = false; showTab('stats'); };
  $('#rulesBtn').onclick = openRules;
  $$('.tabs [data-tab]').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  $('#exportBtn').onclick = exportCsv;

  addEventListener('keydown', e => {
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || e.ctrlKey || e.metaKey) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); e.shiftKey ? stepBar() : stepUnit(); }
    else if (e.key === 'Escape') closeModal();
  });
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

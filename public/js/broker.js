// Motore di simulazione degli ordini (puro, senza DOM, testabile in Node).
// Convenzioni: posizione netta per simbolo; market al prezzo corrente (+ slippage); limit/stop valutati sui tick/secondi/minuti;
// se SL e TP cadono nella stessa barra vale lo SL. Slippage (in tick) solo su market e uscite/entrate "stop".

export function newAccount() {
  return { trades: [], position: null, orders: [], alerts: [], nextId: 1 };
}

export const dirOf = side => (side === 'buy' ? 1 : -1);
const round = (x, tick) => Math.round(x / tick) * tick;
export const snap = (x, tick) => round(x, tick || 0.25);
const slipPx = cfg => (cfg.slippage || 0) * (cfg.tickSize || 0.25);

export function realizedPnl(acc) { return acc.trades.reduce((a, t) => a + t.pnl, 0); }
export function equity(cfg, acc, px) { return cfg.capital + realizedPnl(acc) + openPnl(cfg, acc, px); }
export function openPnl(cfg, acc, px) {
  const p = acc.position;
  return p && px != null ? (px - p.entry) * p.dir * p.qty * cfg.pointValue : 0;
}

// Porta il conto a una posizione dopo un fill. Gestisce aggiunta, riduzione, chiusura, inversione.
function applyFill(cfg, acc, side, qty, price, time, bracket, reason) {
  const events = [];
  const d = dirOf(side);
  let p = acc.position;
  if (p && p.dir !== d) {
    const closeQty = Math.min(qty, p.qty);
    events.push(closeTrade(cfg, acc, closeQty, price, time, reason || 'manual'));
    qty -= closeQty;
    p = acc.position;
  }
  if (qty > 0) {
    if (p && p.dir === d) {
      p.entry = (p.entry * p.qty + price * qty) / (p.qty + qty);
      p.qty += qty;
      p.risk = p.sl != null ? Math.abs(p.entry - p.sl) * p.qty * cfg.pointValue : null;
      if (bracket && bracket.sl != null) p.sl = bracket.sl;
      if (bracket && bracket.tp != null) p.tp = bracket.tp;
      if (bracket && bracket.trail != null) p.trail = bracket.trail;
      events.push({ type: 'add', side, qty, price, time });
    } else {
      acc.position = {
        pid: acc.nextId++, side: d === 1 ? 'long' : 'short', dir: d, qty, entry: price, entryTime: time,
        sl: bracket && bracket.sl != null ? bracket.sl : null,
        tp: bracket && bracket.tp != null ? bracket.tp : null,
        trail: bracket && bracket.trail != null ? bracket.trail : null,
        risk: null, openCommission: 0, hi: price, lo: price,
      };
      const pos = acc.position;
      pos.risk = pos.sl != null ? Math.abs(price - pos.sl) * qty * cfg.pointValue : null;
      events.push({ type: 'open', side, qty, price, time, pid: pos.pid });
    }
    acc.position.openCommission = (acc.position.openCommission || 0) + qty * (cfg.commission || 0);
  }
  return events;
}

function closeTrade(cfg, acc, qty, price, time, reason) {
  const p = acc.position;
  const gross = (price - p.entry) * p.dir * qty * cfg.pointValue;
  const commission = qty * (cfg.commission || 0) + (p.openCommission || 0) * (qty / p.qty);
  const pnl = gross - commission;
  const risk = p.risk != null ? p.risk * (qty / p.qty) : null;
  const best = p.dir === 1 ? p.hi : p.lo, worst = p.dir === 1 ? p.lo : p.hi;
  const trade = {
    id: acc.nextId++, pid: p.pid, side: p.side, qty, entry: p.entry, exit: price, entryTime: p.entryTime, exitTime: time,
    pnl, commission, reason, r: risk ? pnl / risk : null, sl: p.sl, tp: p.tp,
    mfe: Math.max(0, (best - p.entry) * p.dir), mae: Math.max(0, (p.entry - worst) * p.dir), // escursioni favorevole/avversa in punti
  };
  acc.trades.push(trade);
  p.openCommission = (p.openCommission || 0) * (1 - qty / p.qty);
  if (qty >= p.qty) acc.position = null;
  else { if (p.risk != null) p.risk -= risk; p.qty -= qty; }
  return { type: 'close', trade };
}

// Invia un nuovo ordine. bar = ultima barra (serve per i market).
export function placeOrder(cfg, acc, o, bar) {
  const qty = Math.floor(o.qty);
  if (!(qty >= 1)) return { error: 'Quantità non valida', events: [] };
  const side = o.side, d = dirOf(side);
  if (o.type === 'market') {
    const px = bar.c + d * slipPx(cfg);
    const err = checkBracket(side, px, o.sl, o.tp);
    if (err) return { error: err, events: [] };
    return { events: applyFill(cfg, acc, side, qty, px, bar.t, { sl: o.sl, tp: o.tp, trail: o.trail }, 'manual') };
  }
  const price = snap(o.price, cfg.tickSize);
  if (o.type === 'limit' && ((side === 'buy' && price >= bar.c) || (side === 'sell' && price <= bar.c)))
    return { error: side === 'buy' ? 'Limit buy deve stare sotto il prezzo attuale' : 'Limit sell deve stare sopra il prezzo attuale', events: [] };
  if (o.type === 'stop' && ((side === 'buy' && price <= bar.c) || (side === 'sell' && price >= bar.c)))
    return { error: side === 'buy' ? 'Stop buy deve stare sopra il prezzo attuale' : 'Stop sell deve stare sotto il prezzo attuale', events: [] };
  const err = checkBracket(side, price, o.sl, o.tp);
  if (err) return { error: err, events: [] };
  const order = { id: acc.nextId++, type: o.type, side, qty, price, sl: o.sl ?? null, tp: o.tp ?? null, trail: o.trail ?? null, createdAt: bar.t };
  acc.orders.push(order);
  return { order, events: [{ type: 'order', order }] };
}

function checkBracket(side, px, sl, tp) {
  const d = dirOf(side);
  if (sl != null && (px - sl) * d <= 0) return 'Lo stop loss deve stare dal lato opposto del prezzo di ingresso';
  if (tp != null && (tp - px) * d <= 0) return 'Il take profit deve stare dal lato giusto del prezzo di ingresso';
  return null;
}

export function cancelOrder(acc, id) {
  const k = acc.orders.findIndex(o => o.id === id);
  if (k >= 0) acc.orders.splice(k, 1);
}

// Chiude tutta la posizione (o una parte: qty) a mercato, con slippage avverso.
export function closePosition(cfg, acc, bar, reason = 'manual', qty = null) {
  const p = acc.position;
  if (!p) return [];
  const q = Math.max(1, Math.min(p.qty, Math.floor(qty ?? p.qty)));
  return [closeTrade(cfg, acc, q, bar.c - p.dir * slipPx(cfg), bar.t, reason)];
}

export function setLevels(acc, { sl, tp, trail }) {
  const p = acc.position;
  if (!p) return;
  if (sl !== undefined) p.sl = sl;
  if (tp !== undefined) p.tp = tp;
  if (trail !== undefined) p.trail = trail;
}

// Alert di prezzo: scattano una sola volta quando il prezzo attraversa il livello.
export function addAlert(acc, price, current) {
  acc.alerts = acc.alerts || [];
  const a = { id: acc.nextId++, price, dir: price >= current ? 'up' : 'down' };
  acc.alerts.push(a);
  return a;
}
export function removeAlert(acc, id) { acc.alerts = (acc.alerts || []).filter(a => a.id !== id); }

// Processa una barra (tick, secondo o minuto): ordini pendenti, SL/TP, trailing, alert.
export function onBar(cfg, acc, bar) {
  const events = [], slip = slipPx(cfg);
  for (const o of acc.orders.slice()) {
    let fill = null;
    if (o.side === 'buy') {
      if (o.type === 'limit' && bar.l <= o.price) fill = Math.min(bar.o, o.price);
      if (o.type === 'stop' && bar.h >= o.price) fill = Math.max(bar.o, o.price) + slip;
    } else {
      if (o.type === 'limit' && bar.h >= o.price) fill = Math.max(bar.o, o.price);
      if (o.type === 'stop' && bar.l <= o.price) fill = Math.min(bar.o, o.price) - slip;
    }
    if (fill != null) {
      acc.orders.splice(acc.orders.indexOf(o), 1);
      events.push(...applyFill(cfg, acc, o.side, o.qty, fill, bar.t, { sl: o.sl, tp: o.tp, trail: o.trail }, 'manual'));
    }
  }
  const p = acc.position;
  if (p) {
    if (bar.h > p.hi) p.hi = bar.h;
    if (bar.l < p.lo) p.lo = bar.l;
    let exit = null, reason = null;
    if (p.dir === 1) {
      if (p.sl != null && bar.l <= p.sl) { exit = Math.min(bar.o, p.sl) - slip; reason = 'sl'; }
      else if (p.tp != null && bar.h >= p.tp) { exit = Math.max(bar.o, p.tp); reason = 'tp'; }
    } else {
      if (p.sl != null && bar.h >= p.sl) { exit = Math.max(bar.o, p.sl) + slip; reason = 'sl'; }
      else if (p.tp != null && bar.l <= p.tp) { exit = Math.min(bar.o, p.tp); reason = 'tp'; }
    }
    if (exit != null) events.push(closeTrade(cfg, acc, p.qty, exit, bar.t, reason));
    else if (p.trail > 0) { // trailing stop: segue il massimo/minimo favorevole, non arretra mai
      const cand = snap(p.dir === 1 ? bar.h - p.trail : bar.l + p.trail, cfg.tickSize);
      if (p.sl == null || (cand - p.sl) * p.dir > 0) p.sl = cand; // il rischio iniziale (per R) resta quello di apertura
    }
  }
  if (acc.alerts && acc.alerts.length) {
    for (const a of acc.alerts.slice()) {
      if ((a.dir === 'up' && bar.h >= a.price) || (a.dir === 'down' && bar.l <= a.price)) {
        removeAlert(acc, a.id);
        events.push({ type: 'alert', alert: a, time: bar.t });
      }
    }
  }
  return events;
}

export function stats(cfg, acc) {
  const tr = acc.trades, n = tr.length;
  const wins = tr.filter(t => t.pnl > 0), losses = tr.filter(t => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = -losses.reduce((a, t) => a + t.pnl, 0);
  const total = tr.reduce((a, t) => a + t.pnl, 0);
  let pk = cfg.capital, e = cfg.capital, dd = 0;
  const curve = [{ t: null, v: cfg.capital }];
  for (const t of tr) { e += t.pnl; pk = Math.max(pk, e); dd = Math.max(dd, pk - e); curve.push({ t: t.exitTime, v: e }); }
  const rs = tr.filter(t => t.r != null);
  return {
    n, wins: wins.length, losses: losses.length, winRate: n ? wins.length / n : null, total,
    avgWin: wins.length ? gw / wins.length : null, avgLoss: losses.length ? -gl / losses.length : null,
    profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : null), maxDrawdown: dd,
    avgR: rs.length ? rs.reduce((a, t) => a + t.r, 0) / rs.length : null,
    expectancy: n ? total / n : null, best: n ? Math.max(...tr.map(t => t.pnl)) : null, worst: n ? Math.min(...tr.map(t => t.pnl)) : null,
    curve,
  };
}

// Calcolo delle metriche di analisi sui trade (funzioni pure, usate da pagina Analytics e da sessione).
// Un trade: { pnl, r, qty, side, symbol, entryTime, exitTime, commission, mfe, mae, reason, sid, key, j:{ tags[], mistakes[], setup, rating } }.
// Orari = ET come UTC (secondi).

const EPS = 0.005;
export const isWin = t => t.pnl > EPS, isLoss = t => t.pnl < -EPS;
const dayKey = t => new Date(t * 1000).toISOString().slice(0, 10);
const clamp = x => Math.max(0, Math.min(100, x));
const sum = (a, f = x => x) => a.reduce((s, x) => s + f(x), 0);
const bucket = () => ({ n: 0, pnl: 0, wins: 0, losses: 0 });
function addTo(b, t) { b.n++; b.pnl += t.pnl; if (isWin(t)) b.wins++; else if (isLoss(t)) b.losses++; }

export function applyFilters(trades, f = {}) {
  return trades.filter(t => {
    const j = t.j || {};
    if (f.sessions && f.sessions.length && !f.sessions.includes(t.sid)) return false;
    if (f.symbols && f.symbols.length && !f.symbols.includes(t.symbol)) return false;
    if (f.side && f.side !== 'all' && t.side !== f.side) return false;
    if (f.from && dayKey(t.exitTime) < f.from) return false;
    if (f.to && dayKey(t.exitTime) > f.to) return false;
    if (f.setup && f.setup !== 'all' && (j.setup || '') !== (f.setup === 'none' ? '' : f.setup)) return false;
    if (f.tag && !(j.tags || []).includes(f.tag)) return false;
    if (f.mistake && !(j.mistakes || []).includes(f.mistake)) return false;
    return true;
  });
}

export function histogram(values, bins = 12) {
  if (!values.length) return [];
  let lo = Math.min(...values), hi = Math.max(...values);
  if (lo === hi) { lo -= 1; hi += 1; }
  const w = (hi - lo) / bins, out = Array.from({ length: bins }, (_, i) => ({ from: lo + i * w, to: lo + (i + 1) * w, n: 0 }));
  for (const v of values) out[Math.min(bins - 1, Math.floor((v - lo) / w))].n++;
  return out;
}

export function computeMetrics(trades, { capital = 0 } = {}) {
  const tr = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const n = tr.length, W = tr.filter(isWin), L = tr.filter(isLoss), BE = n - W.length - L.length;
  const gw = sum(W, t => t.pnl), gl = -sum(L, t => t.pnl), net = sum(tr, t => t.pnl);
  const m = {
    n, wins: W.length, losses: L.length, be: BE, net, grossWin: gw, grossLoss: gl,
    winRate: n ? W.length / n : null,
    profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : null),
    avgWin: W.length ? gw / W.length : null, avgLoss: L.length ? gl / L.length : null,
    expectancy: n ? net / n : null,
    commissions: sum(tr, t => t.commission || 0),
    best: n ? Math.max(...tr.map(t => t.pnl)) : null, worst: n ? Math.min(...tr.map(t => t.pnl)) : null,
    avgHold: n ? sum(tr, t => t.exitTime - t.entryTime) / n : null,
  };
  m.ratio = m.avgWin != null && m.avgLoss ? m.avgWin / m.avgLoss : null;
  const rs = tr.filter(t => t.r != null && isFinite(t.r));
  m.avgR = rs.length ? sum(rs, t => t.r) / rs.length : null;
  m.totalR = rs.length ? sum(rs, t => t.r) : null;
  // serie consecutive
  let cw = 0, cl = 0; m.maxConsecWins = 0; m.maxConsecLosses = 0;
  for (const t of tr) {
    if (isWin(t)) { cw++; cl = 0; } else if (isLoss(t)) { cl++; cw = 0; } else { cw = 0; cl = 0; }
    m.maxConsecWins = Math.max(m.maxConsecWins, cw); m.maxConsecLosses = Math.max(m.maxConsecLosses, cl);
  }
  // equity (P&L cumulato) e drawdown
  let e = 0, pk = 0, mdd = 0;
  m.equity = [{ t: tr.length ? tr[0].entryTime : 0, v: 0 }]; m.drawdown = [{ t: m.equity[0].t, v: 0 }];
  for (const t of tr) {
    e += t.pnl; pk = Math.max(pk, e); mdd = Math.max(mdd, pk - e);
    m.equity.push({ t: t.exitTime, v: e }); m.drawdown.push({ t: t.exitTime, v: -(pk - e) });
  }
  m.maxDD = mdd; m.maxDDpct = capital > 0 ? mdd / capital : null;
  m.recovery = mdd > 0 ? net / mdd : null;
  // giorni
  const days = new Map();
  for (const t of tr) { const k = dayKey(t.exitTime); if (!days.has(k)) days.set(k, bucket()); addTo(days.get(k), t); }
  m.days = [...days.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([day, b]) => ({ day, ...b }));
  const dw = m.days.filter(d => d.pnl > EPS).length;
  m.dayWinRate = m.days.length ? dw / m.days.length : null;
  m.avgDay = m.days.length ? net / m.days.length : null;
  m.bestDay = m.days.length ? Math.max(...m.days.map(d => d.pnl)) : null; m.worstDay = m.days.length ? Math.min(...m.days.map(d => d.pnl)) : null;
  // raggruppamenti
  const group = (keyFn) => { const g = new Map(); for (const t of tr) for (const k of [].concat(keyFn(t))) { if (k === undefined || k === null || k === '') continue; if (!g.has(k)) g.set(k, bucket()); addTo(g.get(k), t); } return g; };
  m.byHour = Array.from({ length: 24 }, (_, h) => ({ h, ...bucket() })); for (const t of tr) addTo(m.byHour[Math.floor((t.entryTime % 86400) / 3600)], t);
  m.byWeekday = Array.from({ length: 7 }, (_, d) => ({ d, ...bucket() })); for (const t of tr) addTo(m.byWeekday[new Date(t.exitTime * 1000).getUTCDay()], t);
  m.bySymbol = [...group(t => t.symbol)].map(([k, b]) => ({ k, ...b }));
  m.bySide = [...group(t => t.side)].map(([k, b]) => ({ k, ...b }));
  m.bySetup = [...group(t => (t.j && t.j.setup) || '')].map(([k, b]) => ({ k, ...b }));
  m.byTag = [...group(t => (t.j && t.j.tags) || [])].map(([k, b]) => ({ k, ...b })).sort((a, b) => b.n - a.n);
  m.byMistake = [...group(t => (t.j && t.j.mistakes) || [])].map(([k, b]) => ({ k, ...b })).sort((a, b) => a.pnl - b.pnl);
  m.byReason = [...group(t => t.reason)].map(([k, b]) => ({ k, ...b }));
  const durs = [['< 1 min', 60], ['1–5 min', 300], ['5–15 min', 900], ['15–60 min', 3600], ['> 1 ora', Infinity]];
  m.byDuration = durs.map(([k]) => ({ k, ...bucket() }));
  for (const t of tr) { const d = t.exitTime - t.entryTime; addTo(m.byDuration[durs.findIndex(x => d < x[1])], t); }
  m.rHist = histogram(rs.map(t => t.r), 12);
  m.pnlHist = histogram(tr.map(t => t.pnl), 12);
  // efficienza: quota del massimo movimento favorevole catturata (solo trade con MFE)
  const eff = tr.filter(t => t.mfe > 0 && t.qty > 0 && t.pv > 0).map(t => Math.max(0, Math.min(1, (t.pnl / t.qty / t.pv + 0) / t.mfe)));
  m.efficiency = eff.length ? sum(eff) / eff.length : null;
  m.avgMfe = tr.length ? sum(tr, t => t.mfe || 0) / n : null; m.avgMae = tr.length ? sum(tr, t => t.mae || 0) / n : null;
  m.score = score(m);
  return m;
}

// Punteggio 0–100 (media di 6 sotto-punteggi, ciascuno 0–100). Formule pubbliche e semplici:
export function score(m) {
  if (!m.n) return null;
  const parts = [
    ['Win %', clamp((m.winRate || 0) / 0.6 * 100), 'win rate; 60% = 100'],
    ['Profit factor', m.profitFactor === Infinity ? 100 : clamp(((m.profitFactor || 0) - 1) / 2 * 100), '1 = 0, 3 o più = 100'],
    ['Win/Loss medio', m.ratio == null ? (m.losses ? 0 : 100) : clamp(m.ratio / 3 * 100), 'media vincente / media perdente; 3 = 100'],
    ['Recovery factor', m.recovery == null ? (m.net > 0 ? 100 : 0) : clamp(m.recovery / 5 * 100), 'P&L netto / max drawdown; 5 = 100'],
    ['Drawdown', m.maxDDpct == null ? 50 : clamp((1 - m.maxDDpct / 0.2) * 100), 'max drawdown sul capitale; 0% = 100, 20% o più = 0'],
    ['Costanza', clamp((m.dayWinRate || 0) / 0.7 * 100), 'giorni in profitto; 70% = 100'],
  ];
  return { total: parts.reduce((s, p) => s + p[1], 0) / parts.length, parts: parts.map(([label, value, note]) => ({ label, value, note })) };
}

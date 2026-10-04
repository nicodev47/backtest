// Indicatori tecnici calcolati in modo incrementale: calc(bars, k) produce il valore all'indice k
// usando solo lo stato dei punti precedenti, così l'aggiornamento a ogni candela è O(periodo).
import { sessionKey } from './data.js';

const num = v => (v == null || Number.isNaN(v) ? null : v);

class Ind {
  constructor(id, params) {
    this.id = id; this.params = params; this.state = {};
    this.vals = this.lineDefs().map(() => []);
  }
  update(bars, k) { // calcola i valori per la barra k (nuova o in aggiornamento)
    const out = this.calc(bars, k);
    out.forEach((v, j) => { this.vals[j][k] = v; });
  }
  rebuild(bars) { this.vals = this.lineDefs().map(() => []); this.state = {}; for (let k = 0; k < bars.length; k++) this.update(bars, k); }
  point(j, k, bars) { const v = this.vals[j][k]; return v == null ? { time: bars[k].time } : { time: bars[k].time, value: v }; }
}

const closeAt = (bars, k) => bars[k].close;
function sma(bars, k, p, get = closeAt) {
  if (k < p - 1) return null;
  let s = 0; for (let i = k - p + 1; i <= k; i++) s += get(bars, i);
  return s / p;
}

class SMA extends Ind {
  lineDefs() { return [{ color: this.params.color, title: `SMA ${this.params.period}` }]; }
  calc(b, k) { return [sma(b, k, this.params.period)]; }
}
class EMA extends Ind {
  lineDefs() { return [{ color: this.params.color, title: `EMA ${this.params.period}` }]; }
  calc(b, k) {
    const p = this.params.period, a = 2 / (p + 1), v = this.vals[0];
    if (k < p - 1) return [null];
    if (k === p - 1) return [sma(b, k, p)];
    return [v[k - 1] + a * (b[k].close - v[k - 1])];
  }
}
class BB extends Ind {
  lineDefs() { return [{ color: '#2962ff', title: 'BB basis' }, { color: '#26a69a', title: 'BB sup' }, { color: '#ef5350', title: 'BB inf' }]; }
  calc(b, k) {
    const p = this.params.period, m = sma(b, k, p);
    if (m == null) return [null, null, null];
    let s = 0; for (let i = k - p + 1; i <= k; i++) s += (b[i].close - m) ** 2;
    const sd = Math.sqrt(s / p) * this.params.mult;
    return [m, m + sd, m - sd];
  }
}
class VWAP extends Ind {
  lineDefs() { return [{ color: '#ff9800', title: 'VWAP' }]; }
  calc(b, k) {
    const key = sessionKey(b[k].time), st = this.state;
    const tp = (b[k].high + b[k].low + b[k].close) / 3, vol = b[k].volume || 0;
    // somme cumulate per sessione, salvate per indice per poter ricalcolare l'ultima barra
    st.cum = st.cum || [];
    const prev = k > 0 ? st.cum[k - 1] : null;
    const base = prev && prev.key === key ? prev : { pv: 0, v: 0 };
    const cur = { key, pv: base.pv + tp * vol, v: base.v + vol };
    st.cum[k] = cur;
    return [cur.v > 0 ? cur.pv / cur.v : tp];
  }
}
class RSI extends Ind {
  lineDefs() { return [{ color: '#7e57c2', title: `RSI ${this.params.period}` }]; }
  calc(b, k) {
    const p = this.params.period, st = this.state;
    st.g = st.g || []; st.l = st.l || [];
    if (k === 0) { st.g[0] = 0; st.l[0] = 0; return [null]; }
    const ch = b[k].close - b[k - 1].close, g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (k < p) { st.g[k] = (st.g[k - 1] * (k - 1) + g) / k; st.l[k] = (st.l[k - 1] * (k - 1) + l) / k; return [null]; }
    st.g[k] = (st.g[k - 1] * (p - 1) + g) / p; st.l[k] = (st.l[k - 1] * (p - 1) + l) / p;
    return [st.l[k] === 0 ? 100 : 100 - 100 / (1 + st.g[k] / st.l[k])];
  }
  levels() { return [30, 70]; }
}
class MACD extends Ind {
  lineDefs() { return [{ color: '#2962ff', title: 'MACD' }, { color: '#ff9800', title: 'Signal' }, { color: '#26a69a', title: 'Hist', hist: true }]; }
  calc(b, k) {
    const { fast, slow, signal } = this.params, st = this.state;
    st.ef = st.ef || []; st.es = st.es || []; st.sg = st.sg || [];
    const c = b[k].close;
    st.ef[k] = k === 0 ? c : st.ef[k - 1] + (2 / (fast + 1)) * (c - st.ef[k - 1]);
    st.es[k] = k === 0 ? c : st.es[k - 1] + (2 / (slow + 1)) * (c - st.es[k - 1]);
    if (k < slow - 1) return [null, null, null];
    const m = st.ef[k] - st.es[k];
    st.m = st.m || []; st.m[k] = m;
    const first = slow - 1;
    st.sg[k] = k === first ? m : st.sg[k - 1] + (2 / (signal + 1)) * (m - st.sg[k - 1]);
    if (k < first + signal - 1) return [m, null, null];
    return [m, st.sg[k], m - st.sg[k]];
  }
}
class ATR extends Ind {
  lineDefs() { return [{ color: '#ef5350', title: `ATR ${this.params.period}` }]; }
  calc(b, k) {
    const p = this.params.period, st = this.state; st.tr = st.tr || []; st.a = st.a || [];
    const tr = k === 0 ? b[0].high - b[0].low : Math.max(b[k].high - b[k].low, Math.abs(b[k].high - b[k - 1].close), Math.abs(b[k].low - b[k - 1].close));
    st.tr[k] = tr;
    if (k < p - 1) return [null];
    if (k === p - 1) { let s = 0; for (let i = 0; i < p; i++) s += st.tr[i]; st.a[k] = s / p; return [st.a[k]]; }
    st.a[k] = (st.a[k - 1] * (p - 1) + tr) / p;
    return [st.a[k]];
  }
}

export const CATALOG = {
  sma:  { name: 'Media mobile semplice (SMA)', pane: 'main', cls: SMA,  defaults: { period: 20, color: '#2962ff' } },
  ema:  { name: 'Media mobile esponenziale (EMA)', pane: 'main', cls: EMA, defaults: { period: 21, color: '#ff9800' } },
  bb:   { name: 'Bande di Bollinger', pane: 'main', cls: BB, defaults: { period: 20, mult: 2 } },
  vwap: { name: 'VWAP (sessione)', pane: 'main', cls: VWAP, defaults: {} },
  rsi:  { name: 'RSI', pane: 'osc', cls: RSI, defaults: { period: 14 } },
  macd: { name: 'MACD', pane: 'osc', cls: MACD, defaults: { fast: 12, slow: 26, signal: 9 } },
  atr:  { name: 'ATR', pane: 'osc', cls: ATR, defaults: { period: 14 } },
};
export function createIndicator(spec) {
  const c = CATALOG[spec.type];
  return new c.cls(spec.type, { ...c.defaults, ...spec.params });
}

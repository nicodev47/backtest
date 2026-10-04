// Motore del replay: un Feed per simbolo (dati 1m + conto + eventuali tick) e un orologio globale T.
// Senza DOM: usato dall'interfaccia e dai test.
//
// T = secondi (ET trattato come UTC, anche frazionari) già "rivelati". I minuti completi sono quelli con
// t+60 <= T; se T cade dentro un minuto, quel minuto è in formazione.
//
// Due modalità per ogni minuto:
//  - "tick": se per quel giorno ci sono i tick reali, la candela si aggiorna a ogni scambio
//    (close, high, low e volume seguono i tick) e gli ordini vengono eseguiti sul prezzo del tick.
//  - "sec" : senza tick i secondi sono SIMULATI percorrendo la candela O->L->H->C (rialzista) o
//    O->H->L->C (ribassista) in 60 passi; l'OHLC della candela completa resta esatto.
import * as Broker from './broker.js';
import { firstIndexAtOrAfter } from './data.js';

const DAY = 86400;
const lowerBound = (arr, x, lo, hi) => { while (lo < hi) { const m = (lo + hi) >> 1; arr[m] < x ? lo = m + 1 : hi = m; } return lo; };

// Giorni di tick caricati a richiesta. fetcher(sym, d) -> { n, t:Float64Array, p:Float64Array, v:Float32Array }.
export class TickStore {
  constructor(sym, index, fetcher) {
    this.sym = sym; this.fetcher = fetcher;
    this.index = new Map(((index && index.days) || []).map(x => [x.d, x]));
    this.loaded = new Map(); this.pending = new Map(); this.failed = new Set();
    this.onError = null;
  }
  has(d) { return this.index.has(d) && !this.failed.has(d); }
  ready(d) { return this.loaded.has(d); }
  get(d) { return this.loaded.get(d); }
  load(d) {
    if (!this.has(d) || this.ready(d)) return Promise.resolve();
    if (!this.pending.has(d)) {
      this.pending.set(d, this.fetcher(this.sym, d).then(
        x => { this.loaded.set(d, x); this.pending.delete(d); },
        e => { this.pending.delete(d); this.failed.add(d); if (this.onError) this.onError(d, e); }));
    }
    return this.pending.get(d);
  }
  nextDay(d) { let best = null; for (const k of this.index.keys()) if (k > d && (best === null || k < best)) best = k; return best; }
  evict(keep) { for (const d of [...this.loaded.keys()]) if (!keep.includes(d)) this.loaded.delete(d); }
}

export class Feed {
  constructor(asset, D, commission = 0, acc = null, store = null) {
    this.sym = asset.symbol; this.asset = asset; this.D = D; this.store = store;
    this.cfg = { capital: 0, pointValue: asset.pointValue, tickSize: asset.tickSize, commission };
    this.acc = acc && acc.nextId ? acc : Broker.newAccount();
    this.i = -1;            // indice dell'ultimo minuto completo
    this.m = null;          // minuto in corso: { k, M, mode, started, o,h,l,c,v, ... }
    this.ver = 0;           // cambia a ogni variazione visibile (barre)
    this.applied = 0; this.waiting = false;
    this._path = { k: -1, p: null };
  }
  get len() { return this.D.t.length; }
  get partial() { return this.m && this.m.started ? this.m : null; }
  get ticksMode() { return !!(this.m && this.m.mode === 'tick'); }
  busy() { return !!(this.acc.position || this.acc.orders.length || (this.acc.alerts && this.acc.alerts.length)); }
  nextMinute() { const k = this.i + 1; return k < this.len ? this.D.t[k] : Infinity; }
  price() {
    if (this.m && this.m.started) return this.m.c;
    return this.i >= 0 ? this.D.c[this.i] : this.D.o[0];
  }
  secPath(k) {
    if (this._path.k === k) return this._path.p;
    const D = this.D, o = D.o[k], h = D.h[k], l = D.l[k], c = D.c[k], tick = this.cfg.tickSize;
    const kp = c >= o ? [o, l, h, c] : [o, h, l, c], p = new Array(61);
    for (let s = 0; s <= 60; s++) {
      const x = s / 20, seg = Math.min(2, Math.floor(x)), f = x - seg;
      p[s] = Math.round((kp[seg] + (kp[seg + 1] - kp[seg]) * f) / tick) * tick;
    }
    p[0] = o; p[60] = c;
    this._path = { k, p };
    return p;
  }
  tag(ev) { for (const e of ev) if (e.trade) e.trade.symbol = this.sym; return ev; }

  // 'none' (si simula) | 'wait' (tick del giorno in caricamento) | { tk, a, b } (indici tick del minuto k)
  tickInfo(k) {
    if (!this.store) return 'none';
    const M = this.D.t[k], d = Math.floor(M / DAY);
    if (!this.store.has(d)) return 'none';
    if (!this.store.ready(d)) { this.store.load(d); return this.store.has(d) ? 'wait' : 'none'; }
    const tk = this.store.get(d), a = lowerBound(tk.t, M, 0, tk.n), b = lowerBound(tk.t, M + 60, a, tk.n);
    return b > a ? { tk, a, b } : 'none';
  }
  async preload(T) { // carica il giorno di T e (senza attendere) il successivo
    if (!this.store) return;
    const d = Math.floor(T / DAY);
    await this.store.load(d);
    const nd = this.store.nextDay(d);
    if (nd !== null && nd - d <= 4) this.store.load(nd);
    this.store.evict([d - 1, d, nd]);
  }
  enter(k) {
    const info = this.tickInfo(k);
    if (info === 'wait') return false;
    const M = this.D.t[k], D = this.D;
    this.m = info === 'none'
      ? { k, M, mode: 'sec', s: 0, started: false, o: D.o[k], h: D.o[k], l: D.o[k], c: D.o[k], v: 0 }
      : { k, M, mode: 'tick', tk: info.tk, ti: info.a, b: info.b, started: false, o: 0, h: 0, l: 0, c: 0, v: 0 };
    return true;
  }
  // Riallinea indice e minuto in formazione a T senza toccare il conto.
  setTime(T) {
    const D = this.D;
    this.i = firstIndexAtOrAfter(D.t, T - 59) - 1;
    this.m = null; this.ver++;
    const k = this.i + 1;
    if (k < this.len && D.t[k] < T) {
      if (!this.enter(k)) { this.waiting = true; return; }
      this.processUntil(T, true);
    }
  }
  // Prossimo istante in cui questo feed cambia stato (Infinity = nessuno, NaN = attende dati tick).
  nextEvent() {
    const m = this.m;
    if (!m) {
      const k = this.i + 1; if (k >= this.len) return Infinity;
      const info = this.tickInfo(k);
      if (info === 'wait') return NaN;
      return info === 'none' ? this.D.t[k] + 1 : info.tk.t[info.a];
    }
    if (m.mode === 'tick') return m.ti < m.b ? m.tk.t[m.ti] : m.M + 60;
    return m.M + m.s + 1;
  }
  // Applica tutto ciò che accade fino all'istante e (compreso). silent = non toccare il conto.
  processUntil(e, silent = false) {
    const ev = [], D = this.D;
    for (;;) {
      if (!this.m) {
        const k = this.i + 1;
        if (k >= this.len || D.t[k] > e) break;
        if (!this.enter(k)) { this.waiting = true; break; }
      }
      const m = this.m;
      if (m.mode === 'tick') {
        const { t, p, v } = m.tk;
        while (m.ti < m.b && t[m.ti] <= e) {
          const px = p[m.ti];
          if (!m.started) { m.started = true; m.o = m.h = m.l = px; m.v = 0; }
          if (px > m.h) m.h = px;
          if (px < m.l) m.l = px;
          m.c = px; m.v += v[m.ti];
          if (!silent && this.busy()) ev.push(...this.tag(Broker.onBar(this.cfg, this.acc, { t: t[m.ti], o: px, h: px, l: px, c: px })));
          m.ti++; this.applied++; this.ver++;
        }
        if (m.ti >= m.b && e >= m.M + 60) { this.i = m.k; this.m = null; this.ver++; continue; }
        break;
      }
      const target = Math.min(60, Math.floor(e - m.M + 1e-9)), path = this.secPath(m.k);
      while (m.s < target) {
        const s = m.s + 1, prev = path[s - 1], cur = path[s];
        if (!silent) ev.push(...this.tag(Broker.onBar(this.cfg, this.acc, { t: m.M + s, o: prev, h: Math.max(prev, cur), l: Math.min(prev, cur), c: cur })));
        m.s = s; m.started = true; m.h = Math.max(m.h, cur); m.l = Math.min(m.l, cur); m.c = cur; m.v = D.v[m.k] * s / 60;
        this.applied++; this.ver++;
        if (s === 60) { this.i = m.k; this.m = null; break; }
      }
      if (this.m) break;
    }
    return ev;
  }
  // Minuto intero in un colpo (percorso veloce, solo a minuto non iniziato). null = attende i tick.
  canMinute() { return !this.busy() || this.tickInfo(this.i + 1) !== 'wait'; }
  minute(M) {
    const k = this.i + 1, D = this.D;
    if (!this.busy()) { this.i = k; this.ver++; this.applied++; return []; }
    const info = this.tickInfo(k);
    if (info === 'wait') return null;
    if (info === 'none') {
      const ev = Broker.onBar(this.cfg, this.acc, { t: M + 60, o: D.o[k], h: D.h[k], l: D.l[k], c: D.c[k] });
      this.i = k; this.ver++; this.applied++;
      return this.tag(ev);
    }
    this.enter(k);
    return this.processUntil(M + 60);
  }
}

export class Replay {
  constructor(feeds, T) {
    this.feeds = feeds; // Map sym -> Feed
    this.T = T;
    this.onEvents = null;
    this.stopReq = false;
    this.waiting = false;
    for (const f of feeds.values()) f.setTime(T);
  }
  all() { return [...this.feeds.values()]; }
  addFeed(f) { f.setTime(this.T); this.feeds.set(f.sym, f); }
  emit(f, ev) { if (ev && ev.length && this.onEvents) this.onEvents(f, ev); }
  nextMinute() { return Math.min(...this.all().map(f => f.nextMinute())); }
  idle() { return this.all().every(f => !f.m && f.nextMinute() > this.T); }
  aligned() { return this.T % 60 === 0 && this.all().every(f => !f.m) && this.all().some(f => f.nextMinute() === this.T); }
  nextEvent() {
    let e = Infinity;
    for (const f of this.all()) { const x = f.nextEvent(); if (Number.isNaN(x)) return NaN; if (x < e) e = x; }
    return e;
  }
  process(e) {
    for (const f of this.all()) { this.emit(f, f.processUntil(e)); if (f.waiting) { this.waiting = true; f.waiting = false; } }
  }
  async preloadAll() { await Promise.all(this.all().map(f => f.preload(this.T))); }

  // Avanza di `sec` secondi di mercato (i vuoti senza dati non contano; si ferma su stopReq o a fine sessione).
  advance(sec) {
    this.waiting = false;
    let rem = sec, consumed = false;
    while (rem > 1e-9) {
      if (this.stopReq) return true;
      if (rem >= 60 && this.aligned()) { // percorso veloce: minuti interi
        const M = this.T, due = this.all().filter(f => f.nextMinute() === M);
        if (due.some(f => !f.canMinute())) { this.waiting = true; return true; }
        const out = due.map(f => [f, f.minute(M)]);
        this.T = M + 60; rem -= 60; consumed = true;
        for (const [f, ev] of out) this.emit(f, ev);
        continue;
      }
      const e = this.nextEvent();
      if (Number.isNaN(e)) { this.waiting = true; return true; }
      if (e === Infinity) return false;
      if (this.idle()) {
        const nm = this.nextMinute();
        if (nm > this.T) { if (consumed) return true; this.T = nm; continue; } // salta i vuoti (non conta)
      }
      const dt = e - this.T;
      if (dt <= rem + 1e-9) {
        rem -= Math.max(0, dt); this.T = Math.max(this.T, e);
        this.process(this.T);
        if (dt > 0) consumed = true;
        if (this.waiting) return true;
      } else { this.T += rem; rem = 0; consumed = true; }
    }
    return true;
  }
  // Avanza fino al prossimo scambio (tick) o, senza tick, al prossimo secondo.
  stepEvent() {
    this.waiting = false;
    for (let guard = 0; guard < 100000; guard++) {
      const e = this.nextEvent();
      if (Number.isNaN(e)) { this.waiting = true; return true; }
      if (e === Infinity) return false;
      if (this.idle() && this.nextMinute() > this.T) { this.T = this.nextMinute(); continue; }
      this.all().forEach(f => { f.applied = 0; });
      this.T = Math.max(this.T, e);
      this.process(this.T);
      if (this.waiting || this.all().some(f => f.applied > 0)) return true;
    }
    return true;
  }
  // Salto in avanti (eventi inclusi, ma senza fermarsi). Carica i tick solo dove servono (posizioni/ordini aperti).
  async jumpTo(target) {
    if (target <= this.T) return false;
    for (let guard = 0; this.T < target && guard < 200000; guard++) {
      await Promise.all(this.all().filter(f => f.busy()).map(f => f.preload(this.T)));
      this.stopReq = false;
      if (!this.advance(Math.min(target - this.T, 7200))) break;
      if (this.waiting) await this.preloadAll();
    }
    await this.preloadAll();
    return true;
  }
}

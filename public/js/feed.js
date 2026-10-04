// Motore del replay: un Feed per simbolo (dati 1m + conto) e un orologio globale T condiviso.
// Senza DOM: usato dall'interfaccia e dai test.
//
// T = secondi (ET trattato come UTC) già "rivelati". I minuti completi sono quelli con t+60 <= T;
// se T cade dentro un minuto, quel minuto è in formazione e rivelato fino al secondo T - t.
// I dati sono a 1 minuto: i secondi sono SIMULATI percorrendo la candela O->L->H->C (rialzista)
// o O->H->L->C (ribassista) in 60 passi; open/high/low/close della candela completa restano esatti.
import * as Broker from './broker.js';
import { firstIndexAtOrAfter } from './data.js';

export class Feed {
  constructor(asset, D, commission = 0, acc = null) {
    this.sym = asset.symbol; this.asset = asset; this.D = D;
    this.cfg = { capital: 0, pointValue: asset.pointValue, tickSize: asset.tickSize, commission };
    this.acc = acc && acc.nextId ? acc : Broker.newAccount();
    this.i = -1; this.partial = null; this._path = { k: -1, p: null };
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
  get len() { return this.D.t.length; }
  nextMinute() { return this.i + 1 < this.len ? this.D.t[this.i + 1] : Infinity; }
  price() {
    if (this.partial) return this.secPath(this.partial.k)[this.partial.s];
    return this.i >= 0 ? this.D.c[this.i] : this.D.o[0];
  }
  // Riallinea indice e minuto in formazione a T senza toccare il conto.
  setTime(T) {
    const D = this.D;
    this.i = firstIndexAtOrAfter(D.t, T - 59) - 1;
    this.partial = null;
    const k = this.i + 1;
    if (k < this.len && D.t[k] < T) {
      const p = this.secPath(k), s = T - D.t[k];
      let h = p[0], l = p[0];
      for (let j = 1; j <= s; j++) { h = Math.max(h, p[j]); l = Math.min(l, p[j]); }
      this.partial = { k, s, h, l };
    }
  }
  tag(ev) { for (const e of ev) if (e.trade) e.trade.symbol = this.sym; return ev; }
  tick(M, s) { // secondo s (1..60) del minuto M
    const k = this.i + 1, D = this.D;
    if (k >= this.len || D.t[k] !== M) return [];
    const p = this.secPath(k), prev = p[s - 1], cur = p[s];
    if (!this.partial) this.partial = { k, s: 0, h: D.o[k], l: D.o[k] };
    const ev = Broker.onBar(this.cfg, this.acc, { t: M + s, o: prev, h: Math.max(prev, cur), l: Math.min(prev, cur), c: cur });
    const pt = this.partial;
    pt.s = s; pt.h = Math.max(pt.h, cur); pt.l = Math.min(pt.l, cur);
    if (s === 60) { this.i = k; this.partial = null; }
    return this.tag(ev);
  }
  minute(M) { // intero minuto M in un colpo (solo se non c'è un minuto in formazione)
    const k = this.i + 1, D = this.D;
    if (k >= this.len || D.t[k] !== M) return [];
    const ev = Broker.onBar(this.cfg, this.acc, { t: M + 60, o: D.o[k], h: D.h[k], l: D.l[k], c: D.c[k] });
    this.i = k;
    return this.tag(ev);
  }
}

export class Replay {
  constructor(feeds, T) {
    this.feeds = feeds; // Map sym -> Feed
    this.T = T;
    this.onEvents = null;
    this.stopReq = false;
    for (const f of feeds.values()) f.setTime(T);
  }
  all() { return [...this.feeds.values()]; }
  nextMinute() { return Math.min(...this.all().map(f => f.nextMinute())); }
  addFeed(f) { f.setTime(this.T); this.feeds.set(f.sym, f); }
  emit(f, ev) { if (ev.length && this.onEvents) this.onEvents(f, ev); }
  skipGap() { // sul confine di minuto salta i vuoti (notte/weekend) fino al prossimo dato
    if (this.T % 60) return true;
    const nm = this.nextMinute();
    if (nm === Infinity) return false;
    if (nm > this.T) this.T = nm;
    return true;
  }
  stepSecond() {
    if (!this.skipGap()) return false;
    const M = this.T - (this.T % 60), s = (this.T % 60) + 1;
    for (const f of this.all()) this.emit(f, f.tick(M, s));
    this.T++;
    return true;
  }
  stepMinute() { // completa il minuto in formazione, oppure avanza di un minuto intero
    if (this.T % 60) { while (this.T % 60) if (!this.stepSecond()) return false; return true; }
    if (!this.skipGap()) return false;
    const M = this.T;
    for (const f of this.all()) this.emit(f, f.minute(M));
    this.T = M + 60;
    return true;
  }
  // Avanza di `sec` secondi di mercato (i vuoti senza dati non contano). Si ferma su stopReq.
  advance(sec) {
    while (sec > 0) {
      if (this.T % 60 === 0 && sec >= 60) { if (!this.stepMinute()) return false; sec -= 60; }
      else { if (!this.stepSecond()) return false; sec--; }
      if (this.stopReq) return true;
    }
    return true;
  }
  // Salto in avanti (eventi inclusi, ma senza fermarsi): ritorna false se target <= T.
  jumpTo(target) {
    if (target <= this.T) return false;
    while (this.T < target) {
      if (this.T % 60 === 0 && this.T + 60 <= target) { if (!this.stepMinute()) break; }
      else if (!this.stepSecond()) break;
    }
    return true;
  }
}

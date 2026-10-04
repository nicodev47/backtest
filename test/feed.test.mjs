import assert from 'node:assert/strict';
import test from 'node:test';
import { Feed, Replay, TickStore } from '../public/js/feed.js';
import * as B from '../public/js/broker.js';
import { synthTicks, toDayArrays } from './helpers/synth.mjs';

const mk = (rows) => ({ t: rows.map(r => r[0]), o: rows.map(r => r[1]), h: rows.map(r => r[2]), l: rows.map(r => r[3]), c: rows.map(r => r[4]), v: rows.map(r => r[5]) });
const asset = { symbol: 'X', pointValue: 20, tickSize: 0.25 };
const rows = [[0, 100, 110, 95, 105, 200], [60, 105, 108, 90, 92, 150], [120, 92, 99, 91, 98, 120], [86400, 200, 210, 190, 205, 90]];
const mkReplay = (store = null, T = 0, extra = {}) => { const f = new Feed({ ...asset, ...extra }, mk(rows), 0, null, store); return [f, new Replay(new Map([[f.sym, f]]), T)]; };

test('secondi simulati: percorso rispetta OHLC e chiude esattamente', () => {
  const [f, r] = mkReplay();
  r.advance(60);
  assert.equal(f.i, 0); assert.equal(f.partial, null);
  const p = f.secPath(0);
  assert.equal(Math.max(...p), 110); assert.equal(Math.min(...p), 95); assert.equal(p[0], 100); assert.equal(p[60], 105);
});

test('minuto in formazione e setTime coerenti', () => {
  const [f, r] = mkReplay();
  r.advance(90);
  assert.equal(r.T, 90); assert.equal(f.i, 0); assert.equal(f.partial.k, 1);
  const g = new Feed(asset, mk(rows)); g.setTime(90);
  assert.deepEqual([g.partial.h, g.partial.l, g.partial.c], [f.partial.h, f.partial.l, f.partial.c]);
});

test('salta i vuoti tra le sessioni', () => {
  const [f, r] = mkReplay();
  r.advance(180);
  assert.equal(r.T, 180); assert.equal(f.i, 2);
  r.advance(1);
  assert.equal(r.T, 86401); assert.equal(f.partial.k, 3);
});

test('secondi e minuti danno lo stesso esito sugli stop', async () => {
  const run = async bySeconds => {
    const [f, r] = mkReplay(); r.advance(1);
    B.placeOrder(f.cfg, f.acc, { type: 'market', side: 'buy', qty: 1, sl: 94, tp: null }, { t: r.T, c: f.price() });
    if (bySeconds) { for (let k = 0; k < 120; k++) r.advance(1); } else await r.jumpTo(120);
    return f.acc.trades.map(t => t.reason);
  };
  assert.deepEqual(await run(true), ['sl']); assert.deepEqual(await run(false), ['sl']);
});

test('due feed sullo stesso orologio, trade marcati col simbolo', () => {
  const f1 = new Feed(asset, mk(rows)), f2 = new Feed({ ...asset, symbol: 'Y' }, mk(rows));
  const r = new Replay(new Map([['X', f1], ['Y', f2]]), 0);
  r.advance(1);
  B.placeOrder(f2.cfg, f2.acc, { type: 'market', side: 'sell', qty: 1, sl: 104, tp: null }, { t: r.T, c: f2.price() });
  r.advance(60);
  assert.equal(f2.acc.trades[0]?.symbol, 'Y'); assert.equal(f1.acc.trades.length, 0);
});

// ---- tick ----
const ticks = synthTicks(rows.slice(0, 3));
const day0 = toDayArrays(ticks);
const mkStore = () => new TickStore('X', { days: [{ d: 0, n: day0.n }] }, async () => day0);

test('tick sintetici: coerenti con le candele a 1 minuto', () => {
  for (const [M, o, h, l, c, v] of rows.slice(0, 3)) {
    const t = ticks.filter(x => x.t >= M && x.t < M + 60);
    assert.equal(t[0].p, o); assert.equal(t.at(-1).p, c);
    assert.equal(Math.max(...t.map(x => x.p)), h); assert.equal(Math.min(...t.map(x => x.p)), l);
    assert.equal(t.reduce((a, x) => a + x.v, 0), v);
  }
});

test('tick: la candela si muove a ogni scambio e a fine minuto coincide con l\'1m', async () => {
  const store = mkStore(); await store.load(0);
  const [f, r] = mkReplay(store);
  assert.equal(r.stepEvent(), true);
  const first = ticks[0];
  assert.equal(r.T, first.t); assert.equal(f.partial.c, first.p); assert.equal(f.partial.v, first.v);
  r.stepEvent();
  assert.equal(r.T, ticks[1].t); assert.equal(f.partial.v, ticks[0].v + ticks[1].v);
  r.advance(60 - r.T + 0.0001); // arriva a fine minuto
  assert.equal(f.i, 0);
  assert.equal(r.T >= 60, true);
});

test('tick: stepEvent non si ferma sulla sola chiusura del minuto', async () => {
  const store = mkStore(); await store.load(0);
  const [f, r] = mkReplay(store);
  const n0 = ticks.filter(x => x.t < 60).length;
  for (let k = 0; k < n0; k++) r.stepEvent();
  assert.equal(r.T, ticks[n0 - 1].t); assert.equal(f.partial.c, rows[0][4]);
  r.stepEvent(); // prossimo evento = primo tick del minuto successivo
  assert.equal(r.T, ticks[n0].t); assert.equal(f.i, 0); assert.equal(f.partial.k, 1);
});

test('tick: l\'ordine esegue sul prezzo del tick (stop con gap)', async () => {
  const store = mkStore(); await store.load(0);
  const [f, r] = mkReplay(store);
  r.stepEvent();
  B.placeOrder(f.cfg, f.acc, { type: 'market', side: 'buy', qty: 1, sl: 96, tp: null }, { t: r.T, c: f.price() });
  r.advance(60);
  const t = f.acc.trades[0];
  assert.equal(t.reason, 'sl');
  const hit = ticks.find(x => x.t > ticks[0].t && x.p <= 96);
  assert.equal(t.exit, hit.p); assert.equal(t.exitTime, hit.t);
});

test('tick: attesa del caricamento invece di simulare', async () => {
  const store = mkStore();
  const [f, r] = mkReplay(store);
  r.advance(5);
  assert.equal(r.waiting, true); assert.equal(r.T, 0);
  await r.preloadAll();
  r.advance(5);
  assert.equal(r.waiting, false); assert.ok(r.T > 0);
});

test('tick: setTime ricostruisce il minuto in corso', async () => {
  const store = mkStore(); await store.load(0);
  const [f, r] = mkReplay(store);
  r.advance(30);
  const g = new Feed(asset, mk(rows), 0, null, store); g.setTime(30);
  assert.deepEqual([g.partial?.h, g.partial?.l, g.partial?.c, g.partial?.v], [f.partial?.h, f.partial?.l, f.partial?.c, f.partial?.v]);
});

test('salto con posizione aperta usa i tick e rispetta il giorno senza tick', async () => {
  const store = mkStore();
  const [f, r] = mkReplay(store);
  await store.load(0);
  r.advance(1);
  B.placeOrder(f.cfg, f.acc, { type: 'market', side: 'buy', qty: 1, sl: 90.5, tp: null }, { t: r.T, c: f.price() });
  await r.jumpTo(180);
  assert.equal(f.acc.trades[0].reason, 'sl');
  await r.jumpTo(86400 + 60);
  assert.equal(f.i, 3);
});

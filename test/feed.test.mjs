import assert from 'node:assert/strict';
import test from 'node:test';
import { Feed, Replay } from '../public/js/feed.js';
import * as B from '../public/js/broker.js';

const mk = (rows) => ({ t: rows.map(r => r[0]), o: rows.map(r => r[1]), h: rows.map(r => r[2]), l: rows.map(r => r[3]), c: rows.map(r => r[4]), v: rows.map(() => 10) });
const asset = { symbol: 'X', pointValue: 20, tickSize: 0.25 };
const rows = [[0, 100, 110, 95, 105], [60, 105, 108, 90, 92], [120, 92, 99, 91, 98], [86400, 200, 210, 190, 205]];

test('secondi simulati: percorso rispetta OHLC e chiude esattamente', () => {
  const f = new Feed(asset, mk(rows)), r = new Replay(new Map([['X', f]]), 0);
  r.advance(60);
  assert.equal(f.i, 0);
  assert.equal(f.partial, null);
  const p = f.secPath(0);
  assert.equal(Math.max(...p), 110); assert.equal(Math.min(...p), 95); assert.equal(p[0], 100); assert.equal(p[60], 105);
});

test('minuto in formazione e setTime coerenti', () => {
  const f = new Feed(asset, mk(rows)), r = new Replay(new Map([['X', f]]), 0);
  r.advance(90);
  assert.equal(r.T, 90); assert.equal(f.i, 0); assert.equal(f.partial.s, 30);
  const g = new Feed(asset, mk(rows)); g.setTime(90);
  assert.deepEqual(g.partial, f.partial); assert.equal(g.i, f.i);
});

test('salta i vuoti tra le sessioni', () => {
  const f = new Feed(asset, mk(rows)), r = new Replay(new Map([['X', f]]), 0);
  r.advance(180); // tre minuti
  assert.equal(r.T, 180); assert.equal(f.i, 2);
  r.advance(1);
  assert.equal(r.T, 86401); assert.equal(f.partial.k, 3);
});

test('secondi e minuti danno lo stesso risultato sugli ordini a mercato/SL', () => {
  const run = (bySeconds) => {
    const f = new Feed(asset, mk(rows)), r = new Replay(new Map([['X', f]]), 0);
    r.advance(1);
    B.placeOrder(f.cfg, f.acc, { type: 'market', side: 'buy', qty: 1, sl: 94, tp: null }, { t: r.T, c: f.price() });
    if (bySeconds) { while (r.T < 120) r.stepSecond(); } else r.jumpTo(120);
    return f.acc.trades.map(t => [t.reason, t.exit]);
  };
  const a = run(true), b = run(false);
  assert.equal(a[0][0], 'sl'); assert.equal(b[0][0], 'sl');
});

test('due feed sullo stesso orologio con tag simbolo sui trade', () => {
  const f1 = new Feed(asset, mk(rows)), f2 = new Feed({ ...asset, symbol: 'Y' }, mk(rows));
  const r = new Replay(new Map([['X', f1], ['Y', f2]]), 0);
  r.advance(1);
  B.placeOrder(f2.cfg, f2.acc, { type: 'market', side: 'sell', qty: 1, sl: 104, tp: null }, { t: r.T, c: f2.price() });
  r.advance(60);
  assert.equal(f2.acc.trades[0]?.symbol, 'Y');
  assert.equal(f1.acc.trades.length, 0);
});

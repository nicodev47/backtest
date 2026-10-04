import assert from 'node:assert/strict';
import test from 'node:test';
import * as B from '../public/js/broker.js';

const cfg = { capital: 50000, pointValue: 20, tickSize: 0.25, commission: 0 };
const bar = (t, o, h, l, c) => ({ t, o, h, l, c });

test('market long con TP raggiunto', () => {
  const a = B.newAccount();
  B.placeOrder(cfg, a, { type: 'market', side: 'buy', qty: 2, sl: 90, tp: 120 }, bar(1, 100, 100, 100, 100));
  assert.equal(a.position.qty, 2);
  assert.equal(a.position.risk, 10 * 2 * 20);
  B.onBar(cfg, a, bar(2, 100, 110, 99, 105));
  assert.ok(a.position);
  B.onBar(cfg, a, bar(3, 105, 125, 104, 124));
  assert.equal(a.position, null);
  assert.equal(a.trades[0].pnl, 20 * 2 * 20);
  assert.equal(a.trades[0].r, 2);
  assert.equal(a.trades[0].reason, 'tp');
});

test('SL e TP nella stessa candela: vale lo stop', () => {
  const a = B.newAccount();
  B.placeOrder(cfg, a, { type: 'market', side: 'sell', qty: 1, sl: 110, tp: 90 }, bar(1, 100, 100, 100, 100));
  B.onBar(cfg, a, bar(2, 100, 115, 85, 100));
  assert.equal(a.trades[0].reason, 'sl');
  assert.equal(a.trades[0].pnl, -10 * 20);
});

test('gap oltre lo stop: fill all\'apertura', () => {
  const a = B.newAccount();
  B.placeOrder(cfg, a, { type: 'market', side: 'buy', qty: 1, sl: 95 }, bar(1, 100, 100, 100, 100));
  B.onBar(cfg, a, bar(2, 90, 92, 88, 91));
  assert.equal(a.trades[0].exit, 90);
});

test('ordini limit e stop pendenti + bracket', () => {
  const a = B.newAccount();
  const r = B.placeOrder(cfg, a, { type: 'limit', side: 'buy', qty: 1, price: 98, sl: 95, tp: 106 }, bar(1, 100, 100, 100, 100));
  assert.ok(r.order);
  assert.ok(B.placeOrder(cfg, a, { type: 'limit', side: 'buy', qty: 1, price: 101 }, bar(1, 100, 100, 100, 100)).error);
  B.onBar(cfg, a, bar(2, 99, 100, 97, 99));
  assert.equal(a.orders.length, 0);
  assert.equal(a.position.entry, 98);
  assert.equal(a.position.tp, 106);
});

test('netting: riduzione e inversione', () => {
  const a = B.newAccount();
  B.placeOrder(cfg, a, { type: 'market', side: 'buy', qty: 3 }, bar(1, 100, 100, 100, 100));
  B.placeOrder(cfg, a, { type: 'market', side: 'sell', qty: 1 }, bar(2, 101, 101, 101, 101));
  assert.equal(a.position.qty, 2);
  assert.equal(a.trades[0].pnl, 20);
  B.placeOrder(cfg, a, { type: 'market', side: 'sell', qty: 5 }, bar(3, 102, 102, 102, 102));
  assert.equal(a.position.side, 'short');
  assert.equal(a.position.qty, 3);
  assert.equal(a.trades.length, 2);
});

test('commissioni e statistiche', () => {
  const c = { ...cfg, commission: 2 };
  const a = B.newAccount();
  B.placeOrder(c, a, { type: 'market', side: 'buy', qty: 2 }, bar(1, 100, 100, 100, 100));
  B.closePosition(c, a, bar(2, 101, 101, 101, 101));
  assert.equal(a.trades[0].pnl, 20 * 2 - 8);
  const s = B.stats(c, a);
  assert.equal(s.n, 1);
  assert.equal(s.winRate, 1);
});

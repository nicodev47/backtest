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

test('chiusura parziale e id posizione', () => {
  const a = B.newAccount();
  B.placeOrder(cfg, a, { type: 'market', side: 'buy', qty: 4, sl: 90 }, bar(1, 100, 100, 100, 100));
  const pid = a.position.pid;
  assert.ok(pid);
  B.closePosition(cfg, a, bar(2, 102, 102, 102, 102), 'manual', 1);
  assert.equal(a.position.qty, 3);
  assert.equal(a.trades[0].qty, 1); assert.equal(a.trades[0].pid, pid);
  assert.equal(a.trades[0].pnl, 2 * 20);
  assert.equal(a.position.risk, 10 * 3 * 20); // rischio riproporzionato sulla quota rimasta
  B.closePosition(cfg, a, bar(3, 101, 101, 101, 101));
  assert.equal(a.position, null); assert.equal(a.trades.length, 2);
});

test('slippage: market e stop avversi, TP senza slippage', () => {
  const c = { ...cfg, slippage: 2 }; // 2 tick = 0,5 punti
  const a = B.newAccount();
  B.placeOrder(c, a, { type: 'market', side: 'buy', qty: 1, sl: 90, tp: 120 }, bar(1, 100, 100, 100, 100));
  assert.equal(a.position.entry, 100.5);
  B.onBar(c, a, bar(2, 100, 125, 100, 124));
  assert.equal(a.trades[0].exit, 120); // TP: nessuno slippage
  B.placeOrder(c, a, { type: 'market', side: 'sell', qty: 1, sl: 110 }, bar(3, 100, 100, 100, 100));
  assert.equal(a.position.entry, 99.5);
  B.onBar(c, a, bar(4, 105, 112, 104, 111));
  assert.equal(a.trades[1].exit, 110.5); // SL di uno short: peggiora di 0,5 oltre lo stop
});

test('trailing stop segue il prezzo e non arretra; R usa il rischio iniziale', () => {
  const a = B.newAccount();
  B.placeOrder(cfg, a, { type: 'market', side: 'buy', qty: 1, sl: 90, trail: 10 }, bar(1, 100, 100, 100, 100));
  B.onBar(cfg, a, bar(2, 100, 120, 100, 118));
  assert.equal(a.position.sl, 110);
  B.onBar(cfg, a, bar(3, 118, 119, 112, 113));
  assert.equal(a.position.sl, 110); // non scende
  B.onBar(cfg, a, bar(4, 113, 113, 105, 106));
  assert.equal(a.trades[0].reason, 'sl'); assert.equal(a.trades[0].exit, 110);
  assert.equal(a.trades[0].r, 1); // +10 punti su 10 di rischio iniziale
});

test('MFE/MAE e alert di prezzo', () => {
  const a = B.newAccount();
  B.placeOrder(cfg, a, { type: 'market', side: 'buy', qty: 1 }, bar(1, 100, 100, 100, 100));
  B.addAlert(a, 130, 100); B.addAlert(a, 80, 100);
  let ev = B.onBar(cfg, a, bar(2, 100, 112, 96, 105));
  assert.equal(ev.length, 0);
  ev = B.onBar(cfg, a, bar(3, 105, 131, 104, 130));
  assert.equal(ev.filter(e => e.type === 'alert').length, 1); assert.equal(a.alerts.length, 1);
  B.closePosition(cfg, a, bar(4, 120, 120, 120, 120));
  assert.equal(a.trades[0].mfe, 31); assert.equal(a.trades[0].mae, 4);
});

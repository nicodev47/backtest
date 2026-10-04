import assert from 'node:assert/strict';
import test from 'node:test';
import { computeMetrics, applyFilters, histogram } from '../public/js/metrics.js';

const T0 = 1789639800; // 18/09/2026 09:30 ET
const mk = (i, pnl, extra = {}) => ({ sid: 's1', key: 'NQ:' + i, symbol: 'NQ', side: 'long', qty: 1, pnl, r: pnl / 100, entryTime: T0 + i * 600, exitTime: T0 + i * 600 + 300, commission: 0, reason: pnl > 0 ? 'tp' : 'sl', mfe: 10, mae: 2, pv: 20, j: {}, ...extra });

test('metriche di base', () => {
  const tr = [mk(0, 200), mk(1, -100), mk(2, 300), mk(3, -100), mk(4, -100), mk(5, 0)];
  const m = computeMetrics(tr, { capital: 10000 });
  assert.equal(m.n, 6); assert.equal(m.wins, 2); assert.equal(m.losses, 3); assert.equal(m.be, 1);
  assert.equal(m.net, 200); assert.equal(m.winRate, 2 / 6);
  assert.equal(m.profitFactor, 500 / 300);
  assert.equal(m.avgWin, 250); assert.equal(m.avgLoss, 100); assert.equal(m.ratio, 2.5);
  assert.equal(m.expectancy, 200 / 6);
  assert.equal(m.maxConsecLosses, 2); assert.equal(m.maxConsecWins, 1);
  assert.equal(m.maxDD, 200); assert.equal(m.maxDDpct, 0.02);
  assert.equal(m.avgHold, 300);
  assert.equal(m.days.length, 1); assert.equal(m.dayWinRate, 1);
});

test('equity, raggruppamenti e filtri', () => {
  const tr = [
    mk(0, 100, { symbol: 'NQ', j: { tags: ['breakout'], setup: 'pb1' } }),
    mk(1, -50, { symbol: 'ES', side: 'short', j: { tags: ['breakout', 'news'], mistakes: ['fomo'], setup: 'pb1' } }),
    mk(2, 80, { symbol: 'NQ', exitTime: T0 + 86400 * 3 }),
  ];
  const m = computeMetrics(tr);
  assert.deepEqual(m.equity.map(p => p.v), [0, 100, 50, 130]);
  assert.equal(m.byTag.find(x => x.k === 'breakout').n, 2);
  assert.equal(m.byMistake[0].k, 'fomo'); assert.equal(m.byMistake[0].pnl, -50);
  assert.equal(m.bySymbol.length, 2); assert.equal(m.bySide.length, 2);
  assert.equal(m.bySetup.find(x => x.k === 'pb1').pnl, 50);
  assert.equal(m.days.length, 2);
  assert.equal(applyFilters(tr, { symbols: ['ES'] }).length, 1);
  assert.equal(applyFilters(tr, { tag: 'news' }).length, 1);
  assert.equal(applyFilters(tr, { setup: 'none' }).length, 1);
  assert.equal(applyFilters(tr, { from: '2026-09-19' }).length, 1);
});

test('punteggio e casi vuoti', () => {
  assert.equal(computeMetrics([]).score, null);
  const m = computeMetrics([mk(0, 300), mk(1, 300), mk(2, -100)], { capital: 50000 });
  assert.ok(m.score.total > 50 && m.score.total <= 100);
  assert.equal(m.score.parts.length, 6);
  assert.equal(histogram([1, 2, 3, 4], 2).reduce((a, b) => a + b.n, 0), 4);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { synthTicks } from './helpers/synth.mjs';

const root = path.join(import.meta.dirname, '..');
const loadRows = (file, from, to) => fs.readFileSync(path.join(root, 'data', file), 'utf8').trim().split('\n').slice(1).map(l => l.split(',').map(Number)).filter(r => r[0] >= from && r[0] < to);
const iso = (etSec, offsetH) => new Date((etSec + offsetH * 3600) * 1000).toISOString(); // ET come UTC -> istante UTC reale

function run(rows, offsetH, { name, extra = [], gz = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  fs.writeFileSync(path.join(dir, 'assets.json'), '[]');
  const ticks = synthTicks(rows);
  const head = 'ts_recv,ts_event,rtype,publisher_id,instrument_id,action,side,depth,price,size,flags,ts_in_delta,sequence,symbol';
  const body = ticks.map((x, i) => `${iso(x.t, offsetH)},${iso(x.t, offsetH)},0,1,42,T,B,0,${x.p.toFixed(2)},${x.v},0,0,${i},NQZ6`);
  const noise = ticks.slice(0, 50).map((x, i) => `${iso(x.t, offsetH)},${iso(x.t, offsetH)},0,1,43,T,B,0,${(x.p + 500).toFixed(2)},1,0,0,${i},NQH7`); // altro contratto, poco volume
  const spread = ticks.slice(0, 20).map((x, i) => `${iso(x.t, offsetH)},${iso(x.t, offsetH)},0,1,44,T,B,0,12.5,1,0,0,${i},NQZ6-NQH7`);
  let text = [head, ...[...body, ...noise, ...spread].sort((a, b) => a.localeCompare(b))].join('\n') + '\n';
  const file = path.join(dir, gz ? 'ticks.csv.gz' : 'ticks.csv');
  fs.writeFileSync(file, gz ? zlib.gzipSync(text) : text);
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/import-ticks.js'), '--sym=TST', `--name=${name}`, '--pv=20', ...extra, file], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  return { dir, r, ticks };
}

test('importa tick UTC (ora legale): minuti ricavati = minuti originali, contratto e spread filtrati', () => {
  const rows = loadRows('NQ_1m.csv', 1789639800, 1789639800 + 90 * 60); // 18/09/2026 09:30 ET (ora legale)
  const { dir, r, ticks } = run(rows, 4, { name: 'Test' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const csv = fs.readFileSync(path.join(dir, 'TST_1m.csv'), 'utf8').trim().split('\n').slice(1).map(l => l.split(',').map(Number));
  assert.equal(csv.length, rows.length);
  for (let i = 0; i < rows.length; i++) assert.deepEqual(csv[i], rows[i], 'minuto ' + i);
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'ticks/TST/index.json'), 'utf8'));
  assert.equal(idx.days.length, 1); assert.equal(idx.days[0].n, ticks.length);
  const assets = JSON.parse(fs.readFileSync(path.join(dir, 'assets.json'), 'utf8'));
  assert.equal(assets[0].symbol, 'TST');
  const bin = zlib.gunzipSync(fs.readFileSync(path.join(dir, `ticks/TST/${idx.days[0].d}.bin.gz`)));
  assert.equal(bin.length, ticks.length * 20);
});

test('importa tick UTC (ora solare) e file .gz', () => {
  // stesse candele spostate al 03/11/2026 09:30 ET (dopo il cambio all'ora solare: UTC-5)
  const shift = 1793698200 - 1789639800;
  const rows = loadRows('NQ_1m.csv', 1789639800, 1789639800 + 30 * 60).map(r => [r[0] + shift, ...r.slice(1)]);
  const { dir, r } = run(rows, 5, { name: 'Test', gz: true });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const csv = fs.readFileSync(path.join(dir, 'TST_1m.csv'), 'utf8').trim().split('\n').slice(1).map(l => l.split(',').map(Number));
  assert.deepEqual(csv, rows);
});

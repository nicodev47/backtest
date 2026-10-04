'use strict';
// Importa un nuovo asset: node scripts/import.js <file.csv|file.html> <SIMBOLO> "<Nome>" <valore_punto> [tick=0.25]
// - CSV: intestazione time,open,high,low,close,volume (time in secondi unix; ET trattato come UTC)
// - HTML: file "Replay ..." con `const D=[[t,o,h,l,c,v],...]`
// Scrive data/<SIMBOLO>_1m.csv e aggiunge/aggiorna la riga in data/assets.json.
const fs = require('fs');
const path = require('path');
const [file, sym, name, pv, tick = '0.25'] = process.argv.slice(2);
if (!file || !sym || !name || !pv) { console.error('Uso: node scripts/import.js <file> <SIMBOLO> "<Nome>" <valore_punto> [tick]'); process.exit(1); }
const raw = fs.readFileSync(file, 'utf8');
let rows;
if (/\.html?$/i.test(file)) {
  const i = raw.indexOf('const D='), j = raw.indexOf(']];', i);
  if (i < 0 || j < 0) { console.error('Nel file HTML non trovo "const D=[[...]]"'); process.exit(1); }
  rows = JSON.parse(raw.slice(i + 8, j + 2));
} else {
  rows = raw.trim().split(/\r?\n/).slice(1).map(l => l.split(',').map(Number));
}
rows = rows.filter(r => r.length >= 6 && r.every(Number.isFinite)).sort((a, b) => a[0] - b[0]);
const dir = path.join(__dirname, '..', 'data'), out = `${sym}_1m.csv`;
fs.writeFileSync(path.join(dir, out), 'time,open,high,low,close,volume\n' + rows.map(r => r.join(',')).join('\n') + '\n');
const ap = path.join(dir, 'assets.json'), assets = JSON.parse(fs.readFileSync(ap, 'utf8'));
const entry = { symbol: sym, name, dataFile: out, pointValue: Number(pv), tickSize: Number(tick), currency: 'USD', type: 'Futures' };
const k = assets.findIndex(a => a.symbol === sym);
if (k >= 0) assets[k] = entry; else assets.push(entry);
fs.writeFileSync(ap, JSON.stringify(assets, null, 2) + '\n');
const d = t => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
console.log(`Importato ${sym}: ${rows.length} candele, da ${d(rows[0][0])} a ${d(rows[rows.length - 1][0])}`);

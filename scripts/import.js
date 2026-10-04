'use strict';
// Importa un nuovo asset: node scripts/import.js <file.csv|file.html> <SIMBOLO> "<Nome>" <valore_punto> [tick=0.25] [reuse=<file.csv già in data/>]
// - CSV: intestazione con time o timestamp, open,high,low,close,volume (altre colonne ignorate).
//   `time` in secondi unix oppure `timestamp` "AAAA-MM-GG HH:MM:SS"; l'orario è ET e viene trattato come UTC.
// - reuse=...: registra un secondo simbolo (es. MNQ) sugli stessi dati senza riscriverli.
// - HTML: file "Replay ..." con `const D=[[t,o,h,l,c,v],...]`
// Scrive data/<SIMBOLO>_1m.csv e aggiunge/aggiorna la riga in data/assets.json.
const fs = require('fs');
const path = require('path');
const [file, sym, name, pv, tick = '0.25', reuseArg] = process.argv.slice(2);
if (!file || !sym || !name || !pv) { console.error('Uso: node scripts/import.js <file> <SIMBOLO> "<Nome>" <valore_punto> [tick]'); process.exit(1); }
const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
let out = `${sym}_1m.csv`, rows = [];
if (reuseArg && reuseArg.startsWith('reuse=')) {
  out = reuseArg.slice(6);
  const lines = fs.readFileSync(path.join(dir, out), 'utf8').trim().split('\n').slice(1);
  rows = lines.map(l => l.split(',').map(Number));
} else {
  const raw = fs.readFileSync(file, 'utf8');
  if (/\.html?$/i.test(file)) {
    const i = raw.indexOf('const D='), j = raw.indexOf(']];', i);
    if (i < 0 || j < 0) { console.error('Nel file HTML non trovo "const D=[[...]]"'); process.exit(1); }
    rows = JSON.parse(raw.slice(i + 8, j + 2));
  } else {
    const [head, ...lines] = raw.trim().split(/\r?\n/), cols = head.split(',').map(c => c.trim().toLowerCase());
    const ix = n => cols.indexOf(n), tcol = ix('time') >= 0 ? ix('time') : ix('timestamp');
    const need = ['open', 'high', 'low', 'close', 'volume'].map(ix);
    if (tcol < 0 || need.some(k => k < 0)) { console.error('Intestazione non riconosciuta: servono time/timestamp,open,high,low,close,volume'); process.exit(1); }
    rows = lines.filter(Boolean).map(l => {
      const p = l.split(','), t = p[tcol];
      const ts = /^\d+$/.test(t) ? Number(t) : Date.parse(t.replace(' ', 'T') + (t.length <= 10 ? 'T00:00:00' : '') + 'Z') / 1000;
      return [ts, ...need.map(k => Number(p[k]))];
    });
  }
  rows = rows.filter(r => r.length >= 6 && r.every(Number.isFinite)).sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(path.join(dir, out), 'time,open,high,low,close,volume\n' + rows.map(r => r.join(',')).join('\n') + '\n');
}
const ap = path.join(dir, 'assets.json'), assets = JSON.parse(fs.readFileSync(ap, 'utf8'));
const entry = { symbol: sym, name, dataFile: out, pointValue: Number(pv), tickSize: Number(tick), currency: 'USD', type: 'Futures' };
if (reuseArg && reuseArg.startsWith('reuse=')) { // stessi dati di un altro simbolo: condivide anche i tick
  const base = assets.find(a => a.dataFile === out && a.symbol !== sym);
  if (base) entry.tickDir = base.tickDir || base.symbol;
}
const k = assets.findIndex(a => a.symbol === sym);
if (k >= 0) assets[k] = entry; else assets.unshift(entry); // i nuovi asset compaiono per primi
fs.writeFileSync(ap, JSON.stringify(assets, null, 2) + '\n');
const d = t => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
console.log(`Importato ${sym}: ${rows.length} candele, da ${d(rows[0][0])} a ${d(rows[rows.length - 1][0])}`);

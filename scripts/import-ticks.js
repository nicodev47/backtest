'use strict';
// Importa i tick (un record per scambio) e crea tutto ciò che serve al replay:
//  - data/ticks/<SIMBOLO>/<giorno>.bin.gz + index.json  (tick per giorno, formato binario compatto)
//  - data/<SIMBOLO>_1m.csv  (candele a 1 minuto ricavate dai tick: i minuti coincidono con i tick)
//  - la riga in data/assets.json
//
// Uso:
//   node scripts/import-ticks.js --sym=NQ26 --name="E-mini Nasdaq-100" --pv=20 [--tick=0.25] [--tz=auto|ET|UTC]
//                                [--contract=auto|NQZ6] file1.csv[.gz] [file2.csv.gz ...]   (file in ordine cronologico)
//
// Colonne riconosciute (maiuscole/minuscole indifferenti): orario = ts_event | timestamp | time | datetime;
// prezzo = price | px | last; quantità = size | volume | qty | quantity; opzionali: symbol, action (si tiene solo 'T').
// Orario: ISO con Z/offset o numeri epoch (s/ms/µs/ns) sono istanti UTC e vengono convertiti in ET (con ora legale);
// senza fuso (es. "2026-09-17 09:30:00.123") si assume già ET, salvo --tz=UTC.
// Con più contratti nello stesso file (rollover) --contract=auto sceglie per ogni giorno il più scambiato; gli spread
// (simboli con '-') vengono ignorati. DATA_DIR cambia la cartella dati.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const args = process.argv.slice(2), opt = {}, files = [];
for (const a of args) { const m = /^--([\w-]+)=(.*)$/.exec(a); if (m) opt[m[1]] = m[2]; else files.push(a); }
const SYM = opt.sym, NAME = opt.name, PV = Number(opt.pv), TICK = Number(opt.tick || 0.25), TZ = (opt.tz || 'auto').toUpperCase(), CONTRACT = opt.contract || 'auto';
if (!SYM || !NAME || !(PV > 0) || !files.length) {
  console.error('Uso: node scripts/import-ticks.js --sym=NQ26 --name="Nome" --pv=20 [--tick=0.25] [--tz=auto|ET|UTC] [--contract=auto|NOME] file.csv[.gz] ...');
  process.exit(1);
}
const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const OUT = path.join(DATA, 'ticks', SYM);

// ---- orari ----
const fmtET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
const offCache = new Map();
function etOffset(utcSec) { // secondi da sommare a un istante UTC per ottenere l'orario ET "come UTC"
  const h = Math.floor(utcSec / 3600);
  let o = offCache.get(h);
  if (o === undefined) {
    const p = Object.fromEntries(fmtET.formatToParts(new Date(h * 3600000)).map(x => [x.type, x.value]));
    o = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000 - h * 3600;
    offCache.set(h, o);
  }
  return o;
}
const ISO = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/;
function parseTs(s) { // -> secondi ET-come-UTC (con frazione) oppure NaN
  if (/^\d+(\.\d+)?$/.test(s)) {
    let x = Number(s);
    const digits = s.split('.')[0].length;
    x = digits >= 19 ? x / 1e9 : digits >= 16 ? x / 1e6 : digits >= 13 ? x / 1e3 : x;
    return x + etOffset(x);
  }
  const m = ISO.exec(s);
  if (!m) return NaN;
  let base = Date.parse(m[1] + 'T' + m[2] + 'Z') / 1000 + (m[3] ? Number('0' + m[3]) : 0);
  const z = m[4];
  if (z && z !== 'Z') { const sign = z[0] === '-' ? -1 : 1, hh = +z.slice(1, 3), mm = +z.slice(-2); base -= sign * (hh * 3600 + mm * 60); }
  const isUtc = z ? true : TZ === 'UTC';
  return isUtc ? base + etOffset(base) : base;
}

// ---- lettura righe ----
function lines(file) {
  let input = fs.createReadStream(file);
  if (/\.gz$/i.test(file)) input = input.pipe(zlib.createGunzip());
  else if (/\.zst$/i.test(file)) {
    if (!zlib.createZstdDecompress) { console.error('Questa versione di Node non legge .zst: decomprimi con `zstd -d` o scarica il CSV non compresso.'); process.exit(1); }
    input = input.pipe(zlib.createZstdDecompress());
  }
  return readline.createInterface({ input, crlfDelay: Infinity });
}
function header(h) {
  const cols = h.split(',').map(c => c.trim().toLowerCase()), find = names => names.map(n => cols.indexOf(n)).find(i => i >= 0) ?? -1;
  const c = { ts: find(['ts_event', 'timestamp', 'time', 'datetime']), px: find(['price', 'px', 'last']), sz: find(['size', 'volume', 'qty', 'quantity']), sym: find(['symbol']), act: find(['action']) };
  if (c.ts < 0 || c.px < 0 || c.sz < 0) { console.error('Intestazione non riconosciuta (servono orario, price, size). Colonne trovate: ' + cols.join(', ')); process.exit(1); }
  return c;
}
const price = x => { const v = Number(x); return v > 1e6 ? v / 1e9 : v; }; // alcuni export hanno i prezzi in virgola fissa (1e-9)
const dayOf = t => Math.floor(t / 86400);

async function pass(fn) { // scorre tutti i file chiamando fn(day, t, p, size, symbol)
  for (const f of files) {
    let c = null, n = 0;
    for await (const line of lines(f)) {
      if (!line) continue;
      if (!c) { c = header(line); continue; }
      const p = line.split(',');
      if (c.act >= 0 && p[c.act] !== 'T') continue;
      const t = parseTs(p[c.ts].trim());
      if (Number.isNaN(t)) { if (n++ === 0) console.warn(`Orario non riconosciuto in ${path.basename(f)}: "${p[c.ts]}" (righe saltate)`); continue; }
      fn(dayOf(t), t, price(p[c.px]), Number(p[c.sz]), c.sym >= 0 ? p[c.sym].trim() : '');
    }
  }
}

(async () => {
  // 1) contratto da usare per ogni giorno
  let pick = null; // Map giorno -> simbolo
  const hasSymbol = await new Promise(res => { const rl = lines(files[0]); rl.once('line', l => { rl.close(); res(header(l).sym >= 0); }); });
  if (hasSymbol && CONTRACT === 'auto') {
    const vol = new Map();
    await pass((d, t, p, sz, sym) => { if (!sym || sym.includes('-')) return; const k = d + '|' + sym; vol.set(k, (vol.get(k) || 0) + sz); });
    pick = new Map();
    const best = new Map();
    for (const [k, v] of vol) { const [d, sym] = k.split('|'); if (!best.has(d) || v > best.get(d)[1]) best.set(d, [sym, v]); }
    for (const [d, [sym]] of best) pick.set(Number(d), sym);
    const used = [...new Set(pick.values())];
    console.log('Contratti scelti (il più scambiato di ogni giorno): ' + used.join(', '));
  }
  // 2) scrittura per giorno + candele a 1 minuto
  fs.mkdirSync(OUT, { recursive: true });
  const index = [], bars = [];
  let cur = null, curDay = null, total = 0, unordered = 0;
  const flush = () => {
    if (!cur || !cur.t.length) return;
    const n = cur.t.length;
    let ord = null;
    for (let i = 1; i < n; i++) if (cur.t[i] < cur.t[i - 1]) { ord = Array.from({ length: n }, (_, k) => k).sort((a, b) => cur.t[a] - cur.t[b] || a - b); unordered++; break; }
    const t = new Float64Array(n), p = new Float64Array(n), v = new Float32Array(n);
    for (let i = 0; i < n; i++) { const j = ord ? ord[i] : i; t[i] = cur.t[j]; p[i] = cur.p[j]; v[i] = cur.v[j]; }
    fs.writeFileSync(path.join(OUT, curDay + '.bin.gz'), zlib.gzipSync(Buffer.concat([Buffer.from(t.buffer), Buffer.from(p.buffer), Buffer.from(v.buffer)]), { level: 6 }));
    index.push({ d: curDay, n, first: t[0], last: t[n - 1] });
    // minuti
    let mk = null, b = null;
    for (let i = 0; i < n; i++) {
      const m = Math.floor(t[i] / 60) * 60;
      if (m !== mk) { if (b) bars.push(b); mk = m; b = [m, p[i], p[i], p[i], p[i], 0]; }
      if (p[i] > b[2]) b[2] = p[i];
      if (p[i] < b[3]) b[3] = p[i];
      b[4] = p[i]; b[5] += v[i];
    }
    if (b) bars.push(b);
    total += n; process.stdout.write(`\r${index.length} giorni, ${total.toLocaleString('it-IT')} tick`);
  };
  const seen = new Set();
  await pass((d, t, p, sz, sym) => {
    if (pick && pick.get(d) !== sym) return;
    if (!pick && hasSymbol && CONTRACT !== 'auto' && sym !== CONTRACT) return;
    if (d !== curDay) {
      flush();
      if (seen.has(d)) { console.error(`\nI file non sono in ordine cronologico (giorno ripetuto): passali ordinati.`); process.exit(1); }
      seen.add(d); curDay = d; cur = { t: [], p: [], v: [] };
    }
    cur.t.push(t); cur.p.push(p); cur.v.push(sz);
  });
  flush();
  if (!index.length) { console.error('\nNessun tick importato: controlla --contract e il formato.'); process.exit(1); }
  index.sort((a, b) => a.d - b.d);
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ sym: SYM, days: index }));
  bars.sort((a, b) => a[0] - b[0]);
  const fmt = x => String(x);
  fs.writeFileSync(path.join(DATA, `${SYM}_1m.csv`), 'time,open,high,low,close,volume\n' + bars.map(r => r.map(fmt).join(',')).join('\n') + '\n');
  const ap = path.join(DATA, 'assets.json'), assets = JSON.parse(fs.readFileSync(ap, 'utf8'));
  const entry = { symbol: SYM, name: NAME, dataFile: `${SYM}_1m.csv`, pointValue: PV, tickSize: TICK, currency: 'USD', type: 'Futures' };
  const k = assets.findIndex(a => a.symbol === SYM);
  if (k >= 0) assets[k] = { ...assets[k], ...entry }; else assets.unshift(entry);
  fs.writeFileSync(ap, JSON.stringify(assets, null, 2) + '\n');
  const d = t => new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' ');
  console.log(`\nImportato ${SYM}: ${total.toLocaleString('it-IT')} tick in ${index.length} giorni, ${bars.length} candele a 1 minuto (${d(bars[0][0])} → ${d(bars.at(-1)[0])} ET)`);
  if (unordered) console.log(`Nota: ${unordered} giorni avevano tick non ordinati e sono stati riordinati.`);
})();

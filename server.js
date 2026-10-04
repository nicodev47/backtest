'use strict';
// Server del software di backtest: serve il frontend, i dati storici a 1 minuto
// e salva le sessioni di backtest su disco (un file JSON per sessione).
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESS_DIR = path.join(DATA_DIR, 'sessions');
fs.mkdirSync(SESS_DIR, { recursive: true });

// ---------- Dati storici ----------
const assets = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'assets.json'), 'utf8'));
const fileCache = new Map(); // dataFile -> { json (gzip), from, to, count }

function loadFile(name) {
  if (fileCache.has(name)) return fileCache.get(name);
  const lines = fs.readFileSync(path.join(DATA_DIR, name), 'utf8').split('\n');
  const t = [], o = [], h = [], l = [], c = [], v = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const p = lines[i].split(',');
    t.push(+p[0]); o.push(+p[1]); h.push(+p[2]); l.push(+p[3]); c.push(+p[4]); v.push(+p[5]);
  }
  const entry = {
    gz: zlib.gzipSync(JSON.stringify({ t, o, h, l, c, v })),
    from: t[0], to: t[t.length - 1], count: t.length,
  };
  fileCache.set(name, entry);
  return entry;
}

const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/api/assets', (req, res) => {
  res.json(assets.map(a => {
    const f = loadFile(a.dataFile);
    return { ...a, from: f.from, to: f.to, bars: f.count };
  }));
});

// Candele a 1 minuto in formato "a colonne" (compatto). Orari: ET trattato come UTC.
app.get('/api/candles/:symbol', (req, res) => {
  const a = assets.find(x => x.symbol === req.params.symbol);
  if (!a) return res.status(404).json({ error: 'Asset sconosciuto' });
  res.set({ 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'public, max-age=3600' });
  res.send(loadFile(a.dataFile).gz);
});

// ---------- Sessioni ----------
const sessPath = id => path.join(SESS_DIR, id + '.json');
const validId = id => /^[a-f0-9]{16}$/.test(id);

function readSession(id) {
  try { return JSON.parse(fs.readFileSync(sessPath(id), 'utf8')); } catch { return null; }
}
function writeSession(s) {
  const tmp = sessPath(s.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, sessPath(s.id));
}
const summary = s => ({
  id: s.id, name: s.name, symbol: s.symbol, startTime: s.startTime, cursorTime: s.cursorTime,
  capital: s.capital, createdAt: s.createdAt, updatedAt: s.updatedAt, summary: s.summary || null,
});

app.get('/api/sessions', (req, res) => {
  const out = [];
  for (const f of fs.readdirSync(SESS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const s = readSession(f.slice(0, -5));
    if (s) out.push(summary(s));
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  res.json(out);
});

app.post('/api/sessions', (req, res) => {
  const b = req.body || {};
  const asset = assets.find(a => a.symbol === b.symbol);
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Il nome della sessione è obbligatorio' });
  if (!asset) return res.status(400).json({ error: 'Asset non valido' });
  const f = loadFile(asset.dataFile);
  const startTime = Number(b.startTime);
  if (!Number.isFinite(startTime) || startTime < f.from || startTime > f.to) {
    return res.status(400).json({ error: 'Data di partenza fuori dall\'intervallo dei dati disponibili' });
  }
  const capital = Number(b.capital);
  if (!(capital >= 100)) return res.status(400).json({ error: 'Capitale iniziale non valido' });
  const now = Date.now();
  const s = {
    id: crypto.randomBytes(8).toString('hex'),
    name, symbol: asset.symbol, startTime, cursorTime: null, capital,
    commission: Math.max(0, Number(b.commission) || 0),
    timeframe: b.timeframe || '5',
    createdAt: now, updatedAt: now,
    account: { trades: [], position: null, orders: [], nextId: 1 },
    drawings: [], indicators: [], settings: {}, summary: null,
  };
  writeSession(s);
  res.status(201).json(s);
});

app.get('/api/sessions/:id', (req, res) => {
  const s = validId(req.params.id) && readSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'Sessione non trovata' });
  res.json(s);
});

// Il client invia lo stato di lavoro (cursore, conto, disegni...). Campi di identità immutabili.
const saveSession = (req, res) => {
  const s = validId(req.params.id) && readSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'Sessione non trovata' });
  const b = req.body || {};
  for (const k of ['cursorTime', 'timeframe', 'account', 'drawings', 'indicators', 'settings', 'summary']) {
    if (b[k] !== undefined) s[k] = b[k];
  }
  if (typeof b.name === 'string' && b.name.trim()) s.name = b.name.trim();
  s.updatedAt = Date.now();
  writeSession(s);
  res.json({ ok: true, updatedAt: s.updatedAt });
};
app.put('/api/sessions/:id', saveSession);
app.post('/api/sessions/:id/save', saveSession); // per navigator.sendBeacon alla chiusura della pagina

app.delete('/api/sessions/:id', (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: 'Sessione non trovata' });
  try { fs.unlinkSync(sessPath(req.params.id)); } catch { return res.status(404).json({ error: 'Sessione non trovata' }); }
  res.json({ ok: true });
});

// ---------- Frontend ----------
app.use('/vendor/lightweight-charts.js',
  (req, res) => res.sendFile(path.join(__dirname, 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js')));
app.use('/js/broker.js', express.static(path.join(__dirname, 'public/js/broker.js')));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/session/:id', (req, res) => res.sendFile(path.join(__dirname, 'public/session.html')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Backtest in ascolto su http://localhost:${PORT}`));
}
module.exports = app;

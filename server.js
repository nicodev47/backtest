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

// Tick opzionali: data/ticks/<tickDir|simbolo>/index.json + un file <giorno>.bin.gz per giorno
const tickDirOf = a => path.join(DATA_DIR, 'ticks', a.tickDir || a.symbol);
const hasTicks = a => fs.existsSync(path.join(tickDirOf(a), 'index.json'));

app.get('/api/assets', (req, res) => {
  res.json(assets.map(a => {
    const f = loadFile(a.dataFile);
    return { ...a, from: f.from, to: f.to, bars: f.count, ticks: hasTicks(a) };
  }));
});

app.get('/api/ticks/:symbol', (req, res) => {
  const a = assets.find(x => x.symbol === req.params.symbol);
  if (!a || !hasTicks(a)) return res.status(404).json({ error: 'Nessun tick per questo asset' });
  res.set('Cache-Control', 'no-cache');
  res.type('json').send(fs.readFileSync(path.join(tickDirOf(a), 'index.json')));
});

app.get('/api/ticks/:symbol/:d', (req, res) => {
  const a = assets.find(x => x.symbol === req.params.symbol);
  if (!a || !/^\d+$/.test(req.params.d)) return res.status(404).json({ error: 'Non trovato' });
  const file = path.join(tickDirOf(a), req.params.d + '.bin.gz');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Giorno non disponibile' });
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', 'Cache-Control': 'public, max-age=86400' });
  fs.createReadStream(file).pipe(res);
});

// Candele a 1 minuto in formato "a colonne" (compatto). Orari: ET trattato come UTC.
app.get('/api/candles/:symbol', (req, res) => {
  const a = assets.find(x => x.symbol === req.params.symbol);
  if (!a) return res.status(404).json({ error: 'Asset sconosciuto' });
  res.set({ 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'public, max-age=3600' });
  res.send(loadFile(a.dataFile).gz);
});

const BOOT_ID = String(Date.now());
app.get('/api/version', (req, res) => res.json({ id: BOOT_ID, live: process.env.LIVE === '1' }));

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
// Una sessione è "obsoleta" se i suoi asset non esistono più o la partenza cade fuori dai dati disponibili.
function isStale(s) {
  const syms = s.symbols || [s.symbol];
  return syms.some(sym => {
    const a = assets.find(x => x.symbol === sym);
    if (!a) return true;
    const f = loadFile(a.dataFile);
    return s.startTime < f.from || s.startTime > f.to;
  });
}
const summary = s => ({
  stale: isStale(s),
  id: s.id, name: s.name, symbol: s.symbol, symbols: s.symbols || [s.symbol], startTime: s.startTime, cursorTime: s.cursorTime,
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
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Il nome della sessione è obbligatorio' });
  const symbols = [...new Set((Array.isArray(b.symbols) ? b.symbols : [b.symbol]).filter(Boolean))].slice(0, 4);
  const list = symbols.map(sym => assets.find(a => a.symbol === sym));
  if (!symbols.length || list.some(a => !a)) return res.status(400).json({ error: 'Asset non valido' });
  const files = list.map(a => loadFile(a.dataFile));
  const from = Math.max(...files.map(f => f.from)), to = Math.min(...files.map(f => f.to));
  const startTime = Number(b.startTime);
  if (!Number.isFinite(startTime) || startTime < from || startTime > to) {
    return res.status(400).json({ error: 'Data di partenza fuori dall\'intervallo dei dati disponibili per gli asset scelti' });
  }
  const capital = Number(b.capital);
  if (!(capital >= 100)) return res.status(400).json({ error: 'Capitale iniziale non valido' });
  const tf = b.timeframe || '1';
  const type = symbols.length === 1 ? '1' : symbols.length === 2 ? '2h' : '4';
  const now = Date.now();
  const s = {
    id: crypto.randomBytes(8).toString('hex'), schema: 2,
    name, symbol: symbols[0], symbols, startTime, cursorTime: null, capital,
    commission: Math.max(0, Number(b.commission) || 0), slippage: Math.max(0, Math.min(20, Math.floor(Number(b.slippage) || 0))),
    createdAt: now, updatedAt: now,
    layout: { type, panes: symbols.map((sym, k) => ({ id: 'p' + (k + 1), symbol: sym, tf, drawings: [] })) },
    accounts: {}, journal: { notes: '', tradeNotes: {} }, rules: { enabled: false }, settings: {}, summary: null,
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
  for (const k of ['cursorTime', 'schema', 'layout', 'accounts', 'journal', 'rules', 'runtime', 'settings', 'summary']) {
    if (b[k] !== undefined) s[k] = b[k];
  }
  if (typeof b.name === 'string' && b.name.trim()) s.name = b.name.trim();
  s.updatedAt = Date.now();
  writeSession(s);
  res.json({ ok: true, updatedAt: s.updatedAt });
};
app.put('/api/sessions/:id', saveSession);
app.post('/api/sessions/:id/save', saveSession); // per navigator.sendBeacon alla chiusura della pagina

// Riavvia la sessione dall'inizio (azzera conti, journal e disegni); i dati e le impostazioni restano.
app.post('/api/sessions/:id/reset', (req, res) => {
  const s = validId(req.params.id) && readSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'Sessione non trovata' });
  s.cursorTime = null; s.accounts = {}; delete s.account; s.runtime = {}; s.summary = null;
  s.journal = { notes: '', trades: {}, pos: {}, tradeNotes: {} };
  if (s.layout) s.layout.panes.forEach(p => { p.drawings = []; });
  s.updatedAt = Date.now();
  fs.rmSync(path.join(DATA_DIR, 'shots', s.id), { recursive: true, force: true });
  writeSession(s);
  res.json({ ok: true });
});

// Nuova sessione con le stesse impostazioni (asset, partenza, capitale, costi), senza operazioni.
app.post('/api/sessions/:id/duplicate', (req, res) => {
  const s = validId(req.params.id) && readSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'Sessione non trovata' });
  if (isStale(s)) return res.status(409).json({ error: 'I dati di questa sessione non sono più disponibili' });
  const now = Date.now(), c = JSON.parse(JSON.stringify(s));
  c.id = crypto.randomBytes(8).toString('hex'); c.name = (s.name + ' (copia)').slice(0, 80);
  c.cursorTime = null; c.accounts = {}; delete c.account; c.runtime = {}; c.summary = null; c.createdAt = c.updatedAt = now;
  c.journal = { notes: '', trades: {}, pos: {}, tradeNotes: {} };
  if (c.layout) c.layout.panes.forEach(p => { p.drawings = []; });
  writeSession(c);
  res.status(201).json(summary(c));
});

app.delete('/api/sessions/:id', (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: 'Sessione non trovata' });
  try { fs.unlinkSync(sessPath(req.params.id)); } catch { return res.status(404).json({ error: 'Sessione non trovata' }); }
  fs.rmSync(path.join(DATA_DIR, 'shots', req.params.id), { recursive: true, force: true });
  res.json({ ok: true });
});

// ---------- Screenshot dei trade ----------
const SHOT_DIR = path.join(DATA_DIR, 'shots');
app.post('/api/sessions/:id/shots', express.raw({ type: ['image/jpeg', 'image/png', 'application/octet-stream'], limit: '3mb' }), (req, res) => {
  const id = req.params.id, name = String(req.query.name || '');
  if (!validId(id) || !readSession(id)) return res.status(404).json({ error: 'Sessione non trovata' });
  if (!/^[\w-]{1,80}$/.test(name) || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Richiesta non valida' });
  fs.mkdirSync(path.join(SHOT_DIR, id), { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, id, name + '.jpg'), req.body);
  res.json({ url: `/api/shots/${id}/${name}.jpg` });
});
app.get('/api/shots/:id/:file', (req, res) => {
  if (!validId(req.params.id) || !/^[\w-]{1,80}\.jpg$/.test(req.params.file)) return res.status(404).end();
  const f = path.join(SHOT_DIR, req.params.id, req.params.file);
  if (!fs.existsSync(f)) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400').type('jpeg').sendFile(f);
});

// ---------- Playbook (strategie con regole) ----------
const PB_FILE = path.join(DATA_DIR, 'playbooks.json');
const cleanList = a => (Array.isArray(a) ? a : []).map(x => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 30);
app.get('/api/playbooks', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(PB_FILE, 'utf8'))); } catch { res.json([]); }
});
app.put('/api/playbooks', (req, res) => {
  const list = (Array.isArray(req.body) ? req.body : []).slice(0, 100).map(p => ({
    id: /^[\w-]{1,40}$/.test(p.id) ? p.id : crypto.randomBytes(5).toString('hex'),
    name: String(p.name || '').trim().slice(0, 80) || 'Senza nome',
    description: String(p.description || '').slice(0, 2000),
    rules: { entry: cleanList(p.rules && p.rules.entry), exit: cleanList(p.rules && p.rules.exit), risk: cleanList(p.rules && p.rules.risk) },
  }));
  fs.writeFileSync(PB_FILE, JSON.stringify(list, null, 2));
  res.json(list);
});

// ---------- Tutti i trade (per le analisi) ----------
app.get('/api/trades', (req, res) => {
  const out = [], sessions = [];
  for (const f of fs.readdirSync(SESS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const s = readSession(f.slice(0, -5));
    if (!s) continue;
    sessions.push({ id: s.id, name: s.name, capital: s.capital, symbols: s.symbols || [s.symbol], startTime: s.startTime, updatedAt: s.updatedAt });
    const accounts = s.accounts || (s.account ? { [s.symbol]: s.account } : {});
    const jt = (s.journal && s.journal.trades) || {};
    for (const [sym, acc] of Object.entries(accounts)) {
      const asset = assets.find(a => a.symbol === sym);
      for (const t of (acc && acc.trades) || []) {
        const key = `${sym}:${t.id}`;
        out.push({ sid: s.id, sname: s.name, key, symbol: sym, pv: asset ? asset.pointValue : 1, capital: s.capital, ...t, j: jt[key] || {} });
      }
    }
  }
  out.sort((a, b) => a.exitTime - b.exitTime);
  res.json({ trades: out, sessions });
});

// ---------- Frontend ----------
app.use('/vendor/lightweight-charts.js',
  (req, res) => res.sendFile(path.join(__dirname, 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js')));
app.use('/js/broker.js', express.static(path.join(__dirname, 'public/js/broker.js')));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/analytics', (req, res) => res.sendFile(path.join(__dirname, 'public/analytics.html')));
app.get('/playbooks', (req, res) => res.sendFile(path.join(__dirname, 'public/playbooks.html')));
app.get('/session/:id', (req, res) => res.sendFile(path.join(__dirname, 'public/session.html')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Backtest in ascolto su http://localhost:${PORT}`));
}
module.exports = app;

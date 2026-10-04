// Aggregazione delle candele a 1 minuto nei timeframe superiori.
export const TFS = [
  { id: '1', label: '1m', sec: 60 }, { id: '3', label: '3m', sec: 180 }, { id: '5', label: '5m', sec: 300 },
  { id: '15', label: '15m', sec: 900 }, { id: '30', label: '30m', sec: 1800 }, { id: '60', label: '1h', sec: 3600 },
  { id: '240', label: '4h', sec: 14400 }, { id: 'D', label: '1D', sec: 86400 },
];
export const tfSec = id => TFS.find(t => t.id === id).sec;
const SESSION_OFFSET = 6 * 3600; // la sessione dei futures CME apre alle 18:00 ET: 4h e 1D si ancorano lì
export function bucketOf(t, tf) {
  const s = tfSec(tf);
  if (tf === '240' || tf === 'D') return Math.floor((t + SESSION_OFFSET) / s) * s - SESSION_OFFSET;
  return t - (t % s);
}
// Chiave di sessione giornaliera (per VWAP)
export const sessionKey = t => Math.floor((t + SESSION_OFFSET) / 86400);

export async function loadCandles(symbol) {
  const r = await fetch('/api/candles/' + symbol);
  if (!r.ok) throw new Error('Impossibile caricare i dati');
  return r.json(); // { t:[], o:[], h:[], l:[], c:[], v:[] }
}
export const firstIndexAtOrAfter = (t, time) => {
  let lo = 0, hi = t.length;
  while (lo < hi) { const m = (lo + hi) >> 1; t[m] < time ? lo = m + 1 : hi = m; }
  return lo;
};

// Costruisce le barre aggregate dall'indice 0 a `upto` compreso.
export function buildBars(D, upto, tf) {
  const bars = [];
  let b = null;
  for (let k = 0; k <= upto; k++) {
    const t = bucketOf(D.t[k], tf);
    if (b && b.time === t) { addTo(b, D, k); }
    else { b = newBar(t, D, k); bars.push(b); }
  }
  return bars;
}
export function newBar(time, D, k) { return { time, open: D.o[k], high: D.h[k], low: D.l[k], close: D.c[k], volume: D.v[k] }; }
export function addTo(b, D, k) {
  if (D.h[k] > b.high) b.high = D.h[k];
  if (D.l[k] < b.low) b.low = D.l[k];
  b.close = D.c[k]; b.volume += D.v[k];
}

// ---- Tick (opzionali): file binari per giorno, serviti da /api/ticks ----
export async function loadTickIndex(symbol) {
  const r = await fetch('/api/ticks/' + symbol);
  return r.ok ? r.json() : null;
}
// Formato: n doppi (tempo), n doppi (prezzo), n float32 (dimensione). Tempo in secondi con frazione (ET come UTC).
export async function loadTickDay(symbol, d) {
  const r = await fetch(`/api/ticks/${symbol}/${d}`);
  if (!r.ok) throw new Error('Tick non disponibili per il giorno ' + d);
  const buf = await r.arrayBuffer(), n = buf.byteLength / 20;
  return { n, t: new Float64Array(buf, 0, n), p: new Float64Array(buf, n * 8, n), v: new Float32Array(buf, n * 16, n) };
}

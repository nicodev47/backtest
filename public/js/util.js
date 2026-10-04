export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const fmt = (n, d = 2) => n == null || !isFinite(n) ? '–' : n.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });
export const money = n => n == null || !isFinite(n) ? '–' : n.toLocaleString('it-IT', { style: 'currency', currency: 'USD' });
export const pad = n => String(n).padStart(2, '0');
// Gli orari dei dati sono ET trattati come UTC: si formattano sempre con i getter UTC.
export function fmtDT(t, sec = false) {
  if (t == null) return '–';
  const d = new Date(t * 1000);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${sec ? ':' + pad(d.getUTCSeconds()) : ''}`;
}
export function fmtDate(t) { const d = new Date(t * 1000); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; }
export function toInputValue(t) { // timestamp -> value di <input type=datetime-local>
  const d = new Date(t * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export function fromInputValue(v) { return Math.floor(Date.parse(v + ':00Z') / 1000); }
export async function api(path, opts = {}) {
  const r = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
export const debounce = (fn, ms) => { let h; const f = (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; f.flush = () => { clearTimeout(h); fn(); }; return f; };
export const uid = () => Math.random().toString(36).slice(2, 10);

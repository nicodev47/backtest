// Tick SINTETICI per i test: ricostruiscono, da candele a 1 minuto, una sequenza di scambi coerente
// (primo = open, ultimo = close, massimo = high, minimo = low, somma dimensioni = volume).
export function synthTicks(rows) { // rows: [t,o,h,l,c,v] -> [{t,p,v}]
  const out = []; let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (const [M, o, h, l, c, v] of rows) {
    const n = Math.max(4, Math.min(40, Math.floor(v / 2))), kp = c >= o ? [o, l, h, c] : [o, h, l, c];
    const px = []; 
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1) * 3, seg = Math.min(2, Math.floor(x)), f = x - seg;
      let p = kp[seg] + (kp[seg + 1] - kp[seg]) * f + (i % 3 === 1 ? (rnd() - 0.5) : 0);
      p = Math.min(h, Math.max(l, Math.round(p * 4) / 4));
      px.push(p);
    }
    px[0] = o; px[n - 1] = c;
    px[Math.round((n - 1) / 3)] = kp[1]; px[Math.round((n - 1) * 2 / 3)] = kp[2];
    if (n < 5) { px[0] = o; px[n - 1] = c; }
    const ts = Array.from({ length: n }, () => Math.round(rnd() * 59990) / 1000).sort((a, b) => a - b);
    const base = Math.floor(v / n); let rest = v - base * n;
    for (let i = 0; i < n; i++) { const s = base + (rest-- > 0 ? 1 : 0); out.push({ t: M + ts[i], p: px[i], v: s }); }
  }
  return out;
}
export const toDayArrays = ticks => {
  const n = ticks.length, t = new Float64Array(n), p = new Float64Array(n), v = new Float32Array(n);
  ticks.forEach((x, i) => { t[i] = x.t; p[i] = x.p; v[i] = x.v; });
  return { n, t, p, v };
};

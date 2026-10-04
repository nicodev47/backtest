import { $, api, fmtDT, fromInputValue, toInputValue, money, fmt } from './util.js';
import { initTheme } from './theme.js';
initTheme($('#themeBtn'));

let assets = [];
const sel = $('#symbol'), start = $('#start'), err = $('#err');

function updateRange() {
  const a = assets.find(x => x.symbol === sel.value);
  if (!a) return;
  start.min = toInputValue(a.from); start.max = toInputValue(a.to);
  $('#range').textContent = `Dati disponibili: ${fmtDT(a.from)} → ${fmtDT(a.to)} ET (${a.bars.toLocaleString('it-IT')} candele a 1 minuto)`;
  const cur = start.value && fromInputValue(start.value);
  if (!cur || cur < a.from || cur > a.to) {
    // default: prima apertura regolare (09:30 ET) dopo l'inizio dei dati
    const d = new Date(a.from * 1000); d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(9, 30, 0, 0);
    start.value = toInputValue(Math.floor(d / 1000));
  }
}

async function loadSessions() {
  const list = await api('/sessions');
  const box = $('#sessions');
  if (!list.length) { box.innerHTML = '<p class="muted">Nessuna sessione. Creane una a sinistra per iniziare.</p>'; return; }
  box.innerHTML = '';
  for (const s of list) {
    const sm = s.summary || {};
    const pnl = sm.total ?? 0;
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `
      <div class="card-top"><b></b><span class="tag"></span></div>
      <div class="muted small cur"></div>
      <div class="kpis">
        <div><span>P&amp;L</span><b class="${pnl >= 0 ? 'up' : 'down'}">${money(pnl)}</b></div>
        <div><span>Trade</span><b>${sm.n ?? 0}</b></div>
        <div><span>Win rate</span><b>${sm.winRate != null ? Math.round(sm.winRate * 100) + '%' : '–'}</b></div>
        <div><span>Equity</span><b>${money(sm.equity ?? s.capital)}</b></div>
      </div>
      <div class="card-actions"><a class="btn primary" href="/session/${s.id}">Apri</a><button class="btn danger del">Elimina</button></div>`;
    el.querySelector('b').textContent = s.name;
    el.querySelector('.tag').textContent = s.symbol;
    el.querySelector('.cur').textContent = `Partenza ${fmtDT(s.startTime)} · Ora replay ${fmtDT(s.cursorTime ?? s.startTime)} ET`;
    el.querySelector('.del').onclick = async () => {
      if (!confirm(`Eliminare la sessione "${s.name}"? L'operazione non è reversibile.`)) return;
      await api('/sessions/' + s.id, { method: 'DELETE' }); loadSessions();
    };
    box.append(el);
  }
}

$('#form').addEventListener('submit', async e => {
  e.preventDefault(); err.textContent = '';
  const f = new FormData(e.target);
  try {
    const s = await api('/sessions', { method: 'POST', body: {
      name: f.get('name'), symbol: f.get('symbol'), startTime: fromInputValue(f.get('start')),
      capital: +f.get('capital'), commission: +f.get('commission'), timeframe: f.get('timeframe'),
    } });
    location.href = '/session/' + s.id;
  } catch (ex) { err.textContent = ex.message; }
});

(async () => {
  assets = await api('/assets');
  sel.innerHTML = assets.map(a => `<option value="${a.symbol}">${a.symbol} – ${a.name}</option>`).join('');
  sel.onchange = () => { start.value = ''; updateRange(); };
  updateRange();
  loadSessions();
})();

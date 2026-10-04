import { $, api, fmtDT, fromInputValue, toInputValue, money } from './util.js';
import { initTheme } from './theme.js';
initTheme($('#themeBtn'));

let assets = [];
const start = $('#start'), err = $('#err');
const chosen = () => [...document.querySelectorAll('#assets input:checked')].map(i => i.value);

function updateRange() {
  const sel = assets.filter(a => chosen().includes(a.symbol));
  if (!sel.length) { $('#range').textContent = 'Seleziona almeno un asset.'; return; }
  const from = Math.max(...sel.map(a => a.from)), to = Math.min(...sel.map(a => a.to));
  start.min = toInputValue(from); start.max = toInputValue(to);
  $('#range').textContent = `Dati disponibili: ${fmtDT(from)} → ${fmtDT(to)} ET (${sel[0].bars.toLocaleString('it-IT')} candele a 1 minuto)`;
  const cur = start.value && fromInputValue(start.value);
  if (!cur || cur < from || cur > to) {
    const d = new Date(from * 1000); d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(9, 30, 0, 0); // prima apertura regolare utile
    start.value = toInputValue(Math.floor(d / 1000));
  }
}

async function loadSessions() {
  const list = await api('/sessions');
  const box = $('#sessions');
  if (!list.length) { box.innerHTML = '<p class="muted">Nessuna sessione. Creane una a sinistra per iniziare.</p>'; return; }
  box.innerHTML = '';
  for (const s of list) {
    const sm = s.summary || {}, pnl = sm.total ?? 0;
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
      <div class="card-actions"><a class="btn primary" href="/session/${s.id}">Apri</a><button class="btn dup" title="Nuova sessione con le stesse impostazioni">Duplica</button><button class="btn rst" title="Riparte dall'inizio: azzera operazioni e journal">Riavvia</button><button class="btn danger del">Elimina</button></div>`;
    el.querySelector('b').textContent = s.name;
    el.querySelector('.tag').textContent = (s.symbols || [s.symbol]).join(' + ');
    el.querySelector('.cur').textContent = `Partenza ${fmtDT(s.startTime)} · Ora replay ${fmtDT(s.cursorTime ?? s.startTime)} ET`;
    el.querySelector('.dup').onclick = async () => { await api('/sessions/' + s.id + '/duplicate', { method: 'POST' }); loadSessions(); };
    el.querySelector('.rst').onclick = async () => {
      if (!confirm(`Riavviare "${s.name}" dall'inizio? Operazioni, journal e disegni verranno azzerati.`)) return;
      await api('/sessions/' + s.id + '/reset', { method: 'POST' }); loadSessions();
    };
    el.querySelector('.del').onclick = async () => {
      if (!confirm(`Eliminare la sessione "${s.name}"? L'operazione non è reversibile.`)) return;
      await api('/sessions/' + s.id, { method: 'DELETE' }); loadSessions();
    };
    box.append(el);
  }
}

$('#form').addEventListener('submit', async e => {
  e.preventDefault(); err.textContent = '';
  const f = new FormData(e.target), symbols = chosen();
  if (!symbols.length) { err.textContent = 'Seleziona almeno un asset'; return; }
  if (symbols.length > 4) { err.textContent = 'Massimo 4 asset'; return; }
  try {
    const s = await api('/sessions', { method: 'POST', body: {
      name: f.get('name'), symbols, startTime: fromInputValue(f.get('start')),
      capital: +f.get('capital'), commission: +f.get('commission'), slippage: +f.get('slippage') || 0, timeframe: f.get('timeframe'),
    } });
    location.href = '/session/' + s.id;
  } catch (ex) { err.textContent = ex.message; }
});

(async () => {
  assets = await api('/assets');
  $('#assets').innerHTML = assets.map((a, k) => `<label class="chkrow"><input type="checkbox" value="${a.symbol}" ${k === 0 ? 'checked' : ''}> <b>${a.symbol}</b> <span class="muted">${a.name}</span></label>`).join('');
  $('#assets').addEventListener('change', updateRange);
  updateRange();
  loadSessions();
})();

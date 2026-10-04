import { $, api, esc, money } from './util.js';
import { initTheme } from './theme.js';
import { computeMetrics } from './metrics.js';
initTheme($('#themeBtn'));

let list = [], trades = [], sel = null, timer = null;
const GROUPS = [['entry', 'Regole di ingresso'], ['exit', 'Regole di uscita'], ['risk', 'Gestione del rischio']];
const uid = () => Math.random().toString(36).slice(2, 10);

async function save() {
  clearTimeout(timer);
  timer = setTimeout(async () => { try { list = await api('/playbooks', { method: 'PUT', body: list }); $('#saved') && ($('#saved').textContent = 'Salvato'); } catch (e) { $('#saved') && ($('#saved').textContent = 'Errore: ' + e.message); } }, 600);
  $('#saved') && ($('#saved').textContent = 'Salvataggio…');
}
function statsOf(id) { const t = trades.filter(x => ((x.j || {}).setup || '') === id); return t.length ? computeMetrics(t, {}) : null; }

function renderList() {
  $('#pbList').innerHTML = list.length ? list.map(p => {
    const m = statsOf(p.id);
    return `<div class="pb-item ${p.id === sel ? 'on' : ''}" data-id="${esc(p.id)}"><b>${esc(p.name)}</b><small>${m ? `${m.n} trade · win ${(m.winRate * 100).toFixed(0)}% · ${money(m.net)}` : 'Nessun trade collegato'}</small></div>`;
  }).join('') : '<p class="muted">Nessun playbook. Creane uno per collegare le regole ai tuoi trade.</p>';
  $('#pbList').querySelectorAll('.pb-item').forEach(el => el.onclick = () => { sel = el.dataset.id; renderList(); renderEdit(); });
}
function renderEdit() {
  const p = list.find(x => x.id === sel), box = $('#pbEdit');
  if (!p) { box.innerHTML = '<div class="pb-edit"><p class="muted">Seleziona o crea un playbook.</p></div>'; return; }
  const m = statsOf(p.id);
  box.innerHTML = `<div class="pb-edit">
    <label>Nome<input id="pName" value="${esc(p.name)}" maxlength="80"></label>
    <label>Descrizione / quando si usa<textarea id="pDesc">${esc(p.description)}</textarea></label>
    <div class="rules3">${GROUPS.map(([g, l]) => `<label>${l} (una per riga)<textarea data-g="${g}" rows="6">${esc((p.rules[g] || []).join('\n'))}</textarea></label>`).join('')}</div>
    ${m ? `<div class="kpis-sm"><div class="kpi"><span>Trade</span><b>${m.n}</b></div><div class="kpi"><span>Win rate</span><b>${(m.winRate * 100).toFixed(1)}%</b></div><div class="kpi"><span>P&L netto</span><b class="${m.net >= 0 ? 'up' : 'down'}">${money(m.net)}</b></div><div class="kpi"><span>Profit factor</span><b>${m.profitFactor === Infinity ? '∞' : m.profitFactor == null ? '–' : m.profitFactor.toFixed(2)}</b></div></div>` : ''}
    <div style="display:flex;gap:10px;align-items:center"><button class="btn danger" id="pDel">Elimina</button><span class="muted small" id="saved"></span></div></div>`;
  $('#pName').oninput = e => { p.name = e.target.value; renderList(); save(); };
  $('#pDesc').oninput = e => { p.description = e.target.value; save(); };
  box.querySelectorAll('[data-g]').forEach(t => t.oninput = () => { p.rules[t.dataset.g] = t.value.split('\n').map(x => x.trim()).filter(Boolean); save(); });
  $('#pDel').onclick = () => { if (!confirm(`Eliminare il playbook "${p.name}"? I trade già collegati restano, ma senza nome.`)) return; list = list.filter(x => x !== p); sel = list[0] ? list[0].id : null; save(); renderList(); renderEdit(); };
}
$('#pbNew').onclick = () => { const p = { id: uid(), name: 'Nuovo playbook', description: '', rules: { entry: [], exit: [], risk: [] } }; list.push(p); sel = p.id; save(); renderList(); renderEdit(); };
(async () => {
  [list, { trades }] = await Promise.all([api('/playbooks'), api('/trades')]);
  sel = list[0] ? list[0].id : null; renderList(); renderEdit();
})();

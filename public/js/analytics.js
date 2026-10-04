// Dashboard di analisi (stile TradeZella): KPI, curve, calendario, performance per dimensione, trade log.
import { $, fmt, money, fmtDT, fmtDate, esc, fmtDur, pad } from './util.js';
import { computeMetrics, applyFilters, isWin, isLoss } from './metrics.js';
import { lineChart, barChart, donut, radar } from './charts.js';

const WEEKDAYS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
const MONTHS = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
const pct = x => (x == null ? '–' : (x * 100).toFixed(1).replace('.', ',') + '%');
const num = (x, d = 2) => (x == null || !isFinite(x) ? (x === Infinity ? '∞' : '–') : fmt(x, d));
const cls = v => (v > 0.005 ? 'up' : v < -0.005 ? 'down' : '');
const compactMoney = v => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1).replace('.', ',') + 'k' : String(Math.round(v)));

/**
 * root: elemento contenitore. all: tutti i trade (formato /api/trades). ctx:
 *   { playbooks: [], sessions: [{id,name,capital}], capital, filters: true, link: true }
 */
export function renderAnalytics(root, all, ctx = {}) {
  const state = { f: { sessions: [], symbols: [], side: 'all', setup: 'all', tag: '', mistake: '', from: '', to: '' }, month: null, day: null, sort: { k: 'exitTime', dir: -1 }, shown: 100 };
  const pbName = id => (id ? ((ctx.playbooks || []).find(p => p.id === id) || {}).name || 'Playbook eliminato' : 'Nessun playbook');
  root.innerHTML = '<div class="an-filters"></div><div class="an-body"></div>';
  const fbox = root.querySelector('.an-filters'), body = root.querySelector('.an-body');
  let redraws = [];
  const ro = new ResizeObserver(() => redraws.forEach(f => f()));
  ro.observe(body);

  const uniq = (fn) => [...new Set(all.flatMap(fn))].filter(Boolean).sort();
  function buildFilters() {
    if (ctx.filters === false) { fbox.remove(); return; }
    const sessOpts = (ctx.sessions || []).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    fbox.innerHTML = `
      ${ctx.sessions ? `<label>Sessione<select id="fSess"><option value="">Tutte</option>${sessOpts}</select></label>` : ''}
      <label>Simbolo<select id="fSym"><option value="">Tutti</option>${uniq(t => [t.symbol]).map(s => `<option>${esc(s)}</option>`).join('')}</select></label>
      <label>Lato<select id="fSide"><option value="all">Tutti</option><option value="long">Long</option><option value="short">Short</option></select></label>
      <label>Playbook<select id="fSetup"><option value="all">Tutti</option><option value="none">Nessuno</option>${(ctx.playbooks || []).map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
      <label>Tag<select id="fTag"><option value="">Tutti</option>${uniq(t => (t.j && t.j.tags) || []).map(s => `<option>${esc(s)}</option>`).join('')}</select></label>
      <label>Errore<select id="fMis"><option value="">Tutti</option>${uniq(t => (t.j && t.j.mistakes) || []).map(s => `<option>${esc(s)}</option>`).join('')}</select></label>
      <label>Dal<input type="date" id="fFrom"></label><label>Al<input type="date" id="fTo"></label>
      <button class="btn small" id="fReset">Azzera</button>`;
    const bind = (id, fn) => { const el = fbox.querySelector(id); if (el) el.onchange = () => { fn(el.value); state.day = null; state.shown = 100; render(); }; };
    bind('#fSess', v => { state.f.sessions = v ? [v] : []; }); bind('#fSym', v => { state.f.symbols = v ? [v] : []; }); bind('#fSide', v => { state.f.side = v; });
    bind('#fSetup', v => { state.f.setup = v; }); bind('#fTag', v => { state.f.tag = v; }); bind('#fMis', v => { state.f.mistake = v; });
    bind('#fFrom', v => { state.f.from = v; }); bind('#fTo', v => { state.f.to = v; });
    fbox.querySelector('#fReset').onclick = () => { state.f = { sessions: [], symbols: [], side: 'all', setup: 'all', tag: '', mistake: '', from: '', to: '' }; state.day = null; buildFilters(); render(); };
  }

  function capitalOf(trades) {
    if (ctx.capital) return ctx.capital;
    const seen = new Map(); for (const t of trades) seen.set(t.sid, t.capital || 0);
    return [...seen.values()].reduce((a, b) => a + b, 0);
  }
  const card = (title, inner, cls2 = '', note = '') => `<section class="an-card ${cls2}"><h4>${title}${note ? `<span class="muted small" title="${esc(note)}"> ⓘ</span>` : ''}</h4>${inner}</section>`;
  const kpi = (label, value, sub, c = '', note = '') => `<div class="kpi" ${note ? `title="${esc(note)}"` : ''}><span>${label}</span><b class="${c}">${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;

  function render() {
    redraws = [];
    const trades = applyFilters(all, state.f), m = computeMetrics(trades, { capital: capitalOf(trades) });
    if (!trades.length) {
      body.innerHTML = `<div class="an-empty"><h3>Nessuna operazione</h3><p class="muted">${all.length ? 'Nessun trade corrisponde ai filtri.' : 'Le operazioni chiuse nelle sessioni compariranno qui.'}</p></div>`;
      return;
    }
    const sc = m.score;
    body.innerHTML = `
      <div class="kpis6">
        ${kpi('P&L netto', money(m.net), `${m.n} operazioni`, cls(m.net))}
        ${kpi('Win rate', pct(m.winRate), `${m.wins} W · ${m.losses} L · ${m.be} BE`, '', 'Operazioni in profitto / totale')}
        ${kpi('Profit factor', num(m.profitFactor), `${money(m.grossWin)} / ${money(-m.grossLoss)}`, '', 'Profitti lordi / perdite lorde')}
        ${kpi('Giorni in profitto', pct(m.dayWinRate), `${m.days.length} giorni di trading`)}
        ${kpi('Media win / loss', num(m.ratio), `${money(m.avgWin)} / ${money(m.avgLoss ? -m.avgLoss : null)}`, '', 'Guadagno medio / perdita media')}
        ${kpi('Punteggio', sc ? Math.round(sc.total) + '<small> /100</small>' : '–', 'media di 6 indicatori', sc && sc.total >= 60 ? 'up' : sc && sc.total < 40 ? 'down' : '')}
      </div>
      <div class="kpis-sm">
        ${kpi('Expectancy', money(m.expectancy), 'per operazione', cls(m.expectancy))}
        ${kpi('R medio', m.avgR == null ? '–' : num(m.avgR) + ' R', m.totalR == null ? '' : `totale ${num(m.totalR)} R`, cls(m.avgR))}
        ${kpi('Max drawdown', money(-m.maxDD), m.maxDDpct == null ? '' : pct(m.maxDDpct) + ' del capitale', m.maxDD ? 'down' : '')}
        ${kpi('Recovery factor', num(m.recovery), 'P&L netto / max drawdown')}
        ${kpi('Miglior trade', money(m.best), '', 'up')}${kpi('Peggior trade', money(m.worst), '', 'down')}
        ${kpi('Miglior giorno', money(m.bestDay), '', 'up')}${kpi('Peggior giorno', money(m.worstDay), '', 'down')}
        ${kpi('Durata media', fmtDur(m.avgHold))}${kpi('Serie vincenti', m.maxConsecWins, 'massima')}${kpi('Serie perdenti', m.maxConsecLosses, 'massima')}
        ${kpi('Commissioni', money(m.commissions))}
        ${kpi('MFE medio', m.avgMfe == null ? '–' : num(m.avgMfe, 1) + ' pt', 'massimo favorevole', '', 'Quanto il prezzo è andato a favore in media durante i trade')}
        ${kpi('MAE medio', m.avgMae == null ? '–' : num(m.avgMae, 1) + ' pt', 'massimo avverso', '', 'Quanto il prezzo è andato contro in media durante i trade')}
        ${kpi('Efficienza', pct(m.efficiency), 'MFE catturato', '', 'Quota media del massimo movimento favorevole realizzata in chiusura')}
      </div>
      <div class="an-grid">
        ${card('P&L cumulato', '<canvas id="cEq"></canvas>', 'wide')}
        ${card('Punteggio', '<canvas id="cRadar"></canvas><div class="parts">' + (sc ? sc.parts.map(p => `<div title="${esc(p.note)}"><span>${p.label}</span><i><u style="width:${p.value}%"></u></i><b>${Math.round(p.value)}</b></div>`).join('') : '') + '</div>')}
        ${card('Drawdown', '<canvas id="cDd"></canvas>', 'wide')}
        ${card('Vinte / perse', '<canvas id="cDon" class="sq"></canvas>')}
        ${card('P&L netto giornaliero', '<canvas id="cDay"></canvas>', 'wide')}
        ${card('Calendario', '<div id="cal"></div>')}
        ${card('Per ora di ingresso (ET)', '<canvas id="cHour"></canvas>')}
        ${card('Per giorno della settimana', '<canvas id="cWd"></canvas>')}
        ${card('Per durata', '<canvas id="cDur"></canvas>')}
        ${card('Per simbolo', '<canvas id="cSym"></canvas>')}
        ${card('Per playbook', '<canvas id="cSetup"></canvas>')}
        ${card('Per tag', '<canvas id="cTag"></canvas>')}
        ${card('Per errore', '<canvas id="cMis"></canvas>', '', 'Errori segnati nel journal: P&L complessivo dei trade con quell\'errore')}
        ${card('Distribuzione R', '<canvas id="cR"></canvas>')}
        ${card('Distribuzione P&L', '<canvas id="cPl"></canvas>')}
        ${card('Per uscita', '<canvas id="cReason"></canvas>')}
      </div>
      <section class="an-card" id="logCard"></section>`;
    const q = id => body.querySelector(id);
    const wr = b => (b.n ? Math.round(b.wins / b.n * 100) : 0);
    const cat = (arr, labelFn = x => x.k) => arr.map(b => ({ label: labelFn(b), value: b.pnl, tip: `${labelFn(b)} · ${b.n} trade · win ${wr(b)}%` }));
    const draw = (id, fn) => { const cv = q(id); if (!cv) return; fn(cv); redraws.push(() => fn(cv)); };
    draw('#cEq', cv => lineChart(cv, m.equity.map(p => ({ x: p.t, y: p.v })), { zero: true, fmtX: (x, ax) => (ax ? fmtDate(x).slice(0, 5) : fmtDT(x)), fmtY: (v, ax) => (ax ? compactMoney(v) : money(v)), color: m.net >= 0 ? getComputedStyle(document.documentElement).getPropertyValue('--up').trim() : getComputedStyle(document.documentElement).getPropertyValue('--down').trim() }));
    draw('#cDd', cv => lineChart(cv, m.drawdown.map(p => ({ x: p.t, y: p.v })), { zero: true, fmtX: (x, ax) => (ax ? fmtDate(x).slice(0, 5) : fmtDT(x)), fmtY: (v, ax) => (ax ? compactMoney(v) : money(v)), color: getComputedStyle(document.documentElement).getPropertyValue('--down').trim() }));
    draw('#cDay', cv => barChart(cv, m.days.map(d => ({ label: d.day.slice(5).split('-').reverse().join('/'), value: d.pnl, tip: d.day, note: `${d.n} trade` })), { fmtY: (v, ax) => (ax ? compactMoney(v) : money(v)), rotate: true }));
    draw('#cHour', cv => barChart(cv, m.byHour.map(b => ({ label: pad(b.h), value: b.pnl, tip: `${pad(b.h)}:00 · ${b.n} trade · win ${wr(b)}%` })), { fmtY: (v, ax) => (ax ? compactMoney(v) : money(v)) }));
    draw('#cWd', cv => barChart(cv, [1, 2, 3, 4, 5, 6, 0].map(d => m.byWeekday[d]).map(b => ({ label: WEEKDAYS[b.d], value: b.pnl, tip: `${WEEKDAYS[b.d]} · ${b.n} trade · win ${wr(b)}%` })), { fmtY: (v, ax) => (ax ? compactMoney(v) : money(v)) }));
    draw('#cDur', cv => barChart(cv, cat(m.byDuration), { fmtY: (v, ax) => (ax ? compactMoney(v) : money(v)) }));
    draw('#cSym', cv => barChart(cv, cat(m.bySymbol), { fmtY: (v, ax) => (ax ? compactMoney(v) : money(v)) }));
    draw('#cSetup', cv => barChart(cv, cat(m.bySetup, b => pbName(b.k)), { fmtY: (v, ax) => (ax ? compactMoney(v) : money(v)) }));
    draw('#cTag', cv => barChart(cv, cat(m.byTag), { fmtY: (v, ax) => (ax ? compactMoney(v) : money(v)), rotate: true }));
    draw('#cMis', cv => barChart(cv, cat(m.byMistake), { fmtY: (v, ax) => (ax ? compactMoney(v) : money(v)), rotate: true }));
    draw('#cReason', cv => barChart(cv, cat(m.byReason, b => ({ sl: 'Stop loss', tp: 'Take profit', manual: 'Manuale' }[b.k] || b.k)), { fmtY: (v, ax) => (ax ? compactMoney(v) : money(v)) }));
    draw('#cR', cv => barChart(cv, m.rHist.map(b => ({ label: ((b.from + b.to) / 2).toFixed(1), value: b.n, color: b.to <= 0 ? '#ef5350' : '#26a69a', tip: `da ${b.from.toFixed(2)} a ${b.to.toFixed(2)} R` })), { fmtY: v => String(Math.round(v)) }));
    draw('#cPl', cv => barChart(cv, m.pnlHist.map(b => ({ label: compactMoney((b.from + b.to) / 2), value: b.n, color: b.to <= 0 ? '#ef5350' : '#26a69a', tip: `da ${money(b.from)} a ${money(b.to)}` })), { fmtY: v => String(Math.round(v)) }));
    draw('#cDon', cv => donut(cv, [{ label: 'Vinte', value: m.wins, color: '#26a69a' }, { label: 'Pareggi', value: m.be, color: '#868993' }, { label: 'Perse', value: m.losses, color: '#ef5350' }], pct(m.winRate)));
    if (sc) draw('#cRadar', cv => radar(cv, sc.parts.map(p => ({ label: p.label, value: p.value }))));
    renderCalendar(q('#cal'), m);
    renderLog(q('#logCard'), trades);
  }

  function renderCalendar(el, m) {
    const byDay = new Map(m.days.map(d => [d.day, d]));
    if (!state.month) { const last = m.days[m.days.length - 1].day; state.month = { y: +last.slice(0, 4), m: +last.slice(5, 7) - 1 }; }
    const { y, m: mo } = state.month, first = new Date(Date.UTC(y, mo, 1)), lead = (first.getUTCDay() + 6) % 7, nd = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const maxAbs = Math.max(1, ...m.days.map(d => Math.abs(d.pnl)));
    let cells = '', week = 0, wn = 0, html = '';
    const flush = () => { html += `<div class="wk ${cls(week)}"><small>Sett.</small>${wn ? money(week) : '–'}<small>${wn} trade</small></div>`; week = 0; wn = 0; };
    for (let i = 0; i < lead; i++) html += '<div class="d empty"></div>';
    let col = lead;
    for (let d = 1; d <= nd; d++) {
      const key = `${y}-${pad(mo + 1)}-${pad(d)}`, r = byDay.get(key);
      const a = r ? 0.12 + 0.5 * Math.min(1, Math.abs(r.pnl) / maxAbs) : 0, bg = r ? (r.pnl >= 0 ? `rgba(38,166,154,${a})` : `rgba(239,83,80,${a})`) : '';
      html += `<div class="d ${r ? 'has' : ''} ${state.day === key ? 'sel' : ''}" data-day="${key}" style="${bg ? 'background:' + bg : ''}"><small>${d}</small>${r ? `<b class="${cls(r.pnl)}">${compactMoney(r.pnl)}</b><small>${r.n} tr.</small>` : ''}</div>`;
      if (r) { week += r.pnl; wn += r.n; }
      if (++col % 7 === 0) flush();
    }
    if (col % 7) { while (col % 7) { html += '<div class="d empty"></div>'; col++; } flush(); }
    const mTotal = m.days.filter(d => d.day.startsWith(`${y}-${pad(mo + 1)}`)).reduce((a, d) => a + d.pnl, 0);
    el.innerHTML = `<div class="cal-head"><button class="btn small" data-nav="-1">‹</button><b>${MONTHS[mo]} ${y}</b><button class="btn small" data-nav="1">›</button><span class="grow"></span><span class="${cls(mTotal)}">${money(mTotal)}</span></div>
      <div class="cal-grid"><div class="dow">Lun</div><div class="dow">Mar</div><div class="dow">Mer</div><div class="dow">Gio</div><div class="dow">Ven</div><div class="dow">Sab</div><div class="dow">Dom</div><div class="dow"></div>${html}</div>`;
    el.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => { const t = new Date(Date.UTC(y, mo + +b.dataset.nav, 1)); state.month = { y: t.getUTCFullYear(), m: t.getUTCMonth() }; renderCalendar(el, m); });
    el.querySelectorAll('[data-day].has').forEach(c => c.onclick = () => { state.day = state.day === c.dataset.day ? null : c.dataset.day; state.shown = 100; renderCalendar(el, m); renderLog(body.querySelector('#logCard'), applyFilters(all, state.f)); });
    void cells;
  }

  const COLS = [['exitTime', 'Uscita'], ['symbol', 'Simbolo'], ['side', 'Lato'], ['qty', 'Qtà'], ['entry', 'Ingresso'], ['exit', 'Uscita'], ['dur', 'Durata'], ['pnl', 'P&L'], ['r', 'R'], ['setup', 'Playbook'], ['tags', 'Tag'], ['rating', 'Voto']];
  function renderLog(el, trades) {
    let rows = state.day ? trades.filter(t => new Date(t.exitTime * 1000).toISOString().slice(0, 10) === state.day) : trades;
    const val = (t, k) => k === 'dur' ? t.exitTime - t.entryTime : k === 'setup' ? pbName((t.j || {}).setup) : k === 'tags' ? ((t.j || {}).tags || []).join(',') : k === 'rating' ? (t.j || {}).rating || 0 : t[k];
    const { k, dir } = state.sort;
    rows = [...rows].sort((a, b) => { const x = val(a, k), y = val(b, k); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
    const shown = rows.slice(0, state.shown);
    el.innerHTML = `<h4>Trade log${state.day ? ` · <span class="chip" id="clrDay">${state.day} ✕</span>` : ''} <span class="muted small">(${rows.length})</span></h4>
      <div class="tw"><table class="log"><thead><tr>${COLS.map(([c, l]) => `<th data-sort="${c}" class="${c === k ? 'sorted' : ''}">${l}${c === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead><tbody>
      ${shown.map((t, i) => `<tr data-i="${i}"><td>${fmtDT(t.exitTime)}</td><td>${esc(t.symbol)}</td><td class="${t.side === 'long' ? 'up' : 'down'}">${t.side === 'long' ? 'Long' : 'Short'}</td><td>${t.qty}</td><td>${fmt(t.entry)}</td><td>${fmt(t.exit)}</td><td>${fmtDur(t.exitTime - t.entryTime)}</td><td class="${cls(t.pnl)}">${money(t.pnl)}</td><td>${t.r != null ? num(t.r) : '–'}</td><td>${esc(pbName((t.j || {}).setup))}</td><td>${((t.j || {}).tags || []).map(x => `<span class="chip">${esc(x)}</span>`).join('')}</td><td>${'★'.repeat((t.j || {}).rating || 0)}</td></tr>`).join('')}
      </tbody></table></div>${rows.length > shown.length ? `<button class="btn small" id="moreBtn">Mostra altri</button>` : ''}`;
    el.querySelectorAll('[data-sort]').forEach(h => h.onclick = () => { state.sort = { k: h.dataset.sort, dir: state.sort.k === h.dataset.sort ? -state.sort.dir : -1 }; renderLog(el, trades); });
    el.querySelectorAll('tbody tr').forEach(r => r.onclick = () => openDetail(shown[+r.dataset.i]));
    const mb = el.querySelector('#moreBtn'); if (mb) mb.onclick = () => { state.shown += 200; renderLog(el, trades); };
    const cd = el.querySelector('#clrDay'); if (cd) cd.onclick = () => { state.day = null; renderCalendar(body.querySelector('#cal'), computeMetrics(trades, {})); renderLog(el, trades); };
  }

  function openDetail(t) {
    const j = t.j || {}, pb = (ctx.playbooks || []).find(p => p.id === j.setup);
    let ov = document.getElementById('anModal');
    if (!ov) { ov = document.createElement('div'); ov.id = 'anModal'; document.body.append(ov); }
    const rules = pb ? ['entry', 'exit', 'risk'].map(g => ({ g, l: pb.rules[g] || [] })).filter(x => x.l.length) : [];
    const gl = { entry: 'Ingresso', exit: 'Uscita', risk: 'Rischio' };
    const shots = j.shots || {};
    ov.hidden = false;
    ov.innerHTML = `<div class="dlg wide"><div class="dh"><h3>${esc(t.symbol)} · ${t.side === 'long' ? 'Long' : 'Short'} ${t.qty} <span class="${cls(t.pnl)}">${money(t.pnl)}</span>${t.r != null ? ` <span class="muted">(${num(t.r)} R)</span>` : ''}</h3><button class="btn ghost" id="anX">✕</button></div>
      <div class="facts">
        <div><span>Ingresso</span><b>${fmtDT(t.entryTime, true)} @ ${fmt(t.entry)}</b></div><div><span>Uscita</span><b>${fmtDT(t.exitTime, true)} @ ${fmt(t.exit)}</b></div>
        <div><span>Durata</span><b>${fmtDur(t.exitTime - t.entryTime)}</b></div><div><span>Motivo</span><b>${{ sl: 'Stop loss', tp: 'Take profit', manual: 'Manuale' }[t.reason] || t.reason}</b></div>
        <div><span>SL / TP</span><b>${t.sl != null ? fmt(t.sl) : '–'} / ${t.tp != null ? fmt(t.tp) : '–'}</b></div><div><span>MFE / MAE</span><b>${t.mfe != null ? num(t.mfe, 1) : '–'} / ${t.mae != null ? num(t.mae, 1) : '–'} pt</b></div>
        <div><span>Playbook</span><b>${esc(pbName(j.setup))}</b></div><div><span>Voto</span><b>${'★'.repeat(j.rating || 0) || '–'}</b></div>
      </div>
      ${(j.tags || []).length || (j.mistakes || []).length ? `<p>${(j.tags || []).map(x => `<span class="chip">${esc(x)}</span>`).join('')} ${(j.mistakes || []).map(x => `<span class="chip bad">${esc(x)}</span>`).join('')}</p>` : ''}
      ${j.notes ? `<h4>Note</h4><p class="pre">${esc(j.notes)}</p>` : ''}
      ${rules.length ? '<h4>Regole del playbook</h4>' + rules.map(r => `<div class="rl"><b>${gl[r.g]}</b>${r.l.map((x, i) => `<div>${(j.rules || {})[r.g + ':' + i] ? '✅' : '⬜'} ${esc(x)}</div>`).join('')}</div>`).join('') : ''}
      ${shots.entry || shots.exit ? `<h4>Screenshot</h4><div class="shots">${shots.entry ? `<a href="${esc(shots.entry)}" target="_blank"><img src="${esc(shots.entry)}" alt="Ingresso"><small>Ingresso</small></a>` : ''}${shots.exit ? `<a href="${esc(shots.exit)}" target="_blank"><img src="${esc(shots.exit)}" alt="Uscita"><small>Uscita</small></a>` : ''}</div>` : ''}
      <p style="text-align:right">${ctx.link === false ? '' : `<a class="btn" href="/session/${esc(t.sid)}">Apri la sessione “${esc(t.sname || '')}”</a>`}</p></div>`;
    ov.onclick = e => { if (e.target === ov) ov.hidden = true; };
    ov.querySelector('#anX').onclick = () => { ov.hidden = true; };
  }

  buildFilters();
  render();
  return { refresh: () => render(), destroy: () => ro.disconnect() };
}

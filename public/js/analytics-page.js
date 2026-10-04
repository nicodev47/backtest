import { $, api } from './util.js';
import { initTheme } from './theme.js';
import { renderAnalytics } from './analytics.js';
initTheme($('#themeBtn'));
(async () => {
  try {
    const [{ trades, sessions }, playbooks] = await Promise.all([api('/trades'), api('/playbooks')]);
    renderAnalytics($('#anRoot'), trades, { playbooks, sessions });
  } catch (e) { $('#anRoot').innerHTML = '<p class="down">Impossibile caricare i dati: ' + e.message + '</p>'; }
})();

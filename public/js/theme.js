// Tema chiaro/scuro persistito in localStorage, di default segue il sistema.
export function initTheme(btn, onChange) {
  const apply = t => { document.documentElement.dataset.theme = t; try { localStorage.setItem('theme', t); } catch {} onChange && onChange(t); };
  let t = null; try { t = localStorage.getItem('theme'); } catch {}
  t = t || 'dark';
  document.documentElement.dataset.theme = t;
  if (btn) btn.onclick = () => apply(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  onChange && onChange(t);
}

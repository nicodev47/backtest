// Con `npm run live` il server cambia identità a ogni riavvio: la pagina si ricarica da sola.
(async () => {
  try {
    const first = await (await fetch('/api/version')).json();
    if (!first.live) return;
    setInterval(async () => {
      try { const v = await (await fetch('/api/version')).json(); if (v.id !== first.id) location.reload(); } catch { /* server in riavvio */ }
    }, 3000);
  } catch { /* ignora */ }
})();

# Backtest

Software di backtest manuale via web: dashboard per creare sessioni e grafico in stile TradingView con replay candela per candela.

## Avvio

```bash
npm install
npm start          # http://localhost:3000  (PORT per cambiare porta)
npm run live       # come start, ma si aggiorna da solo quando arrivano nuovi commit su GitHub
npm test           # test del motore di ordini
```

## Cosa c'è

**Dashboard** (`/`): crea una sessione scegliendo nome, asset, data/ora di partenza, capitale, commissioni e timeframe; elenca, riapre ed elimina le sessioni (con P&L, trade e win rate).

**Sessione** (`/session/:id`):
- Grafico a candele (lightweight-charts, la libreria di TradingView) con timeframe 1m–1D.
- Replay: play/pausa (Spazio), +1 secondo (Alt+→), +1 minuto (→), +1 barra (Maiusc+→), velocità da 1 s/s a 100 min/s, salto in avanti a data/ora o alla prossima apertura 09:30 ET. Il replay è solo in avanti.
- I dati sono a 1 minuto, quindi i **secondi sono simulati**: ogni candela viene percorsa in 60 passi (O→L→H→C se rialzista, O→H→L→C se ribassista). OHLC della candela completa restano quelli reali.
- Strumenti di disegno: trendline, semiretta, freccia, linee orizzontali/verticali, canale parallelo, Fibonacci, rettangolo, posizione long/short, testo, pennello, righello; selezione, spostamento, maniglie, colore/spessore/stile, duplica, blocca, magnete, annulla/ripeti (Ctrl+Z).
- Trading simulato: ordini Market/Limit/Stop con SL/TP, size per contratti o per % di rischio, posizione netta, chiudi/inverti/SL a pareggio, SL/TP/ordini pendenti trascinabili sul grafico (SL/TP si possono aggiungere anche dopo l'apertura), storico, statistiche, equity curve, export CSV.
- Salvataggio automatico su server (cursore, conto, disegni, indicatori).

## Dati

I dati stanno in `data/` (CSV `time,open,high,low,close,volume`, candele a 1 minuto, orario ET trattato come UTC) e sono registrati in `data/assets.json`. Ora c'è solo NQ di novembre 2025 (anche come MNQ, $2/punto). Per aggiungere un asset basta aggiungere il CSV e una riga in `assets.json`. I timeframe superiori sono aggregati dai dati a 1 minuto; 4h e 1D si ancorano all'apertura CME delle 18:00 ET.

## Regole di simulazione

- Market: eseguito alla chiusura della candela 1m corrente. Limit/Stop: valutati sulle candele 1m successive (gap: fill all'apertura).
- Se SL e TP cadono nella stessa candela 1m vale lo SL. Nessuno slippage; commissione per contratto configurabile.

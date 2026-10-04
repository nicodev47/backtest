# Backtest

Software di backtest manuale via web: dashboard per creare sessioni e grafico in stile TradingView con replay candela per candela.

## Avvio

```bash
npm install
npm start          # http://localhost:3000  (PORT per cambiare porta)
npm test           # test del motore di ordini
```

## Cosa c'è

**Dashboard** (`/`): crea una sessione scegliendo nome, asset, data/ora di partenza, capitale, commissioni e timeframe; elenca, riapre ed elimina le sessioni (con P&L, trade e win rate).

**Sessione** (`/session/:id`):
- Grafico (lightweight-charts, la libreria di TradingView) con timeframe 1m–1D, candele / Heikin Ashi / barre / linea / area, volume, scala log.
- Replay: play/pausa (Spazio), +1 minuto (→), +1 barra (Maiusc+→), velocità fino a 300 candele/s, salto in avanti a data/ora o alla prossima apertura 09:30 ET. Il replay è solo in avanti.
- Strumenti di disegno: trendline, semiretta, freccia, linee orizzontali/verticali, canale parallelo, Fibonacci, rettangolo, posizione long/short, testo, pennello, righello; selezione, spostamento, maniglie, colore/spessore/stile, duplica, blocca, magnete, annulla/ripeti (Ctrl+Z).
- Indicatori: SMA, EMA, Bollinger, VWAP di sessione, RSI, MACD, ATR (parametri modificabili).
- Trading simulato: ordini Market/Limit/Stop con SL/TP, size per contratti o per % di rischio, posizione netta, chiudi/inverti/SL a pareggio, SL/TP/ordini trascinabili sul grafico, storico, statistiche, equity curve, export CSV.
- Salvataggio automatico su server (cursore, conto, disegni, indicatori).

## Dati

I dati stanno in `data/` (CSV `time,open,high,low,close,volume`, candele a 1 minuto, orario ET trattato come UTC) e sono registrati in `data/assets.json`. Ora c'è solo NQ di novembre 2025 (anche come MNQ, $2/punto). Per aggiungere un asset basta aggiungere il CSV e una riga in `assets.json`. I timeframe superiori sono aggregati dai dati a 1 minuto; 4h e 1D si ancorano all'apertura CME delle 18:00 ET.

## Regole di simulazione

- Market: eseguito alla chiusura della candela 1m corrente. Limit/Stop: valutati sulle candele 1m successive (gap: fill all'apertura).
- Se SL e TP cadono nella stessa candela 1m vale lo SL. Nessuno slippage; commissione per contratto configurabile.

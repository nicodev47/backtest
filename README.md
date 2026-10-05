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

Tre aree, sul modello di FXReplay / TradingView Replay (replay e trading simulato) e TradeZella (journal e analisi):

### Dashboard (`/`)
Crea una sessione (nome, uno o più asset fino a 4 grafici, partenza, capitale, commissioni, **slippage in tick**, timeframe). Per ogni sessione: P&L, trade, win rate, equity; **Apri, Duplica** (stesse impostazioni, senza operazioni), **Riavvia** (riparte dall'inizio), **Elimina**.

### Sessione (`/session/:id`) — replay e trading
- **Più grafici** (1, 2 affiancati, 2 sovrapposti, griglia 4) con simbolo e timeframe indipendenti sullo stesso orologio di replay; cursore sincronizzato; countdown della candela; tema nero con candele monocromatiche o classiche.
- **Replay**: barra flottante (play/pausa, velocità, passo da 1 tick / 1s fino a 1h, avanti, pausa su fill/SL/TP), Go To (data/ora, apertura 09:30, +1h, +1g). Solo in avanti. Con i **tick** importati la candela si muove a ogni scambio (millisecondi, ordini eseguiti sul prezzo del tick); senza tick i secondi sono simulati.
- **Trading**: Market/Limit/Stop con SL, TP e **trailing stop**; size per contratti o per % di rischio; **chiusura parziale** (25/50/75% o quantità), inverti, SL a pareggio; SL, TP e ordini **trascinabili sul grafico**; **slippage** e commissioni; un conto per simbolo; footer con Buy/Sell rapidi.
- **Clic destro sul grafico**: compra/vendi a quel prezzo (limit o stop in automatico), **alert di prezzo** (il replay si ferma quando scatta; anche dal 🔔 del footer), linea orizzontale, copia prezzo, annulla ordine/alert.
- **Strumenti di disegno**: trendline, semiretta, freccia, orizzontale/verticale, canale, Fibonacci, rettangolo, posizione long/short, testo, pennello, righello; magnete, blocco, nascondi, elenco oggetti, annulla/ripeti.
- **Scorciatoie da tastiera configurabili** (⚙ → Scorciatoie): play, passo, buy/sell, chiudi, inverti, BE, tool, timeframe, ecc.
- **Prop Firm Rules**: obiettivo, perdita giornaliera, drawdown (anche trailing), con pausa e, a scelta, chiusura automatica di tutto alla violazione.
- **Journal** (▤): note di sessione e, per ogni trade, **playbook con checklist delle regole, tag, errori, voto a stelle, note** e **screenshot automatici di ingresso e uscita** (disattivabili).
- **Analytics** della sessione (stessa dashboard della pagina Analytics), pannello inferiore con posizioni/ordini/storico, export CSV.

### Analytics (`/analytics`) — su tutte le sessioni
KPI (P&L netto, win rate, profit factor, giorni in profitto, media win/loss, expectancy, R medio, max drawdown e recovery factor, serie, durata media, commissioni, MFE/MAE/efficienza), **punteggio 0-100** su 6 indicatori, curva del P&L e drawdown, P&L giornaliero, **calendario mensile**, performance per ora, giorno della settimana, durata, simbolo, playbook, tag, **errori**, tipo di uscita, distribuzione di R e P&L, win/loss, **trade log** ordinabile con dettaglio (screenshot, note, regole). Filtri per sessione, simbolo, lato, playbook, tag, errore e date.

### Playbook (`/playbooks`)
Le tue strategie con regole di ingresso, uscita e rischio: si collegano ai trade dal Journal e compaiono nelle analisi con le loro statistiche.

**Tick e secondi.** Se per un asset sono stati importati i **tick** (vedi sotto), il replay è reale: a ogni scambio la candela aggiorna close, high, low e volume. Senza tick i **secondi sono simulati** (O→L→H→C se rialzista, O→H→L→C se ribassista) e il titolo del grafico non riporta "TICK".

## Dati

I dati stanno in `data/` (CSV `time,open,high,low,close,volume`, candele a 1 minuto, orario ET trattato come UTC) e sono registrati in `data/assets.json`. Asset disponibili: **NQ** ($20 a punto) e **MNQ** (micro, $2 a punto, stessi prezzi di NQ), dal campione FirstRate Data a 1 minuto, dal 17/09/2026 al 02/10/2026 (16.200 candele). Aggregato a 5m, 30m e 1h coincide esattamente con i campioni 5m/30m/1h forniti (OHLC e volume). Le sessioni create con dati che non ci sono più vengono segnalate nella dashboard e si possono solo eliminare.

I timeframe superiori sono aggregati dai dati a 1 minuto; 4h e 1D si ancorano all'apertura CME delle 18:00 ET. Il giorno aggregato ha open/high/low identici al giornaliero ufficiale, ma close e volume possono differire (quello ufficiale usa il prezzo di settlement).

Per aggiungere un asset a 1 minuto (es. ES): `npm run import -- <file.csv|file.html> ES "E-mini S&P 500 Futures" 50 [tick] [reuse=<file già in data/>]`. Accetta un CSV con intestazione `time` (secondi unix) oppure `timestamp` ("AAAA-MM-GG HH:MM:SS"), `open,high,low,close,volume` (altre colonne ignorate), oppure un file "Replay…" HTML con `const D=[[t,o,h,l,c,v],…]`.

### Tick (per candele che si muovono realisticamente)

```bash
npm run import-ticks -- --sym=NQ --name="E-mini Nasdaq-100" --pv=20 [--tick=0.25] [--tz=auto|ET|UTC] [--contract=auto|NQZ6] tick1.csv.gz tick2.csv.gz ...
npm run import -- x MNQ "Micro E-mini Nasdaq-100" 2 0.25 reuse=NQ_1m.csv     # stessi dati/tick per il micro (opzionale)
```
Crea `data/ticks/NQ/` (un file binario compatto per giorno, **non versionato**) e ricava `data/NQ_1m.csv` dai tick, così minuti e tick coincidono. I file vanno passati in ordine cronologico; si accettano `.csv` e `.csv.gz`. Colonne riconosciute: orario (`ts_event`/`timestamp`/`time`), `price`, `size`, opzionali `symbol` e `action` (si tengono solo i trade `T`). Orari ISO con Z/offset o epoch sono istanti UTC e vengono convertiti in ET (ora legale inclusa); orari senza fuso si assumono già ET (`--tz=UTC` per cambiare). Con più contratti nel file (rollover) `--contract=auto` usa per ogni giorno il più scambiato e ignora gli spread. Nel replay i giorni di tick vengono caricati a richiesta (se non sono ancora arrivati il replay attende, non simula).

## Regole di simulazione

- Con i tick: ogni ordine/SL/TP è valutato su ogni scambio e riempito al prezzo del tick. Senza tick: Market al prezzo corrente del passo simulato; Limit/Stop valutati passo per passo (gap: fill all'apertura del passo).
- Se SL e TP cadono nella stessa candela 1m vale lo SL. Nessuno slippage; commissione per contratto configurabile.

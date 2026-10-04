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

**Dashboard** (`/`): crea una sessione scegliendo nome, uno o più asset (fino a 4 grafici), data/ora di partenza, capitale, commissioni e timeframe; elenca, riapre ed elimina le sessioni (con P&L, trade e win rate).

**Sessione** (`/session/:id`), interfaccia in stile FXReplay/TradingView, tema nero:
- **Più grafici** (layout singolo, 2 affiancati, 2 sovrapposti, griglia 4): ognuno con il proprio simbolo e timeframe, tutti sullo stesso orologio di replay. Il grafico attivo ha il bordo blu; cursore sincronizzato tra i grafici (opzionale). Countdown della candela sull'ultimo prezzo.
- **Replay** (barra flottante trascinabile): play/pausa (Spazio), velocità (slider), passo (1s, 5s, 15s, 30s, 1m, 5m, 15m, 1h) con ⏭ (→), Maiusc+→ completa la barra del timeframe attivo, interruttore "pausa su fill/SL/TP". Solo in avanti.
- **Go To**: salto a data/ora, prossima apertura 09:30 ET, +1 ora, +1 giorno. **Journal**: note di sessione e per operazione. **Order**: pannello ordini flottante.
- Barra a sinistra con gli strumenti di disegno (trendline, semiretta, freccia, linee orizzontali/verticali, canale, Fibonacci, rettangolo, posizione long/short, testo, pennello, righello, magnete, blocco, nascondi, sincronizza cursore); elenco oggetti (☰), annulla/ripeti, screenshot, impostazioni (stile candele monocromatico/classico).
- **Trading simulato**: Buy/Sell dal footer (quantità, SL e TP in punti) oppure ordini Market/Limit/Stop dal pannello Order; size per contratti o per % di rischio. Un conto per simbolo; SL, TP e ordini pendenti si **trascinano sul grafico** (e si possono aggiungere dopo l'apertura). Pannello inferiore (⋮⋮⋮) con posizioni/ordini, storico e Analytics (statistiche, equity curve, export CSV).
- **Prop Firm Rules**: obiettivo di profitto, perdita massima giornaliera, drawdown massimo (anche trailing), con avviso e pausa quando un limite viene raggiunto.
- Salvataggio automatico su server (orologio, conti, disegni, layout, journal).

**Tick e secondi.** Se per un asset sono stati importati i **tick** (vedi sotto), il replay è reale: a ogni scambio la candela aggiorna close, high, low e volume, l'orologio mostra i millisecondi, il passo "1 tick" avanza di uno scambio e gli ordini/SL/TP vengono eseguiti sul prezzo del tick (con lo slippage dei gap). Senza tick i **secondi sono simulati**: ogni candela a 1 minuto viene percorsa in 60 passi (O→L→H→C se rialzista, O→H→L→C se ribassista) e il titolo del grafico non riporta "TICK".

## Dati

I dati stanno in `data/` (CSV `time,open,high,low,close,volume`, candele a 1 minuto, orario ET trattato come UTC) e sono registrati in `data/assets.json`. Asset disponibili:
- **NQ26 / MNQ26** (MNQ = $2 a punto): NQ dal 17/09/2026 al 02/10/2026, dai campioni a 1 minuto forniti. Aggregati a 5m, 30m e 1h coincidono esattamente con i campioni 5m/30m/1h forniti (OHLC e volume).
- **NQ / MNQ**: novembre 2025 (dati del file di replay iniziale).

I timeframe superiori sono aggregati dai dati a 1 minuto; 4h e 1D si ancorano all'apertura CME delle 18:00 ET. Il giorno aggregato ha open/high/low identici al giornaliero ufficiale, ma close e volume possono differire (quello ufficiale usa il prezzo di settlement).

Per aggiungere un asset a 1 minuto (es. ES): `npm run import -- <file.csv|file.html> ES "E-mini S&P 500 Futures" 50 [tick] [reuse=<file già in data/>]`. Accetta un CSV con intestazione `time` (secondi unix) oppure `timestamp` ("AAAA-MM-GG HH:MM:SS"), `open,high,low,close,volume` (altre colonne ignorate), oppure un file "Replay…" HTML con `const D=[[t,o,h,l,c,v],…]`.

### Tick (per candele che si muovono realisticamente)

```bash
npm run import-ticks -- --sym=NQ26 --name="E-mini Nasdaq-100" --pv=20 [--tick=0.25] [--tz=auto|ET|UTC] [--contract=auto|NQZ6] tick1.csv.gz tick2.csv.gz ...
npm run import -- x MNQ26 "Micro E-mini Nasdaq-100" 2 0.25 reuse=NQ26_1m.csv     # stessi tick per il micro (opzionale)
```
Crea `data/ticks/NQ26/` (un file binario compatto per giorno, **non versionato**) e ricava `data/NQ26_1m.csv` dai tick, così minuti e tick coincidono. I file vanno passati in ordine cronologico; si accettano `.csv` e `.csv.gz`. Colonne riconosciute: orario (`ts_event`/`timestamp`/`time`), `price`, `size`, opzionali `symbol` e `action` (si tengono solo i trade `T`). Orari ISO con Z/offset o epoch sono istanti UTC e vengono convertiti in ET (ora legale inclusa); orari senza fuso si assumono già ET (`--tz=UTC` per cambiare). Con più contratti nel file (rollover) `--contract=auto` usa per ogni giorno il più scambiato e ignora gli spread. Nel replay i giorni di tick vengono caricati a richiesta (se non sono ancora arrivati il replay attende, non simula).

## Regole di simulazione

- Con i tick: ogni ordine/SL/TP è valutato su ogni scambio e riempito al prezzo del tick. Senza tick: Market al prezzo corrente del passo simulato; Limit/Stop valutati passo per passo (gap: fill all'apertura del passo).
- Se SL e TP cadono nella stessa candela 1m vale lo SL. Nessuno slippage; commissione per contratto configurabile.

# scalper

Progetto standalone XAUUSD, completamente separato da `soldi-trend`.

## Architettura

- **Vercel / Next.js**: dashboard, storico, STOP TUTTO e API di controllo.
- **Worker Node sempre acceso**: `worker/streaming.ts`.
- **MetaApi Streaming/WebSocket**: quote XAUUSD continue e stato MT5 locale.
- **Neon/Postgres**: segnali, risultati, stato worker e kill switch persistente.

Il cron non è più il motore principale. `/api/cron/analyze` resta soltanto come fallback opzionale.

## Strategia

- M1: trigger operativo, valutato alla chiusura reale della candela.
- M5: contesto immediato.
- Setup: micro-pullback, liquidity sweep o momentum breakout.
- Storico iniziale: 500 M1 e 300 M5, configurabile fino a 1000.
- Stop dinamico 2–5 USD.
- TP predefinito 1.45R (stesso R:R per tutti e tre i setup).
- Una sola posizione XAUUSD alla volta.
- Cooldown dopo loss; pausa più lunga dopo 3 loss consecutive.
- Filtro spread, ATR M1 e filtro shock **invariati**: la logica di ingresso non li tocca.

### Contesto M5 e direzionalità M1

Il gate M5 vale per tutti i setup:

- **M5 contrario** alla direzione dell'M1: blocco sempre.
- **M5 allineato**: passa come prima.
- **M5 neutro**: non blocca più di per sé. Il micro-pullback passa solo con M1 chiaramente direzionale — EMA9/EMA20 M1 allineate da almeno `M1_ALIGN_BARS` candele, prezzo dal lato giusto di entrambe e accelerazione reale (ultime `ACCEL_BARS` candele nella stessa direzione, range medio ≥ `ACCEL_ATR_MULT` × ATR M1 e corpi ≥ `ACCEL_BODY_RATIO` del range). Il momentum breakout richiede la sola parte strutturale (EMA allineate + prezzo dal lato giusto), perché porta già le proprie conferme di forza; il liquidity sweep mantiene il comportamento storico.

### Momentum breakout M1

Rottura del massimo/minimo delle ultime `BREAKOUT_LOOKBACK` candele M1 (10–15 consigliato) con:

- candela di rottura a corpo ≥ `BREAKOUT_BODY_RATIO` del range;
- ampiezza della candela di rottura sopra la media delle `BREAKOUT_VOL_BARS` precedenti (proxy di volume: MetaApi non fornisce il volume nel buffer di candele del worker, quindi si usa l'ampiezza);
- EMA9 > EMA20 (long) o EMA9 < EMA20 (short) sull'M1;
- chiusura oltre il livello di almeno `BREAKOUT_CLOSE_ATR_MULT` × ATR M1;
- prezzo ancora oltre il livello sulla candela d'ingresso.

La candela di rottura è l'ultima M1 **chiusa**: l'ingresso avviene sulla candela successiva, lo stop struttura va sotto (long) o sopra (short) la candela di rottura e il TP usa lo stesso R:R degli altri setup.

### Anti-accumulo

Blocca soltanto il range vero: ampiezza delle ultime `RANGE_LOOKBACK` candele M1 sotto `RANGE_ATR_MULT` × ATR M1 **e** EMA9/EMA20 M1 piatte (variazione ≤ `EMA_FLAT_SLOPE_ATR` × ATR su `EMA_SLOPE_BARS` candele). Una compressione breve seguita da espansione non blocca: basta una candela fra le ultime `RANGE_EXPANSION_BARS` con range ≥ `RANGE_EXPANSION_ATR` × ATR M1.

### Anti-duplicazione

Dopo ogni ordine inviato il worker blocca:

- nuovi ingressi nella **stessa direzione** per `DUP_COOLDOWN_S` secondi;
- nuovi ingressi sullo **stesso setup** per `DUP_SETUP_BARS` candele M1 (inclusa quella dell'ordine).

Restano attive la pausa re-entry `SCALPER_MIN_REENTRY_SEC` (120 s) e tutti i limiti di sessione. Ogni tick di analisi può generare al massimo un ordine.

### Variabili della logica di ingresso

| Variabile | Default | Significato |
| --- | --- | --- |
| `M1_ALIGN_BARS` | 3 | Candele con EMA9/EMA20 M1 allineate per considerare l'M1 direzionale |
| `ACCEL_ATR_MULT` | 1.2 | Range medio delle ultime candele in multipli di ATR M1 |
| `ACCEL_BARS` | 3 | Candele usate per l'accelerazione |
| `ACCEL_BODY_RATIO` | 0.60 | Corpo minimo delle candele di accelerazione |
| `BREAKOUT_LOOKBACK` | 12 | Canale M1 rotto dal momentum breakout |
| `BREAKOUT_BODY_RATIO` | 0.60 | Corpo minimo della candela di rottura |
| `BREAKOUT_CLOSE_ATR_MULT` | 0.15 | Distanza minima della chiusura oltre il livello, in ATR M1 |
| `BREAKOUT_VOL_BARS` / `BREAKOUT_VOL_MULT` | 20 / 1.0 | Media di confronto per l'ampiezza della candela di rottura |
| `RANGE_ATR_MULT` | 1.5 | Ampiezza massima (in ATR M1) del range vero |
| `RANGE_LOOKBACK` | 12 | Candele su cui si misura l'ampiezza |
| `EMA_SLOPE_BARS` / `EMA_FLAT_SLOPE_ATR` | 5 / 0.12 | Soglia di pendenza per considerare piatte le EMA M1 |
| `RANGE_EXPANSION_BARS` / `RANGE_EXPANSION_ATR` | 3 / 1.2 | Espansione che sblocca una compressione breve |
| `DUP_COOLDOWN_S` | 90 | Blocco della stessa direzione dopo un ordine |
| `DUP_SETUP_BARS` | 3 | Candele M1 di blocco dello stesso setup |
| `SCALPER_TICK_LOG_MS` | 1000 | Throttle del log per tick dei setup valutati |

### Log dei setup valutati

A ogni tick il worker scrive su stdout (`[scalper-worker] tick`) e in `scalper_settings.stream_last_decision` l'elenco dei tre setup con esito e motivo dello scarto, invece del solo "Nessun trigger scalper M1". La dashboard mostra il setup usato nell'ultima decisione e la card **Setup valutati** con lo stato di ognuno.

## Streaming

Il worker apre una connessione MetaApi Streaming, attende la sincronizzazione MT5 e sottoscrive XAUUSD. Le quote vengono lette dal `terminalState` locale aggiornato dal WebSocket, senza interrogare MetaApi REST ogni secondo.

Il loop interno controlla il terminal state ogni 250 ms di default. La quota mostrata dalla dashboard viene persistita circa ogni secondo. Quando nasce una nuova candela M1, la candela precedente viene considerata chiusa e viene eseguita la strategia.

Se `AUTO_EXEC=true`, BUY/SELL vengono inviati direttamente tramite la stessa connessione MetaApi Streaming.

L'esecuzione su MT5 avviene **soltanto** nel worker: la dashboard e `/api/generate` si limitano all'analisi. Il segnale prodotto da `/api/generate` viene scritto gia' chiuso (`outcome='SKIPPED'`, `setup` e `reasoning` marcati `manual`) proprio per non essere mai visto dal worker come segnale aperto. Le posizioni si chiudono solo per SL/TP, flatten di fine sessione o STOP TUTTO: non esiste alcuna chiusura per durata.

## Accesso

Tutta la dashboard e tutte le API sono dietro un'unica password (`DASHBOARD_SECRET`).

- Middleware su ogni percorso tranne `/api/health` e `/api/login`: senza cookie valido le pagine vengono reindirizzate a `/login`, le route `/api/*` rispondono `401`.
- `/api/login` confronta la password con `DASHBOARD_SECRET` e imposta un cookie httpOnly + secure valido 30 giorni, firmato HMAC-SHA256 con lo stesso secret.
- `/api/control` e `/api/generate` ricontrollano il cookie anche nella route handler.
- Se `DASHBOARD_SECRET` non e' impostata **tutto** risponde `503 DASHBOARD_SECRET mancante`: nessun fail-open.

Il cookie e' `secure`, quindi in sviluppo su `http://localhost` non viene accettato dal browser: servire in HTTPS (`next dev --experimental-https`) per provare il login in locale.

`/api/cron/analyze` e' anch'essa dietro il cookie: il cron esterno con `CRON_SECRET` non passa piu' dal middleware. Aggiungere `api/cron` alle eccezioni del matcher in `src/middleware.ts` se serve riattivarlo.

## Limiti per sessione

`MAX_TRADES_PER_DAY`, `MAX_DAILY_LOSS` e i cooldown sono calcolati sulla **sessione corrente**, non sul giorno di calendario UTC: la sessione parte dall'orario di apertura di `SCALPER_HOURS_UTC` (con `22:00-20:30` va dalle 22:00 alle 22:00 del giorno dopo). Il conteggio dei trade usa `created_at`, il P/L usa `mt5_profit` dei segnali con `closed_at` dentro la sessione.

`SCALPER_MIN_REENTRY_SEC` (default 120) impone una pausa minima fra la chiusura di una posizione reale e l'apertura successiva; il blocco compare in `stream_last_decision.execution.status` come `reentry_gap`.

## Notifiche Telegram

Con `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` il worker notifica: avvio, apertura, chiusura, blocco per limite o cooldown, errore ordine, flatten di fine sessione e STOP dashboard. Senza le due variabili `sendTelegram` e' un no-op e non lancia mai eccezioni.

## Watchdog

`npm run watchdog` e' un processo one-shot pensato per un cron Railway ogni 5 minuti; termina sempre con exit 0.

- Se `system_stop` e' attivo esce senza fare nulla.
- Se l'heartbeat del worker e' piu' vecchio di `WATCHDOG_MAX_AGE_SEC` (180) manda un allarme Telegram, al massimo uno ogni 30 minuti (`scalper_settings.watchdog_last_alert`).
- Poi legge le posizioni aperte via MetaApi REST (`src/lib/server/watchdogMetaApi.ts`, usato solo dal watchdog) e le chiude se il worker e' morto da piu' di `WATCHDOG_CLOSE_AFTER_SEC` (600) **oppure** mancano meno di 15 minuti alla fine della fascia / si e' oltre `SCALPER_FRIDAY_CLOSE_UTC`. Aggiorna `scalper_signals` e `trades` come il flatten del worker e manda un secondo messaggio con il dettaglio.
- Se il worker e' vivo esce in silenzio.

## Health check

`GET /api/health` non richiede autenticazione: `200 {ok:true, heartbeatAgeSec, status}` se l'heartbeat ha meno di 180 s o `system_stop` e' attivo, altrimenti `503 {ok:false, reason}`.

## Lotti

I lotti di ogni apertura si scelgono dalla dashboard, accanto al bottone STOP: `/api/control` con `{"action":"set_lots","lots":0.03}` scrive `scalper_settings.exec_lots` e il worker li rilegge nel proprio ciclo di controllo. Se la chiave manca o non e' valida si usa `EXEC_LOTS`; il valore viene sempre riportato fra `SCALPER_LOTS_MIN` (0.01) e `SCALPER_LOTS_MAX` (0.10) e arrotondato a 0.01.

Il valore attivo finisce in `scalper_signals.mt5_volume`, in `trades.lot` e in `stream_worker_detail`.

Accanto al selettore la dashboard mostra margine richiesto (`lotti * 100 * prezzo / 500`), perdita allo stop (`lotti * 100 * |entry - SL|` dell'ultimo segnale, 2 $ se non ce n'e' ancora uno) e saldo/margine libero del conto MetaApi.

Se al momento dell'apertura il margine libero del conto e' inferiore al margine richiesto, l'ordine non viene inviato: il segnale viene marcato `SKIPPED` e `stream_last_decision.execution.status` riporta `insufficient_margin`.

## STOP TUTTO

Lo stato è persistente nel database. Quando STOP TUTTO è attivo:

- il worker annulla la sottoscrizione ai dati XAUUSD;
- non analizza nuove candele;
- non genera nuovi ingressi;
- non invia nuovi ordini MT5;
- la dashboard mostra STOP.

Le posizioni già aperte non vengono liquidate dal kill switch e mantengono SL/TP già presenti sul broker.

## Avvio web

```bash
npm install
npm run dev
```

## Avvio worker streaming

Il worker deve essere eseguito su un servizio Node **sempre acceso** (VPS, Render, Railway, Fly.io o equivalente), non come Vercel Function:

```bash
npm install
npm run worker
```

Usare le stesse `DATABASE_URL`, `METAAPI_TOKEN`, `METAAPI_ACCOUNT_ID` e impostazioni scalper del progetto.

`AUTO_EXEC=false` resta il default di sicurezza. Attivarlo solo dopo verifica completa su conto demo.

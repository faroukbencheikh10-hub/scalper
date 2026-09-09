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
- Setup: micro-pullback o liquidity sweep.
- Storico iniziale: 500 M1 e 300 M5, configurabile fino a 1000.
- Stop dinamico 2–5 USD.
- TP predefinito 1.45R.
- Una sola posizione XAUUSD alla volta.
- Cooldown dopo loss; pausa più lunga dopo 3 loss consecutive.
- Filtro spread, ATR M1 e filtro shock.

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

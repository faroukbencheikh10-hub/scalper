# scalper

Progetto standalone XAUUSD, completamente separato da `soldi-trend`.

## Architettura

- **Vercel / Next.js**: dashboard, storico, STOP TUTTO e API di controllo.
- **Worker Node sempre acceso**: `worker/streaming.ts`.
- **MetaApi Streaming/WebSocket**: quote XAUUSD continue e stato MT5 locale.
- **Neon/Postgres**: segnali, risultati, stato worker e kill switch persistente.

Il cron non è più il motore principale. `/api/cron/analyze` resta soltanto come fallback opzionale.

## Strategia

- M1: trigger operativo, valutato tick per tick sull'ultima candela chiusa.
- M5: contesto immediato, non piu' un muro (vedi gate sotto).
- Setup, in ordine di priorita' a ogni tick: `liquidity_sweep` → `momentum_breakout` → `breakout_retest` → `micro_pullback` → NO_TRADE. Vince il primo valido; un solo ordine per tick.
- Storico iniziale: 500 M1 e 300 M5, configurabile fino a 1000.
- Stop dimensionato sull'ATR M1 (vedi sotto), TP sempre proporzionale allo stop.
- **Una sola posizione XAUUSD aperta alla volta** (`SCALPER_MAX_OPEN_POSITIONS=1`).
- Cooldown dopo loss; pausa più lunga dopo 3 loss consecutive; pausa re-entry 120 s.
- **Blocchi dopo una perdita a scadenza**: la direzione appena chiusa in perdita resta ferma `LOSS_LOCK_MINUTES`; dopo `CONSEC_LOSS_COUNT` perdite consecutive nella sessione si ferma tutto per `CONSEC_LOSS_PAUSE_MINUTES`. Il fermo per l'intera sessione resta solo nei limiti giornalieri (`MAX_TRADES_PER_DAY`, `MAX_DAILY_LOSS`).
- Spread massimo, ATR minimo/massimo e SL controllato restano **invariati**.

### SL e TP

Lo stop non viene più preso dal rumore: la distanza è il **massimo** fra tre valori, e non viene mai stretta per rientrare in un limite.

```
distanza SL = max( struttura del setup , SL_ATR_MULT × ATR M1 , SL_MIN_USD )
distanza TP = distanza SL × TP_RR
```

- Se la distanza richiesta supera `SL_MAX_USD` il trade viene **scartato** con motivo "SL troppo ampio" (il setup scelto compare come `rejected` nel log del tick), invece di essere strizzato su un livello che il rumore raggiunge subito.
- Non esiste più alcun TP fisso in dollari né il vecchio clamp `SCALPER_MIN_RISK`/`SCALPER_MAX_RISK`, e `SCALPER_RR` non viene più letto: il rapporto è `TP_RR`.
- Il piano finisce in `stream_last_decision` e nel log `[scalper-worker] order_plan`: struttura, quota ATR, distanza applicata, distanza TP e R:R.

### Rischio per ordine

Prima di ogni invio il worker calcola il rischio dell'ordine come `distanza SL × lotti × 100` (once per lotto). Se supera `RISK_MAX_PCT` del saldo, i lotti dell'ordine scendono a `RISK_FALLBACK_LOTS` (0.01): la size scelta in dashboard non viene sovrascritta, la riduzione vale solo per quell'ordine ed è segnalata come `lotsCapped`.

Il rischio calcolato compare nel log `order_plan`, in `stream_last_decision.risk`, sulla dashboard (righe *SL / TP ultimo ordine* e *Rischio ultimo ordine*) e nel messaggio Telegram di apertura. L'importo è nominale in valuta del conto: non viene applicata alcuna conversione FX fra il dollaro della quotazione XAUUSD e l'euro del conto.

### Gate M5 e direzionalità M1

- **M5 contrario** alla direzione dell'M1: blocco sempre, per tutti i setup.
- **M5 allineato**: `micro_pullback` BUY con trend M5 rialzista, SELL con ribassista, come prima.
- **M5 neutro**: il `micro_pullback` passa solo con M1 forte — EMA9/EMA20 M1 allineate da almeno `M1_ALIGN_BARS` candele, prezzo dal lato giusto di entrambe e accelerazione reale (ultime `ACCEL_BARS` candele nella stessa direzione, range medio ≥ `ACCEL_ATR_MULT` × ATR M1, corpi ≥ `ACCEL_BODY_RATIO` del range). Gli altri setup portano le proprie conferme e con M5 neutro passano senza il requisito di accelerazione.

### momentum_breakout

Rottura del massimo/minimo delle ultime `BREAKOUT_LOOKBACK` candele M1 (10–15 consigliato) con candela di rottura a corpo ≥ `BREAKOUT_BODY_RATIO` del range, chiusura oltre il livello di almeno `BREAKOUT_CLOSE_ATR_MULT` × ATR M1, EMA9 > EMA20 (long) o viceversa, spread e ATR validi. La candela di rottura è l'ultima M1 chiusa: l'ingresso cade sulla candela successiva, con SL sotto/sopra la candela di rottura. Il prezzo deve essere ancora oltre il livello al momento dell'ingresso.

### breakout_retest

L'ingresso diretto sulla candela shock (range > `SHOCK_ATR_MULT` × ATR M1, minimo 5.50 $) resta scartato, ma il movimento non viene perso: entro `RETEST_MAX_BARS` candele dalla shock, se il prezzo ritraccia verso il livello rotto **o** l'EMA9 M1 (entro `RETEST_ZONE_ATR` × ATR) senza chiudere dall'altra parte del livello, e poi riparte nella direzione della shock con corpo ≥ `RETEST_BODY_RATIO` e chiusura dal lato giusto dell'EMA9, si entra al riavvio. SL oltre il minimo (long) o il massimo (short) del retest.

### Anti-accumulo

Al posto del vecchio `compressed OR choppy` si blocca solo il **range sporco**: ampiezza delle ultime `RANGE_LOOKBACK` candele M1 sotto `RANGE_ATR_MULT` × ATR M1 **e** EMA9/EMA20 M1 piatte (variazione ≤ `EMA_FLAT_SLOPE_ATR` × ATR su `EMA_SLOPE_BARS` candele). Se c'è accelerazione M1 reale (stessa definizione del gate M5) il filtro non blocca mai.

### Anti-duplicazione

Dopo ogni ordine inviato: stessa direzione bloccata per `DUP_COOLDOWN_S` secondi, stesso setup per `DUP_SETUP_BARS` candele M1 (inclusa quella dell'ordine). Restano attive la pausa re-entry `SCALPER_MIN_REENTRY_SEC` e tutti i limiti di sessione.

### Variabili della logica di ingresso

| Variabile | Default | Significato |
| --- | --- | --- |
| `M1_ALIGN_BARS` | 3 | Candele con EMA9/EMA20 M1 allineate per considerare l'M1 direzionale |
| `ACCEL_ATR_MULT` | 1.2 | Range medio delle ultime candele in multipli di ATR M1 |
| `ACCEL_BARS` / `ACCEL_BODY_RATIO` | 3 / 0.60 | Candele e corpo minimo dell'accelerazione |
| `BREAKOUT_LOOKBACK` | 12 | Canale M1 rotto dal momentum breakout |
| `BREAKOUT_BODY_RATIO` | 0.60 | Corpo minimo della candela di rottura |
| `BREAKOUT_CLOSE_ATR_MULT` | 0.15 | Distanza minima della chiusura oltre il livello, in ATR M1 |
| `SHOCK_ATR_MULT` | 2.2 | Soglia della candela shock (minimo assoluto 5.50 $) |
| `RETEST_MAX_BARS` | 4 | Candele entro cui il retest deve completarsi |
| `RETEST_ZONE_ATR` / `RETEST_BODY_RATIO` | 0.50 / 0.50 | Ampiezza della zona di retest e corpo minimo del riavvio |
| `RANGE_ATR_MULT` | 1.5 | Ampiezza massima (in ATR M1) del range sporco |
| `RANGE_LOOKBACK` | 12 | Candele su cui si misura l'ampiezza |
| `EMA_SLOPE_BARS` / `EMA_FLAT_SLOPE_ATR` | 5 / 0.12 | Soglia di pendenza per considerare piatte le EMA M1 |
| `SL_ATR_MULT` | 1.3 | Quota ATR M1 della distanza di stop |
| `SL_MIN_USD` / `SL_MAX_USD` | 3.0 / 8.0 | Distanza SL minima e massima; oltre il massimo il trade viene scartato |
| `TP_RR` | 1.5 | Rapporto TP/SL |
| `RISK_MAX_PCT` / `RISK_FALLBACK_LOTS` | 6 / 0.01 | Rischio massimo per ordine in % del saldo e lotti di ripiego |
| `DUP_COOLDOWN_S` | 90 | Blocco della stessa direzione dopo un ordine |
| `DUP_SETUP_BARS` | 3 | Candele M1 di blocco dello stesso setup |
| `SCALPER_MAX_OPEN_POSITIONS` | 1 | Posizioni XAUUSD aperte contemporaneamente |
| `LOSS_LOCK_MINUTES` | 30 | Blocco della stessa direzione dopo una chiusura in perdita |
| `CONSEC_LOSS_COUNT` / `CONSEC_LOSS_PAUSE_MINUTES` | 3 / 120 | Perdite consecutive che fermano tutto e durata della pausa |
| `SCALPER_LOSS_LOCK_REFRESH_MS` | 30000 | Rilettura periodica delle chiusure per i blocchi da perdita |
| `SCALPER_TICK_LOG_MS` | 1000 | Throttle del log per tick dei setup valutati |

### Log dei setup valutati

A ogni tick il worker scrive su stdout (`[scalper-worker] tick`) e in `scalper_settings.stream_last_decision` l'elenco dei quattro setup con esito e motivo dello scarto, invece del solo "Nessun trigger scalper M1". Il setup finisce in `scalper_signals.setup`, nella colonna `trades.setup` (oltre che in `trades.payload`), nel messaggio Telegram di apertura e sulla dashboard, che mostra il setup usato e la card **Setup valutati**.

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

Dopo una chiusura in perdita il worker blocca la **stessa direzione** per `LOSS_LOCK_MINUTES` (default 30) a partire dall'orario di chiusura, e dopo `CONSEC_LOSS_COUNT` (3) perdite consecutive nella sessione mette in pausa **tutti** gli ingressi per `CONSEC_LOSS_PAUSE_MINUTES` (120). Entrambi i blocchi scadono da soli e vengono ricalcolati all'avvio, a ogni chiusura e ogni `SCALPER_LOSS_LOCK_REFRESH_MS`.

L'orario di sblocco compare ovunque: in `stream_last_decision.reasoning`, in `stream_worker_detail` (`lossLockedDirections`, `lossLockUntil`, `lossPauseUntil`), sulla dashboard (card Esecuzione, righe *Re-entry bloccato* e *Pausa perdite*) e su Telegram, sia nel messaggio di chiusura in perdita sia nella notifica di ingresso bloccato.

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

## Scenari sintetici

`npm run scenarios` esegue `scripts/strategy-scenarios.ts`: costruisce serie M1/M5 sintetiche e verifica priorità dei setup, gate M5, anti-accumulo, breakout retest e dimensionamento SL/TP (compresi i casi "SL strutturale sotto ATR" e "SL oltre il massimo"). Non tocca MetaApi né il database.

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

# scalper

Progetto standalone XAUUSD, completamente separato da `soldi-trend`.

## Architettura

- **Vercel / Next.js**: dashboard, storico, STOP TUTTO e API di controllo.
- **Worker Node sempre acceso**: `worker/streaming.ts`.
- **MetaApi Streaming/WebSocket**: quote XAUUSD continue e stato MT5 locale.
- **Neon/Postgres**: segnali, risultati, stato worker e kill switch persistente.

Il cron non è più il motore principale. `/api/cron/analyze` resta soltanto come fallback opzionale.

## Due setup in cascata

A ogni tick i setup vengono valutati in cascata — **mtf-continuation-v1** → **`m1_short`** → **`m1_range`** — e vince il primo che produce un ordine; la posizione aperta resta comunque una sola. Prima viene valutata la mtf (M15 → M5 → M1, descritta sotto). Solo se non produce nulla viene valutato il secondo setup **`m1_short`** (`m1-short-v1`), che guarda soltanto l'M1:

- **Entry:** chiusura M1 fuori dal range delle ultime `SHORT_RANGE_BARS` (8) candele M1, nella direzione dell'EMA20 M1 — chiusura sopra l'EMA20 solo BUY, sotto solo SELL.
- **SL:** `SHORT_SL_ATR` (2.0) × ATR M1, alzato a `SHORT_SL_MIN_USD` (3$); se la distanza richiesta supera `SHORT_SL_MAX_USD` (8$) il trade viene **scartato**, non stretto.
- **TP:** `SHORT_TP_ATR` (0.6) × ATR M1 dentro `SHORT_TP_MIN_USD`–`SHORT_TP_MAX_USD` (1.5–3$), **indipendente dallo SL**: il rapporto R:R è quindi minore di 1 per costruzione. Nessun breakeven e nessun quick profit.
- **Comuni alla mtf e invariati:** spread massimo, candela shock, ATR M1 dentro i limiti, pausa re-entry 120 s, `LOSS_LOCK_MINUTES`, `CONSEC_LOSS_PAUSE_MINUTES`, una sola posizione aperta, flatten di fine sessione, STOP, watchdog, Telegram e lotti da `exec_lots` senza cap di rischio.
- I suoi trade finiscono con `setup = "m1_short"` in `scalper_signals` e in `trades`; la valutazione con i numeri (range, EMA20, ATR, SL, TP) compare in `stream_last_decision.evaluations` come voce `m1_gate`, accanto a `m15_gate`, e la card **Setup valutati** della dashboard mostra entrambe.
- `SHORT_ENABLED=false` lascia attiva solo la mtf.

Se nemmeno il `m1_short` produce un ordine viene valutato il terzo setup **`m1_range`** (`m1-range-v1`), che compra i rientri dal bordo di un range M1 largo:

- **Range:** massimo/minimo delle ultime `RANGE_BARS` (8) candele M1 **chiuse**. Il setup è attivo solo se l'ampiezza vale almeno `RANGE_MIN_ATR` (1.5) × ATR M1 **e** almeno `RANGE_MIN_USD` (3$): un range stretto non è un setup.
- **Entry (su tick):** BUY quando il prezzo live è dentro il range ed entro `RANGE_EDGE_PCT` (20%) dell'ampiezza dal minimo, con l'ultima M1 chiusa **verde**; SELL speculare vicino al massimo con l'ultima M1 chiusa **rossa**. Il confronto usa il prezzo che pagheresti (ask sui long, bid sugli short) e non aspetta la chiusura della candela in corso.
- **SL:** oltre il bordo del range più `SL_BUFFER_USD` (0.30$), con minimo `RANGE_SL_MIN_ATR` (1.0) × ATR M1; sopra `RANGE_SL_MAX_USD` (8$) il trade viene **scartato**.
- **TP:** lato opposto del range meno `TP_BUFFER_USD` (0.30$). Se la distanza disponibile è sotto `RANGE_TP_MIN_USD` (1.5$) il trade viene **scartato**, invece di spostare il target oltre il range. Nessun breakeven, nessun quick profit.
- **Anti-accumulo:** non si applica a questo setup, qui il range è il setup e non un ostacolo. Spread, candela shock, ATR M1 e tutti i blocchi comuni restano.
- Un tentativo per bordo: `setup_key` porta bordo e ultima M1 chiusa (`level_used`), quindi il bordo si riarma solo quando chiude una nuova M1 e nasce un nuovo range.
- I trade escono con `setup = "m1_range"` e la valutazione numerica (range, ATR, distanza dal bordo, SL, TP) compare come voce `range_gate` in `stream_last_decision.evaluations` e nella card **Setup valutati**.
- `RANGE_ENABLED=false` lo spegne.

## Strategia M15 / M5 / M1

Versione: `mtf-continuation-v1`. Una sola strategia di continuazione, simmetrica BUY/SELL. Il worker decide ed esegue; le API web fanno soltanto analisi e controllo.

- **M15 — contesto:** 30 candele complete minime, aggregate da tre M5 chiuse consecutive e allineate UTC. EMA9/21, pendenza e massimi/minimi di due blocchi consecutivi di tre M15 devono indicare la stessa direzione, con efficienza delle ultime otto chiusure almeno 0.35: questo resta il trend M15 confermato.
- **M15 non confermato (`M15_TREND_MODE`):** con `strict` il tick viene scartato come prima. Con `soft` (default) il filtro non blocca da solo:
  - **range vero → NO_TRADE**: la banda delle ultime 12 M15 vale meno di `M15_RANGE_BAND_ATR` ATR15 **e** il prezzo è dentro la banda (con margine `M15_RANGE_EDGE` dai bordi). È l'unico caso di blocco, il motivo riporta banda, ATR15 e prezzo.
  - **transizione → decide il bias M5**: serve struttura HH/HL (BUY) o LL/LH (SELL) confrontando le due metà delle ultime `M15_BIAS_M5_BARS` candele M5, con il prezzo dal lato giusto della EMA20 M5. Senza struttura il tick viene scartato con i valori numerici del confronto.

  L'esito del gate finisce in `stream_last_decision.evaluations` come `m15_gate` (per esempio `"M15 transizione, M5 bias BUY ok: M5 20 candele: max … vs …, min … vs …, prezzo … vs EMA20 M5 …"`) e resta visibile anche quando il tick viene poi scartato più a valle.
- **M5 — setup:** impulso direzionale, seguito da almeno una candela di ritracciamento realmente contraria. Il rientro deve toccare la zona del livello rotto (`breakout_retest`) oppure EMA9 M5 (`micro_pullback`), mantenendo la struttura. Il setup scade dopo sei M5 senza ingresso.
- **M1 — conferma:** candela chiusa nella direzione M15, corpo almeno 45%, chiusura oltre gli estremi delle due M1 precedenti. Niente ingresso su candela incompleta, shock o movimento già esteso. La valutazione avviene ad ogni quote, ma una candela in formazione non crea conferme.
- **Dati:** quote fresche, candele valide e ordinate, niente riempimento artificiale dei buchi. Le ultime 15 M1, 10 M5 e 8 M15 devono essere consecutive. Dopo un gap delle quote superiore a un minuto il worker ricarica lo storico. M15 non richiede una terza chiamata dati. Il buffer M5 ha minimo 120 candele.
- **SL:** oltre gli estremi del pullback M5 e della microstruttura M1, con buffer spread/ATR. Distanza = max(struttura, 1.3 ATR M1, 3 USD di prezzo), massimo 8 USD di prezzo. Lo stop non viene stretto per far passare un setup.
- **TP:** massimo 2R, limitato dal prossimo estremo dell'impulso o pivot confermato M5/M15 davanti all'ingresso. Occorre almeno 1.5R netto stimato dopo commissioni/slippage. Un ostacolo vicino fa scartare il trade, non viene ignorato per allontanare il target. Nessuna chiusura a importo fisso.
- **Costi:** bid/ask includono già lo spread nell'ingresso; si aggiungono una stima di commissione round trip (7 USD per lotto, parametrica) e slippage (0.05 ATR M1). Queste sono ipotesi di filtro, non tariffe broker verificate né garanzie di esecuzione.
- **Un ingresso per setup:** identità persistente di impulso e primo pullback M5. La funzione di analisi è pura: preview e preflight non consumano il setup. La prenotazione DB è esclusiva; gli SKIPPED e i rifiuti broker definitivi la liberano. Gli ordini accettati, chiusi o con esito incerto la conservano anche dopo riavvio. Un timeout viene riconciliato mediante clientId su posizioni/deal streaming; mentre resta irrisolto blocca nuove aperture.

Restano i limiti di sessione, STOP, numero di posizioni e pause configurate. Nessuna inversione automatica della posizione e nessun trade per il solo breakout M1.

### Parametri della strategia

| Variabile | Default | Significato |
| --- | --- | --- |
| `MTF_M15_MIN_SEP_ATR` | 0.08 | Separazione EMA9/21 M15 in ATR |
| `MTF_M15_MIN_EFFICIENCY` | 0.35 | Efficienza direzionale M15 |
| `M15_TREND_MODE` | soft | `strict` = solo trend M15 confermato, `soft` = bias M5 in transizione |
| `M15_RANGE_BAND_ATR` | 3.0 | Banda 12 M15 (in ATR15) sotto cui è range vero |
| `M15_RANGE_EDGE` | 0.15 | Margine dai bordi della banda per dire "prezzo dentro" |
| `M15_BIAS_M5_BARS` | 20 | Candele M5 confrontate per la struttura HH/HL o LL/LH |
| `SHORT_ENABLED` | true | Abilita il secondo setup `m1_short` |
| `SHORT_RANGE_BARS` | 8 | Candele M1 del range da rompere |
| `SHORT_SL_ATR` | 2.0 | SL del m1_short in ATR M1 |
| `SHORT_SL_MIN_USD` / `SHORT_SL_MAX_USD` | 3.0 / 8.0 | SL alzato al minimo; oltre il massimo il trade viene scartato |
| `SHORT_TP_ATR` | 0.6 | TP del m1_short in ATR M1 |
| `SHORT_TP_MIN_USD` / `SHORT_TP_MAX_USD` | 1.5 / 3.0 | Limiti del TP, indipendenti dallo SL |
| `RANGE_ENABLED` | true | Abilita il terzo setup `m1_range` |
| `RANGE_BARS` | 8 | Candele M1 chiuse che definiscono il range |
| `RANGE_MIN_ATR` / `RANGE_MIN_USD` | 1.5 / 3.0 | Ampiezza minima del range, in ATR M1 e in dollari |
| `RANGE_EDGE_PCT` | 20 | Distanza massima dal bordo, in percentuale dell'ampiezza |
| `SL_BUFFER_USD` / `TP_BUFFER_USD` | 0.30 / 0.30 | Margine oltre il bordo per lo SL e dentro il lato opposto per il TP |
| `RANGE_SL_MIN_ATR` / `RANGE_SL_MAX_USD` | 1.0 / 8.0 | SL minimo in ATR M1 e massimo in dollari (oltre si scarta) |
| `RANGE_TP_MIN_USD` | 1.5 | TP minimo: sotto questa distanza il trade viene scartato |
| `MTF_M5_SETUP_BARS` | 6 | Validità dell'impulso in M5 |
| `MTF_M5_ZONE_ATR` | 0.30 | Tolleranza della zona di rientro in ATR M5 |
| `MTF_M1_BODY_MIN` | 0.45 | Corpo minimo della conferma M1 |
| `MTF_MAX_CHASE_ATR` | 0.45 | Massima estensione dal close di conferma in ATR M1 |
| `MTF_MAX_SPREAD_RISK` | 0.20 | Spread massimo rispetto al rischio sul prezzo |
| `MTF_MIN_NET_RR` / `MTF_TARGET_RR` | 1.5 / 2 | R netto stimato minimo / obiettivo massimo |
| `MTF_ROUNDTRIP_COMMISSION_PER_LOT_USD` | 7 | Stima costi round trip per lotto standard XAUUSD |
| `MTF_SLIPPAGE_ATR` | 0.05 | Stima slippage in ATR M1 |
| `SL_ATR_MULT` / `SL_MIN_USD` / `SL_MAX_USD` | 1.3 / 3 / 8 | Dimensionamento SL sul prezzo |
| `SHOCK_ATR_MULT` | 2.2 | Shock M1 in multipli di ATR |

Le vecchie variabili `SCALPER_QUICK_PROFIT`, `SCALPER_RR`, `TP_RR`, `ACCEL_*`, `CLEAN_LEG_*`, `BREAKOUT_*`, `RETEST_*` e `RANGE_*` non governano questa strategia. La vecchia logica resta nella cronologia Git.

### Rischio per ordine

I lotti restano quelli della dashboard. Quando `RISK_MAX_PCT > 0`, il rischio di prezzo allo stop viene calcolato da tickSize e lossTickValue del broker, come nel calcolo P/L del SDK; sopra il cap si prova `RISK_FALLBACK_LOTS`. Se anche il volume ridotto supera il cap, oppure saldo/tick value non sono disponibili, l'ordine viene scartato. Questo è un limite sul rischio di prezzo stimato: gap, commissioni e slippage possono aumentare la perdita effettiva.

Con `RISK_MAX_PCT=0` il cap è disattivato. Se i tick value non sono disponibili, il rischio mostrato è esplicitamente una stima USD e non viene presentato come euro. I dati dei tick sono descritti nella [documentazione MetaApi](https://metaapi.cloud/docs/client/models/metatraderSymbolPrice/).

La strategia è verificata su scenari sintetici di correttezza, non validata come redditizia. Prima di ottimizzare i parametri occorre un replay dei dati broker con costi reali, periodi fuori campione e risultati separati BUY/SELL e per sessione.

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

Il conteggio esclude i **doppioni**: due ordini con lo stesso setup e la stessa direzione a meno di `TRADE_DEDUP_SECONDS` (30) l'uno dall'altro contano come un trade solo, così una raffica ravvicinata non consuma il budget della sessione. La deduplica vale sia nella prenotazione del segnale sia nel controllo dei limiti.

`SCALPER_MIN_REENTRY_SEC` (default 120) impone una pausa minima fra la chiusura di una posizione reale e l'apertura successiva, **qualunque sia l'esito** (WIN, LOSS o BREAKEVEN). La pausa è applicata in due punti:

- nel worker, appena una posizione sparisce dal terminal state MetaApi: il conto alla rovescia parte subito, senza attendere che la chiusura venga scritta a database (lo storico deal può essere in throttling o backoff);
- nella prenotazione del segnale, sull'ultima `closed_at` registrata: il blocco compare in `stream_last_decision.execution.status` come `reentry_gap`.

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

STOP TUTTO richiede al worker la chiusura delle posizioni XAUUSD e la cancellazione degli ordini sul simbolo, oltre a bloccare gli ingressi. Un normale deploy non cambia SL/TP delle posizioni già aperte.

## Scenari sintetici

`npm run scenarios` esegue scenari deterministici offline (mtf con `SHORT_ENABLED=false`, più un blocco dedicato al `m1_short`) per BUY/SELL, M15 in range, M5 pullback/retest, conferma M1, dati mancanti, costi, stop, ripetizione dei preflight, recupero ordini e rischio con tick value. Non chiama MetaApi né il database.

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


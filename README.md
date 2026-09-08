# scalper

Progetto standalone XAUUSD, separato da `soldi-trend`.

## Strategia
- M1: trigger operativo
- M5: contesto immediato
- setup: micro-pullback o liquidity sweep
- stop dinamico 2–5 USD (configurabile)
- TP predefinito 1.45R
- time-stop 12 minuti
- una sola posizione XAUUSD alla volta
- cooldown dopo loss; pausa più lunga dopo 3 loss consecutive
- filtro spread e filtro shock M1

## Esecuzione
MetaApi REST -> MT5. Il `clientId` usa `SC_XAUUSD_<id>`.

## Avvio
1. Creare un database Neon dedicato a `scalper`.
2. Copiare `.env.example` in `.env.local` e compilare le variabili.
3. `npm install`
4. `npm run dev`
5. Configurare cron-job.org ogni minuto su `/api/cron/analyze?secret=...`.

`AUTO_EXEC=false` è il default di sicurezza. Attivarlo solo dopo verifica in demo.

import { randomBytes } from "node:crypto";
import { dbQuery, ensureSchema, getSetting, setSetting, systemStopActive } from "./db";
import { autoExecEnabled, clampLots, lots } from "./tradingConfig";
import { requiredMargin } from "@/lib/lots";
import { sessionWindowStart } from "@/lib/session";
import { deals, symbol } from "./metaApi";
import { definitelyRejected, recoverOrder, type RecoveryDeal } from "./orderSafety";
import { closeReasonFromPrice, countsAsLoss, isManagedSetup, sltpCloseReasonFromPrice } from "./positionManager";

type StreamPosition = {
  id: string;
  symbol: string;
  openPrice: number;
  volume?: number;
  clientId?: string;
  type?: string;
};

export type StreamAccountInformation = {
  balance?: number;
  equity?: number;
  margin?: number;
  freeMargin?: number;
  marginLevel?: number;
  leverage?: number;
  currency?: string;
};

type StreamTerminalState = {
  positions: StreamPosition[];
  accountInformation?: StreamAccountInformation;
};

export type StreamingConnectionLike = {
  historyStorage?: { deals: RecoveryDeal[] };
  terminalState: StreamTerminalState;
  createMarketBuyOrder: (symbol: string, volume: number, stopLoss?: number, takeProfit?: number, options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  createMarketSellOrder: (symbol: string, volume: number, stopLoss?: number, takeProfit?: number, options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  closePosition: (positionId: string) => Promise<Record<string, unknown>>;
};

type SyncOptions = {
  schemaReady?: boolean;
  systemStopped?: boolean;
};

type ExecuteOptions = {
  schemaReady?: boolean;
  skipSync?: boolean;
  systemStopped?: boolean;
  preflightDone?: boolean;
  /** Lotti attivi scelti dalla dashboard; senza valore si usa EXEC_LOTS. */
  lots?: number;
  /** Prezzo corrente usato per stimare il margine richiesto. */
  price?: number;
};

type ReserveSignalInput = {
  setupKey: string;
  direction: "BUY" | "SELL";
  setup: string | null;
  entry: number;
  stopLoss: number;
  /** Livello obiettivo: TP inviato al broker per la mtf, target1 interno per i setup gestiti. */
  takeProfit: number;
  riskReward: number;
  reasoning: string;
  openPositionCount: number;
  /** Contesto M5/M15 letto all'ingresso, salvato con il segnale. */
  context?: unknown;
  /** TP di sicurezza mandato al broker, distinto da takeProfit/target1. */
  tpBroker?: number | null;
};

type DealHistory = Awaited<ReturnType<typeof deals>>;

export type StreamClosure = {
  signalId: string;
  positionId: string;
  outcome: "WIN" | "LOSS" | "BREAKEVEN";
  profit: number;
  openPrice: number;
  closePrice: number;
  resultR: number;
  /** sl_initial | sl_breakeven | sl_trailing per i setup gestiti, null per la mtf. */
  closeReason: string | null;
};

const historyAttemptAt = new Map<string, number>();
let historyBackoffUntil = 0;
let historyBackoffLoaded = false;
let historyErrorActive = false;

function envN(name: string, fallback: number, min = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function maxOpenPositions() {
  return Math.min(3, Math.max(1, Math.floor(envN("SCALPER_MAX_OPEN_POSITIONS", 1, 1))));
}

function minReentrySec() {
  return envN("SCALPER_MIN_REENTRY_SEC", 120, 0);
}

/**
 * Finestra entro cui due ordini con stesso setup e stessa direzione contano come un solo trade
 * nel limite giornaliero: i doppioni ravvicinati non consumano il budget della sessione.
 */
function tradeDedupSec() {
  return envN("TRADE_DEDUP_SECONDS", 30, 0);
}

function historyRetryMs() {
  return envN("SCALPER_HISTORY_RETRY_SEC", 30, 10) * 1000;
}

function historyBackoffMs() {
  return envN("SCALPER_HISTORY_BACKOFF_MIN", 15, 1) * 60_000;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isHistoryRateLimit(error: unknown) {
  const message = errorText(error);
  return message.includes("429") || message.includes("TooManyRequestsError") || message.includes("cpu credits per 6h");
}

async function loadHistoryBackoff() {
  if (historyBackoffLoaded) return;
  historyBackoffLoaded = true;
  const saved = await getSetting("metaapi_history_backoff_until");
  if (!saved) return;
  const parsed = Date.parse(saved);
  historyErrorActive = true;
  if (Number.isFinite(parsed) && parsed > Date.now()) historyBackoffUntil = parsed;
}

async function setHistoryRateLimitBackoff(error: unknown) {
  const until = Math.max(historyBackoffUntil, Date.now() + historyBackoffMs());
  historyBackoffUntil = until;
  historyErrorActive = true;
  const untilIso = new Date(until).toISOString();
  const at = new Date().toISOString();
  await Promise.all([
    setSetting("metaapi_history_backoff_until", untilIso),
    setSetting("stream_last_error", `${at} MetaApi storico in pausa fino a ${untilIso}: 429 getDealsByPosition`),
  ]);
  console.warn("[scalper-worker] history_backoff", { until: untilIso, error: errorText(error) });
}

async function clearHistoryErrorAfterRecovery() {
  if (!historyErrorActive) return;
  historyErrorActive = false;
  historyBackoffUntil = 0;
  const current = await getSetting("stream_last_error");
  await setSetting("metaapi_history_backoff_until", "");
  if (current && (current.includes("getDealsByPosition") || current.includes("MetaApi storico in pausa"))) {
    await setSetting("stream_last_error", "");
  }
}

async function fetchHistoryThrottled(positionId: string) {
  await loadHistoryBackoff();
  const now = Date.now();
  if (historyBackoffUntil > now) {
    return { status: "backoff" as const, history: [] as DealHistory };
  }
  if (historyBackoffUntil > 0) historyBackoffUntil = 0;

  const lastAttempt = historyAttemptAt.get(positionId) ?? 0;
  if (now - lastAttempt < historyRetryMs()) {
    return { status: "throttled" as const, history: [] as DealHistory };
  }
  historyAttemptAt.set(positionId, now);

  try {
    const history = await deals(positionId);
    await clearHistoryErrorAfterRecovery();
    return { status: "ok" as const, history };
  } catch (error) {
    if (isHistoryRateLimit(error)) {
      await setHistoryRateLimitBackoff(error);
      return { status: "backoff" as const, history: [] as DealHistory };
    }
    console.warn("[scalper-worker] history_lookup_error", { positionId, error: errorText(error) });
    return { status: "error" as const, history: [] as DealHistory };
  }
}

function positionDirection(position: StreamPosition): "BUY" | "SELL" | null {
  const type = String(position.type ?? "").toUpperCase();
  if (type.includes("BUY")) return "BUY";
  if (type.includes("SELL")) return "SELL";
  return null;
}

function shortClientId() {
  return `SC_XAU_${randomBytes(4).toString("hex")}`;
}

async function limits() {
  const start = sessionWindowStart();
  const [daily, last] = await Promise.all([
    dbQuery(
      `WITH orders AS (
         SELECT created_at,
                lag(created_at) OVER (PARTITION BY COALESCE(setup,''),direction ORDER BY created_at) AS prev_at
           FROM scalper_signals
          WHERE mt5_order_id IS NOT NULL AND created_at >= $1::timestamptz
       )
       SELECT (SELECT COUNT(*) FROM orders
                WHERE prev_at IS NULL OR created_at - prev_at >= ($2::float8 * interval '1 second')) trades,
              (SELECT COALESCE(SUM(mt5_profit),0) FROM scalper_signals WHERE closed_at >= $1::timestamptz) profit`,
      [start.toISOString(), tradeDedupSec()],
    ),
    dbQuery(`SELECT outcome,close_reason,mt5_profit,closed_at FROM scalper_signals WHERE outcome IS NOT NULL ORDER BY closed_at DESC LIMIT 3`),
  ]);

  const trades = Number(daily.rows[0]?.trades ?? 0);
  const profit = Number(daily.rows[0]?.profit ?? 0);
  if (trades >= envN("MAX_TRADES_PER_DAY", 12, 1)) return { ok: false, reason: "max_trades_per_day" };
  if (profit <= -envN("MAX_DAILY_LOSS", 150, 0)) return { ok: false, reason: "max_daily_loss" };

  // Le uscite gestite (breakeven, trailing, flatten, stop, watchdog) non sono perdite.
  const losses = last.rows.filter((row: { outcome?: string; close_reason?: string; mt5_profit?: unknown }) =>
    countsAsLoss(row.outcome, row.close_reason, row.mt5_profit));
  if (losses.length >= 3 && last.rows[0]?.closed_at) {
    const t = Date.parse(last.rows[0].closed_at);
    if (Date.now() - t < envN("SCALPER_THREE_LOSS_COOLDOWN_MIN", 30, 1) * 60_000) {
      return { ok: false, reason: "three_loss_cooldown" };
    }
  } else if (countsAsLoss(last.rows[0]?.outcome, last.rows[0]?.close_reason, last.rows[0]?.mt5_profit) && last.rows[0]?.closed_at) {
    const t = Date.parse(last.rows[0].closed_at);
    if (Date.now() - t < envN("SCALPER_LOSS_COOLDOWN_MIN", 5, 1) * 60_000) {
      return { ok: false, reason: "loss_cooldown" };
    }
  }
  return { ok: true, reason: null };
}

export async function reserveStreamingSignal(input: ReserveSignalInput) {
  if (!input.setupKey) return { ok: false as const, status: "blocked" as const, reason: "missing_setup_key" };
  const positionLimit = maxOpenPositions();
  if (input.openPositionCount >= positionLimit) {
    return { ok: false as const, status: "blocked" as const, reason: "max_open_positions" };
  }

  const start = sessionWindowStart();
  const maxTrades = envN("MAX_TRADES_PER_DAY", 12, 1);
  const maxDailyLoss = envN("MAX_DAILY_LOSS", 150, 0);
  const threeLossCooldown = envN("SCALPER_THREE_LOSS_COOLDOWN_MIN", 30, 1);
  const lossCooldown = envN("SCALPER_LOSS_COOLDOWN_MIN", 5, 1);

  const result = await dbQuery(
    `WITH lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(209260908)
     ),
     daily_orders AS (
       SELECT created_at,
              lag(created_at) OVER (PARTITION BY COALESCE(setup,''),direction ORDER BY created_at) AS prev_at
         FROM scalper_signals, lock
        WHERE mt5_order_id IS NOT NULL AND created_at >= $12::timestamptz
     ),
     daily AS (
       -- I doppioni (stesso setup e direzione entro $14 secondi da un altro ordine) contano una volta sola.
       SELECT (SELECT COUNT(*) FROM daily_orders
                WHERE prev_at IS NULL OR created_at - prev_at >= ($14::float8 * interval '1 second'))::int AS trades,
              COALESCE(SUM(mt5_profit) FILTER (WHERE closed_at >= $12::timestamptz),0)::float8 AS profit
         FROM scalper_signals
        WHERE created_at >= $12::timestamptz OR closed_at >= $12::timestamptz
     ),
     last_close AS (
       SELECT MAX(closed_at) AS at
         FROM scalper_signals
        WHERE closed_at IS NOT NULL AND mt5_position_id IS NOT NULL
     ),
     recent AS MATERIALIZED (
       -- Conta come perdita solo lo stop iniziale chiuso in perdita: le uscite gestite no.
       SELECT (outcome='LOSS' AND COALESCE(close_reason,'sl_initial')='sl_initial'
               AND COALESCE(mt5_profit,-1) < 0) AS is_loss,
              closed_at,row_number() OVER (ORDER BY closed_at DESC) AS rn
         FROM scalper_signals
        WHERE outcome IS NOT NULL
        ORDER BY closed_at DESC
        LIMIT 3
     ),
     recent_summary AS (
       SELECT COUNT(*) FILTER (WHERE is_loss)::int AS recent_losses,
              bool_or(is_loss) FILTER (WHERE rn=1) AS latest_is_loss,
              MAX(closed_at) FILTER (WHERE rn=1) AS latest_closed_at
         FROM recent
     ),
     control AS (
       SELECT COALESCE((SELECT value='true' FROM scalper_settings WHERE key='system_stop'), false) AS stopped,
              EXISTS(SELECT 1 FROM scalper_signals WHERE setup_key=$15
                AND COALESCE(outcome,'') NOT IN ('ERROR','SKIPPED')) AS same_setup,
              EXISTS(SELECT 1 FROM scalper_signals WHERE outcome IS NULL
                AND client_id IS NOT NULL AND mt5_position_id IS NULL) AS unresolved_order,
              (SELECT id::text FROM scalper_signals
                WHERE created_at >= date_trunc('minute', now())
                  AND direction IN ('BUY','SELL')
                  AND COALESCE(outcome,'') NOT IN ('ERROR','SKIPPED')
                ORDER BY created_at DESC LIMIT 1) AS same_minute_signal_id
         FROM lock
     ),
     decision AS (
       SELECT CASE
         WHEN control.stopped THEN 'system_stopped'
         WHEN control.unresolved_order THEN 'unresolved_order'
         WHEN control.same_setup THEN 'same_setup_signal'
         WHEN control.same_minute_signal_id IS NOT NULL THEN 'same_minute_signal'
         WHEN daily.trades >= $8::int THEN 'max_trades_per_day'
         WHEN daily.profit <= -$9::float8 THEN 'max_daily_loss'
         WHEN recent_summary.recent_losses >= 3
              AND recent_summary.latest_closed_at IS NOT NULL
              AND EXTRACT(EPOCH FROM (now() - recent_summary.latest_closed_at)) < $10::float8 * 60
           THEN 'three_loss_cooldown'
         WHEN recent_summary.latest_is_loss
              AND recent_summary.latest_closed_at IS NOT NULL
              AND EXTRACT(EPOCH FROM (now() - recent_summary.latest_closed_at)) < $11::float8 * 60
           THEN 'loss_cooldown'
         WHEN last_close.at IS NOT NULL
              AND EXTRACT(EPOCH FROM (now() - last_close.at)) < $13::float8
           THEN 'reentry_gap'
         ELSE NULL
       END AS reason
       FROM daily,recent_summary,control,last_close
     ),
     inserted AS (
       INSERT INTO scalper_signals(direction,setup,entry,stop_loss,take_profit,risk_reward,reasoning,setup_key,
                                   target1,context_json,final_sl,tp_broker)
       SELECT $1,$2,$3,$4,$5,$6,$7,$15,$5,$16::jsonb,$4,$17 FROM decision WHERE reason IS NULL
       ON CONFLICT DO NOTHING
       RETURNING id::text AS id
     )
     SELECT decision.reason, inserted.id, control.same_minute_signal_id
       FROM decision CROSS JOIN control
       LEFT JOIN inserted ON true`,
    [
      input.direction,
      input.setup,
      input.entry,
      input.stopLoss,
      input.takeProfit,
      input.riskReward,
      input.reasoning,
      maxTrades,
      maxDailyLoss,
      threeLossCooldown,
      lossCooldown,
      start.toISOString(),
      minReentrySec(),
      tradeDedupSec(),
      input.setupKey,
      input.context === undefined || input.context === null ? null : JSON.stringify(input.context),
      input.tpBroker ?? null,
    ],
  );

  const row = result.rows[0];
  const reason = row?.reason ? String(row.reason) : null;
  if (reason === "system_stopped") return { ok: false as const, status: "system_stopped" as const };
  if (reason === "reentry_gap") {
    return { ok: false as const, status: "reentry_gap" as const, reason, minReentrySec: minReentrySec() };
  }
  if (reason) return { ok: false as const, status: "blocked" as const, reason };
  if (!row?.id) return { ok: false as const, status: "blocked" as const, reason: "reservation_failed" };
  return { ok: true as const, signalId: String(row.id) };
}

export async function syncStreamingExecutor(connection: StreamingConnectionLike, options: SyncOptions = {}) {
  if (!options.schemaReady) await ensureSchema();
  const stopped = options.systemStopped ?? await systemStopActive();
  if (stopped) return { checked: 0, closed: 0, closures: [] as StreamClosure[], stopped: true };

  const unlinked = await dbQuery(
    "SELECT id,client_id FROM scalper_signals WHERE outcome IS NULL AND mt5_position_id IS NULL AND client_id IS NOT NULL",
  );
  for (const row of unlinked.rows) {
    const recovered = recoverOrder(String(row.client_id), symbol(), connection.terminalState.positions ?? [], connection.historyStorage?.deals ?? []);
    if (!recovered) continue;
    await dbQuery(
      `UPDATE scalper_signals SET mt5_position_id=$2,mt5_open_price=COALESCE(mt5_open_price,$3),
        mt5_volume=COALESCE(mt5_volume,$4),mt5_order_id=COALESCE(mt5_order_id,$5),mt5_error=NULL WHERE id=$1`,
      [row.id, recovered.positionId, recovered.openPrice, recovered.volume, recovered.orderId],
    );
  }

  const rows = await dbQuery(
    `SELECT id,setup,direction,mt5_position_id,mt5_open_price,entry,stop_loss,take_profit,target1,tp_broker,
            final_sl,breakeven_price,breakeven_at,trailing_updates,close_reason,created_at,context_json
       FROM scalper_signals
      WHERE outcome IS NULL AND mt5_position_id IS NOT NULL
      ORDER BY created_at ASC`,
  );
  const positions = connection.terminalState.positions ?? [];
  const closures: StreamClosure[] = [];
  let closed = 0;

  for (const signal of rows.rows) {
    const position = positions.find((p) => p.id === signal.mt5_position_id);
    if (position) continue;

    const positionId = String(signal.mt5_position_id);
    const lookup = await fetchHistoryThrottled(positionId);
    if (lookup.status !== "ok") continue;
    const history = lookup.history;
    const out = history
      .filter((d) => d.entryType && d.entryType !== "DEAL_ENTRY_IN")
      .sort((a, b) => Date.parse(a.time ?? "") - Date.parse(b.time ?? ""))
      .at(-1);
    const inn = history
      .filter((d) => d.entryType === "DEAL_ENTRY_IN")
      .sort((a, b) => Date.parse(a.time ?? "") - Date.parse(b.time ?? ""))[0];
    if (!out || !Number.isFinite(Number(out.price))) continue;

    const open = Number(signal.mt5_open_price ?? inn?.price ?? signal.entry);
    const close = Number(out.price);
    const profit = Number(out.profit ?? 0);
    const risk = Math.abs(open - Number(signal.stop_loss));
    const signed = Number(signal.entry) < Number(signal.stop_loss) ? open - close : close - open;
    const resultR = risk > 0 ? Number((signed / risk).toFixed(2)) : 0;

    // Il motivo si legge dal prezzo di chiusura reale del deal, mai dallo stato interno del worker:
    // lo stato puo' essere in ritardo, il prezzo no.
    const number = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : null);
    const trailingUpdates = Number(signal.trailing_updates ?? 0);
    // SLTP_MODE=fixed|trailing (dynamicSlTp.ts): il broker puo' chiudere la posizione prima del
    // check attivo del worker. Riconosciuto da context_json.sltp, che non esiste per nessuna riga
    // aperta con SLTP_MODE=off: quel ramo resta quindi identico a prima in ogni altro caso.
    const sltp = (signal.context_json as { sltp?: { mode?: string; triggered?: boolean } } | null)?.sltp;
    const closeReason = signal.close_reason
      ? String(signal.close_reason)
      : sltp
        ? sltpCloseReasonFromPrice(close, {
          currentSl: number(signal.final_sl ?? signal.stop_loss),
          slTightened: trailingUpdates > 0,
          currentTp: number(signal.tp_broker ?? signal.target1 ?? signal.take_profit),
          tpTriggered: sltp.triggered === true,
        })
        : isManagedSetup(signal.setup)
          ? closeReasonFromPrice(close, profit, {
            initialStop: number(signal.stop_loss),
            breakevenStop: number(signal.breakeven_price),
            trailingStop: trailingUpdates > 0 ? number(signal.final_sl) : null,
            brokerTp: number(signal.tp_broker),
            target1: number(signal.target1 ?? signal.take_profit),
          })
          : null;
    await dbQuery(
      `UPDATE scalper_signals
          SET mt5_close_price=$2,mt5_profit=$3,outcome=$4,result_r=$5,closed_at=COALESCE($6::timestamptz,now()),
              mt5_open_price=COALESCE(mt5_open_price,$7),mt5_volume=COALESCE(mt5_volume,$8),
              close_reason=COALESCE(close_reason,$9),final_sl=COALESCE(final_sl,stop_loss)
        WHERE id=$1`,
      [
        signal.id,
        close,
        profit,
        profit > 0 ? "WIN" : profit < 0 ? "LOSS" : "BREAKEVEN",
        resultR,
        out.time ?? null,
        open,
        Number(inn?.volume ?? out.volume ?? lots()),
        closeReason,
      ],
    );
    historyAttemptAt.delete(positionId);
    closures.push({
      signalId: String(signal.id),
      positionId,
      outcome: profit > 0 ? "WIN" : profit < 0 ? "LOSS" : "BREAKEVEN",
      profit,
      openPrice: open,
      closePrice: close,
      resultR,
      closeReason,
    });
    closed++;
  }

  return { checked: rows.rows.length, closed, closures, stopped: false };
}

export async function executeStreaming(
  signalId: string,
  direction: "BUY" | "SELL",
  stopLoss: number,
  /**
   * Take profit inviato al broker: sempre presente. Sui setup a uscita gestita e' il TP di
   * sicurezza (lontano), non l'obiettivo del trade: quello resta target1 e lo gestisce il worker.
   */
  takeProfit: number,
  connection: StreamingConnectionLike,
  options: ExecuteOptions = {},
) {
  if (!options.schemaReady) await ensureSchema();
  if (options.systemStopped === true) return { status: "system_stopped" as const };
  if (!autoExecEnabled()) return { status: "disabled" as const };

  if (!options.skipSync) {
    const sync = await syncStreamingExecutor(connection, {
      schemaReady: true,
      systemStopped: options.systemStopped,
    });
    if (sync.stopped) return { status: "system_stopped" as const };
  }

  const openPositions = (connection.terminalState.positions ?? []).filter((p) => p.symbol === symbol());
  const positionLimit = maxOpenPositions();
  if (openPositions.length >= positionLimit) {
    return { status: "blocked_position_limit" as const, openPositions: openPositions.length, limit: positionLimit };
  }

  if (openPositions.length > 0) {
    const directions = openPositions.map(positionDirection);
    if (directions.some((value) => value === null)) {
      return { status: "blocked_unknown_position_direction" as const };
    }
    if (directions.some((value) => value !== direction)) {
      return { status: "blocked_opposite_position" as const, direction };
    }
  }

  if (!options.preflightDone) {
    const [lim, control] = await Promise.all([
      limits(),
      dbQuery(
        `SELECT COALESCE((SELECT value='true' FROM scalper_settings WHERE key='system_stop'), false) AS stopped`,
      ),
    ]);

    if (control.rows[0]?.stopped === true) return { status: "system_stopped" as const };
    if (!lim.ok) return { status: "blocked" as const, reason: lim.reason };
  }

  const positionIdsBeforeOrder = new Set(openPositions.map((position) => position.id));
  const orderLots = clampLots(options.lots ?? lots());

  const marginPrice = Number(options.price);
  const freeMargin = Number(connection.terminalState.accountInformation?.freeMargin);
  if (Number.isFinite(marginPrice) && marginPrice > 0 && Number.isFinite(freeMargin)) {
    const needed = requiredMargin(orderLots, marginPrice);
    if (needed > freeMargin) {
      console.warn("[scalper-worker] insufficient_margin", { lots: orderLots, needed, freeMargin });
      return {
        status: "insufficient_margin" as const,
        reason: `${orderLots} lotti @ ${marginPrice.toFixed(2)}: richiesti ${needed.toFixed(2)}, liberi ${freeMargin.toFixed(2)}`,
        lots: orderLots,
        requiredMargin: Number(needed.toFixed(2)),
        freeMargin: Number(freeMargin.toFixed(2)),
      };
    }
  }

  const orderClientId = shortClientId();
  await dbQuery(`UPDATE scalper_signals SET client_id=$2 WHERE id=$1`, [signalId, orderClientId]);
  console.log("[scalper-worker] order_send", {
    clientId: orderClientId,
    direction,
    lots: orderLots,
    sl: stopLoss,
    tp: takeProfit,
    openPositions: openPositions.length,
    positionLimit,
  });

  // Nessun ordine parte senza rete: se worker o MetaApi muoiono, SL e TP restano al broker.
  if (!Number.isFinite(stopLoss) || !Number.isFinite(takeProfit)) {
    const reason = `SL/TP non validi per l'ordine: sl=${stopLoss} tp=${takeProfit}`;
    await dbQuery(`UPDATE scalper_signals SET mt5_error=$2,outcome='ERROR',closed_at=now() WHERE id=$1`, [signalId, reason]);
    return { status: "error" as const, error: reason };
  }

  let result: Record<string, unknown>;
  try {
    const orderOptions = { clientId: orderClientId };
    result = direction === "BUY"
      ? await connection.createMarketBuyOrder(symbol(), orderLots, stopLoss, takeProfit, orderOptions)
      : await connection.createMarketSellOrder(symbol(), orderLots, stopLoss, takeProfit, orderOptions);
    if (![10008, 10009, 10010].includes(Number(result.numericCode))
      && !["TRADE_RETCODE_PLACED", "TRADE_RETCODE_DONE", "TRADE_RETCODE_DONE_PARTIAL"].includes(String(result.stringCode))) {
      throw Object.assign(new Error("Esito ordine non confermato: " + JSON.stringify(result)), { numericCode: result.numericCode });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rejected = definitelyRejected(error);
    await dbQuery(
      `UPDATE scalper_signals SET mt5_error=$2,outcome=CASE WHEN $3 THEN 'ERROR' ELSE NULL END,
        closed_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE id=$1`,
      [signalId, message, rejected],
    );
    console.error("[scalper-worker] order_error", {
      clientId: orderClientId,
      direction,
      error: message,
    });
    return { status: rejected ? "error" as const : "pending_confirmation" as const, error: message, clientId: orderClientId };
  }

  const orderId = typeof result.orderId === "string" ? result.orderId : null;
  const responsePositionId = typeof result.positionId === "string" ? result.positionId : null;
  await dbQuery(`UPDATE scalper_signals SET mt5_order_id=$2 WHERE id=$1`, [signalId, orderId]);

  if (responsePositionId) {
    const position = (connection.terminalState.positions ?? []).find((p) => p.id === responsePositionId);
    await dbQuery(
      `UPDATE scalper_signals SET mt5_position_id=$2,mt5_open_price=$3,mt5_volume=$4 WHERE id=$1`,
      [signalId, responsePositionId, position?.openPrice ?? null, position?.volume ?? orderLots],
    );
    return { status: "opened" as const, orderId, positionId: responsePositionId, openPrice: position?.openPrice ?? null, clientId: orderClientId };
  }

  // Il prezzo di fill vero arriva col terminal state, non con la risposta all'ordine: si aspetta
  // fino a FILL_POLL_MAX_MS perche' target1, breakeven e trailing vanno misurati sul fill reale.
  const fillPollMs = envN("FILL_POLL_INTERVAL_MS", 500, 50);
  const fillPollMax = envN("FILL_POLL_MAX_MS", 15_000, 1000);
  const deadline = Date.now() + fillPollMax;
  while (Date.now() < deadline) {
    const position = (connection.terminalState.positions ?? []).find((p) =>
      p.symbol === symbol()
      && !positionIdsBeforeOrder.has(p.id)
      && (!p.clientId || p.clientId === orderClientId),
    );
    if (position && Number.isFinite(Number(position.openPrice)) && Number(position.openPrice) > 0) {
      await dbQuery(
        `UPDATE scalper_signals SET mt5_position_id=$2,mt5_open_price=$3,mt5_volume=$4 WHERE id=$1`,
        [signalId, position.id, position.openPrice, position.volume ?? orderLots],
      );
      return { status: "opened" as const, orderId, positionId: position.id, openPrice: Number(position.openPrice), clientId: orderClientId };
    }
    await new Promise((resolve) => setTimeout(resolve, fillPollMs));
  }

  const message = `Ordine accettato ma prezzo di fill non disponibile entro ${Math.round(fillPollMax / 1000)}s`;
  console.warn("[scalper-worker] fill_price_missing", { clientId: orderClientId, orderId, signalId, waitedMs: fillPollMax });
  await dbQuery(`UPDATE scalper_signals SET mt5_error=$2 WHERE id=$1`, [signalId, message]);
  return { status: "pending_position_link" as const, orderId, clientId: orderClientId };
}

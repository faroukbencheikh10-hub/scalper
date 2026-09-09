import { randomBytes } from "node:crypto";
import { dbQuery, ensureSchema, getSetting, setSetting, systemStopActive } from "./db";
import { autoExecEnabled, clampLots, lots } from "./tradingConfig";
import { requiredMargin } from "@/lib/lots";
import { deals, symbol } from "./metaApi";

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
  direction: "BUY" | "SELL";
  setup: string | null;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  reasoning: string;
  openPositionCount: number;
};

type DealHistory = Awaited<ReturnType<typeof deals>>;

const historyAttemptAt = new Map<string, number>();
let historyBackoffUntil = 0;
let historyBackoffLoaded = false;
let historyErrorActive = false;

function envN(name: string, fallback: number, min = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function maxOpenPositions() {
  return Math.min(3, Math.max(1, Math.floor(envN("SCALPER_MAX_OPEN_POSITIONS", 3, 1))));
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
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const [daily, last] = await Promise.all([
    dbQuery(
      `SELECT COUNT(*) FILTER (WHERE mt5_order_id IS NOT NULL) trades,
              COALESCE(SUM(mt5_profit),0) profit
         FROM scalper_signals
        WHERE created_at >= $1`,
      [start.toISOString()],
    ),
    dbQuery(`SELECT outcome,closed_at FROM scalper_signals WHERE outcome IS NOT NULL ORDER BY closed_at DESC LIMIT 3`),
  ]);

  const trades = Number(daily.rows[0]?.trades ?? 0);
  const profit = Number(daily.rows[0]?.profit ?? 0);
  if (trades >= envN("MAX_TRADES_PER_DAY", 12, 1)) return { ok: false, reason: "max_trades_per_day" };
  if (profit <= -envN("MAX_DAILY_LOSS", 150, 0)) return { ok: false, reason: "max_daily_loss" };

  const losses = last.rows.filter((row: { outcome?: string }) => row.outcome === "LOSS");
  if (losses.length >= 3 && last.rows[0]?.closed_at) {
    const t = Date.parse(last.rows[0].closed_at);
    if (Date.now() - t < envN("SCALPER_THREE_LOSS_COOLDOWN_MIN", 30, 1) * 60_000) {
      return { ok: false, reason: "three_loss_cooldown" };
    }
  } else if (last.rows[0]?.outcome === "LOSS" && last.rows[0]?.closed_at) {
    const t = Date.parse(last.rows[0].closed_at);
    if (Date.now() - t < envN("SCALPER_LOSS_COOLDOWN_MIN", 5, 1) * 60_000) {
      return { ok: false, reason: "loss_cooldown" };
    }
  }
  return { ok: true, reason: null };
}

export async function reserveStreamingSignal(input: ReserveSignalInput) {
  const positionLimit = maxOpenPositions();
  if (input.openPositionCount >= positionLimit) {
    return { ok: false as const, status: "blocked" as const, reason: "max_open_positions" };
  }

  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const maxTrades = envN("MAX_TRADES_PER_DAY", 12, 1);
  const maxDailyLoss = envN("MAX_DAILY_LOSS", 150, 0);
  const threeLossCooldown = envN("SCALPER_THREE_LOSS_COOLDOWN_MIN", 30, 1);
  const lossCooldown = envN("SCALPER_LOSS_COOLDOWN_MIN", 5, 1);

  const result = await dbQuery(
    `WITH lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(209260908)
     ),
     daily AS (
       SELECT COUNT(*) FILTER (WHERE mt5_order_id IS NOT NULL)::int AS trades,
              COALESCE(SUM(mt5_profit),0)::float8 AS profit
         FROM scalper_signals, lock
        WHERE created_at >= $12::timestamptz
     ),
     recent AS MATERIALIZED (
       SELECT outcome,closed_at,row_number() OVER (ORDER BY closed_at DESC) AS rn
         FROM scalper_signals
        WHERE outcome IS NOT NULL
        ORDER BY closed_at DESC
        LIMIT 3
     ),
     recent_summary AS (
       SELECT COUNT(*) FILTER (WHERE outcome='LOSS')::int AS recent_losses,
              MAX(outcome) FILTER (WHERE rn=1) AS latest_outcome,
              MAX(closed_at) FILTER (WHERE rn=1) AS latest_closed_at
         FROM recent
     ),
     control AS (
       SELECT COALESCE((SELECT value='true' FROM scalper_settings WHERE key='system_stop'), false) AS stopped,
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
         WHEN control.same_minute_signal_id IS NOT NULL THEN 'same_minute_signal'
         WHEN daily.trades >= $8::int THEN 'max_trades_per_day'
         WHEN daily.profit <= -$9::float8 THEN 'max_daily_loss'
         WHEN recent_summary.recent_losses >= 3
              AND recent_summary.latest_closed_at IS NOT NULL
              AND EXTRACT(EPOCH FROM (now() - recent_summary.latest_closed_at)) < $10::float8 * 60
           THEN 'three_loss_cooldown'
         WHEN recent_summary.latest_outcome='LOSS'
              AND recent_summary.latest_closed_at IS NOT NULL
              AND EXTRACT(EPOCH FROM (now() - recent_summary.latest_closed_at)) < $11::float8 * 60
           THEN 'loss_cooldown'
         ELSE NULL
       END AS reason
       FROM daily,recent_summary,control
     ),
     inserted AS (
       INSERT INTO scalper_signals(direction,setup,entry,stop_loss,take_profit,risk_reward,reasoning)
       SELECT $1,$2,$3,$4,$5,$6,$7 FROM decision WHERE reason IS NULL
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
    ],
  );

  const row = result.rows[0];
  const reason = row?.reason ? String(row.reason) : null;
  if (reason === "system_stopped") return { ok: false as const, status: "system_stopped" as const };
  if (reason) return { ok: false as const, status: "blocked" as const, reason };
  if (!row?.id) return { ok: false as const, status: "blocked" as const, reason: "reservation_failed" };
  return { ok: true as const, signalId: String(row.id) };
}

export async function syncStreamingExecutor(connection: StreamingConnectionLike, options: SyncOptions = {}) {
  if (!options.schemaReady) await ensureSchema();
  const stopped = options.systemStopped ?? await systemStopActive();
  if (stopped) return { checked: 0, closed: 0, stopped: true };

  const rows = await dbQuery(
    `SELECT id,mt5_position_id,mt5_open_price,entry,stop_loss,created_at
       FROM scalper_signals
      WHERE outcome IS NULL AND mt5_position_id IS NOT NULL
      ORDER BY created_at ASC`,
  );
  const positions = connection.terminalState.positions ?? [];
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

    await dbQuery(
      `UPDATE scalper_signals
          SET mt5_close_price=$2,mt5_profit=$3,outcome=$4,result_r=$5,closed_at=COALESCE($6::timestamptz,now()),
              mt5_open_price=COALESCE(mt5_open_price,$7),mt5_volume=COALESCE(mt5_volume,$8)
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
      ],
    );
    historyAttemptAt.delete(positionId);
    closed++;
  }

  return { checked: rows.rows.length, closed, stopped: false };
}

export async function executeStreaming(
  signalId: string,
  direction: "BUY" | "SELL",
  stopLoss: number,
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

  let result: Record<string, unknown>;
  try {
    const orderOptions = { clientId: orderClientId };
    result = direction === "BUY"
      ? await connection.createMarketBuyOrder(symbol(), orderLots, stopLoss, takeProfit, orderOptions)
      : await connection.createMarketSellOrder(symbol(), orderLots, stopLoss, takeProfit, orderOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dbQuery(
      `UPDATE scalper_signals SET mt5_error=$2,outcome='ERROR',closed_at=now() WHERE id=$1`,
      [signalId, message],
    );
    console.error("[scalper-worker] order_error", {
      clientId: orderClientId,
      direction,
      error: message,
    });
    return { status: "error" as const, error: message, clientId: orderClientId };
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

  for (let i = 0; i < 20; i++) {
    const position = (connection.terminalState.positions ?? []).find((p) =>
      p.symbol === symbol()
      && !positionIdsBeforeOrder.has(p.id)
      && (!p.clientId || p.clientId === orderClientId),
    );
    if (position) {
      await dbQuery(
        `UPDATE scalper_signals SET mt5_position_id=$2,mt5_open_price=$3,mt5_volume=$4 WHERE id=$1`,
        [signalId, position.id, position.openPrice, position.volume ?? orderLots],
      );
      return { status: "opened" as const, orderId, positionId: position.id, openPrice: position.openPrice, clientId: orderClientId };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await dbQuery(`UPDATE scalper_signals SET mt5_error=$2 WHERE id=$1`, [signalId, "Ordine accettato ma posizione streaming non collegata entro 2s"]);
  return { status: "pending_position_link" as const, orderId, clientId: orderClientId };
}
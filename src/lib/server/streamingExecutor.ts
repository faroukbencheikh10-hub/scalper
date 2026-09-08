import { dbQuery, ensureSchema, systemStopActive } from "./db";
import { autoExecEnabled, lots } from "./executor";
import { deals, symbol } from "./metaApi";

type StreamPosition = {
  id: string;
  symbol: string;
  openPrice: number;
  volume?: number;
  clientId?: string;
};

type StreamTerminalState = {
  positions: StreamPosition[];
};

export type StreamingConnectionLike = {
  terminalState: StreamTerminalState;
  createMarketBuyOrder: (symbol: string, volume: number, stopLoss?: number, takeProfit?: number, options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  createMarketSellOrder: (symbol: string, volume: number, stopLoss?: number, takeProfit?: number, options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  closePosition: (positionId: string) => Promise<Record<string, unknown>>;
};

const timeStopRequested = new Set<string>();

function envN(name: string, fallback: number, min = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function clientId(signalId: string) {
  return `SC_XAUUSD_${signalId.replace(/-/g, "").slice(-10)}`;
}

async function limits() {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const daily = await dbQuery(
    `SELECT COUNT(*) FILTER (WHERE mt5_order_id IS NOT NULL) trades,
            COALESCE(SUM(mt5_profit),0) profit
       FROM scalper_signals
      WHERE created_at >= $1`,
    [start.toISOString()],
  );
  const trades = Number(daily.rows[0]?.trades ?? 0);
  const profit = Number(daily.rows[0]?.profit ?? 0);
  if (trades >= envN("MAX_TRADES_PER_DAY", 12, 1)) return { ok: false, reason: "max_trades_per_day" };
  if (profit <= -envN("MAX_DAILY_LOSS", 150, 0)) return { ok: false, reason: "max_daily_loss" };

  const last = await dbQuery(`SELECT outcome,closed_at FROM scalper_signals WHERE outcome IS NOT NULL ORDER BY closed_at DESC LIMIT 3`);
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

export async function syncStreamingExecutor(connection: StreamingConnectionLike) {
  await ensureSchema();
  if (await systemStopActive()) return { checked: 0, closed: 0, timedOut: 0, stopped: true };

  const rows = await dbQuery(
    `SELECT id,mt5_position_id,mt5_open_price,entry,stop_loss,created_at
       FROM scalper_signals
      WHERE outcome IS NULL AND mt5_position_id IS NOT NULL
      ORDER BY created_at ASC`,
  );
  const positions = connection.terminalState.positions ?? [];
  const timeoutMin = envN("SCALPER_TIME_STOP_MIN", 12, 1);
  let closed = 0;
  let timedOut = 0;

  for (const signal of rows.rows) {
    const position = positions.find((p) => p.id === signal.mt5_position_id);
    if (position) {
      const ageMin = (Date.now() - new Date(signal.created_at).getTime()) / 60_000;
      if (ageMin >= timeoutMin && !timeStopRequested.has(position.id)) {
        timeStopRequested.add(position.id);
        try {
          await connection.closePosition(position.id);
          timedOut++;
        } catch (error) {
          timeStopRequested.delete(position.id);
          throw error;
        }
      }
      continue;
    }

    timeStopRequested.delete(String(signal.mt5_position_id));
    const history = await deals(String(signal.mt5_position_id));
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
          SET mt5_close_price=$2,mt5_profit=$3,outcome=$4,result_r=$5,closed_at=COALESCE($6::timestamptz,now())
        WHERE id=$1`,
      [signal.id, close, profit, profit > 0 ? "WIN" : profit < 0 ? "LOSS" : "BREAKEVEN", resultR, out.time ?? null],
    );
    closed++;
  }

  return { checked: rows.rows.length, closed, timedOut, stopped: false };
}

export async function executeStreaming(
  signalId: string,
  direction: "BUY" | "SELL",
  stopLoss: number,
  takeProfit: number,
  connection: StreamingConnectionLike,
) {
  await ensureSchema();
  if (await systemStopActive()) return { status: "system_stopped" as const };
  if (!autoExecEnabled()) return { status: "disabled" as const };

  await syncStreamingExecutor(connection);
  const lim = await limits();
  if (!lim.ok) return { status: "blocked" as const, reason: lim.reason };

  const existing = (connection.terminalState.positions ?? []).find((p) => p.symbol === symbol());
  if (existing) return { status: "blocked_existing_position" as const, positionId: existing.id };

  if (await systemStopActive()) return { status: "system_stopped" as const };

  try {
    const options = { comment: "scalper streaming", clientId: clientId(signalId) };
    const result = direction === "BUY"
      ? await connection.createMarketBuyOrder(symbol(), lots(), stopLoss, takeProfit, options)
      : await connection.createMarketSellOrder(symbol(), lots(), stopLoss, takeProfit, options);

    const orderId = typeof result.orderId === "string" ? result.orderId : null;
    const responsePositionId = typeof result.positionId === "string" ? result.positionId : null;
    await dbQuery(`UPDATE scalper_signals SET mt5_order_id=$2 WHERE id=$1`, [signalId, orderId]);

    if (responsePositionId) {
      const position = (connection.terminalState.positions ?? []).find((p) => p.id === responsePositionId);
      await dbQuery(
        `UPDATE scalper_signals SET mt5_position_id=$2,mt5_open_price=$3 WHERE id=$1`,
        [signalId, responsePositionId, position?.openPrice ?? null],
      );
      return { status: "opened" as const, orderId, positionId: responsePositionId, openPrice: position?.openPrice ?? null };
    }

    for (let i = 0; i < 20; i++) {
      const position = (connection.terminalState.positions ?? []).find((p) => p.symbol === symbol() && (!p.clientId || p.clientId === clientId(signalId)));
      if (position) {
        await dbQuery(
          `UPDATE scalper_signals SET mt5_position_id=$2,mt5_open_price=$3 WHERE id=$1`,
          [signalId, position.id, position.openPrice],
        );
        return { status: "opened" as const, orderId, positionId: position.id, openPrice: position.openPrice };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    await dbQuery(`UPDATE scalper_signals SET mt5_error=$2 WHERE id=$1`, [signalId, "Ordine accettato ma posizione streaming non collegata entro 5s"]);
    return { status: "pending_position_link" as const, orderId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dbQuery(
      `UPDATE scalper_signals SET mt5_error=$2,outcome='ERROR',closed_at=now() WHERE id=$1`,
      [signalId, message.slice(0, 1000)],
    );
    return { status: "error" as const, error: message };
  }
}

import MetaApi from "metaapi.cloud-sdk";
import { dbQuery, ensureSchema, setSetting, systemStopActive } from "../src/lib/server/db";
import { autoExecEnabled } from "../src/lib/server/executor";
import { fetchCandles, symbol } from "../src/lib/server/metaApi";
import { evaluateScalper } from "../src/lib/server/scalperStrategy";
import { executeStreaming, syncStreamingExecutor, type StreamingConnectionLike } from "../src/lib/server/streamingExecutor";
import type { Candle, Quote } from "../src/lib/types";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} non impostata`);
  return value;
}

function envInt(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bucketStart(timeMs: number, minutes: number) {
  const size = minutes * 60_000;
  return Math.floor(timeMs / size) * size;
}

function upsertTick(buffer: Candle[], minutes: number, mid: number, timeMs: number, max: number) {
  const bucket = bucketStart(timeMs, minutes);
  const datetime = new Date(bucket).toISOString();
  const last = buffer.at(-1);

  if (!last || Date.parse(last.datetime) < bucket) {
    buffer.push({ datetime, open: mid, high: mid, low: mid, close: mid });
    while (buffer.length > max) buffer.shift();
    return true;
  }

  if (Date.parse(last.datetime) === bucket) {
    last.high = Math.max(last.high, mid);
    last.low = Math.min(last.low, mid);
    last.close = mid;
  }
  return false;
}

function priceTimeMs(price: Record<string, unknown>) {
  const raw = price.time;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "string" || typeof raw === "number") {
    const parsed = new Date(raw).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function quoteFromPrice(price: Record<string, unknown>): Quote | null {
  const bid = Number(price.bid);
  const ask = Number(price.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) return null;
  return {
    bid,
    ask,
    mid: Number(((bid + ask) / 2).toFixed(2)),
    spread: Number((ask - bid).toFixed(2)),
    quotedAt: priceTimeMs(price),
  };
}

async function seedCandles(m1Max: number, m5Max: number) {
  const [m1, m5] = await Promise.all([
    fetchCandles("1m", m1Max),
    fetchCandles("5m", m5Max),
  ]);
  return { m1, m5 };
}

async function markWorker(status: string, extra?: Record<string, unknown>) {
  await Promise.all([
    setSetting("stream_worker_status", status),
    setSetting("stream_worker_heartbeat", new Date().toISOString()),
    extra ? setSetting("stream_worker_detail", JSON.stringify(extra)) : Promise.resolve(),
  ]);
}

async function processClosedMinute(
  quote: Quote,
  m1: Candle[],
  m5: Candle[],
  connection: StreamingConnectionLike,
) {
  if (await systemStopActive()) return;

  await syncStreamingExecutor(connection);
  const active = await dbQuery(
    `SELECT id FROM scalper_signals
      WHERE outcome IS NULL AND direction IN ('BUY','SELL')
      ORDER BY created_at DESC LIMIT 1`,
  );
  if (active.rows[0]) return;

  const closedM1 = m1.slice(0, -1);
  const currentM5Bucket = bucketStart(quote.quotedAt ?? Date.now(), 5);
  const closedM5 = m5.filter((c) => Date.parse(c.datetime) < currentM5Bucket);
  const signal = evaluateScalper({ quote, m1: closedM1, m5: closedM5 });

  await setSetting("stream_last_decision", JSON.stringify({
    at: new Date().toISOString(),
    direction: signal.direction,
    setup: signal.setup,
    reasoning: signal.reasoning,
    quote,
  }));

  if (signal.direction === "NO_TRADE") return;

  if (!autoExecEnabled()) {
    await setSetting("stream_last_preview", JSON.stringify({ at: new Date().toISOString(), ...signal }));
    return;
  }

  const saved = await dbQuery(
    `INSERT INTO scalper_signals(direction,setup,entry,stop_loss,take_profit,risk_reward,reasoning)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [signal.direction, signal.setup, signal.entry, signal.stopLoss, signal.takeProfit, signal.riskReward, signal.reasoning],
  );
  const signalId = String(saved.rows[0].id);
  const execution = await executeStreaming(signalId, signal.direction, signal.stopLoss!, signal.takeProfit!, connection);

  if (["blocked", "blocked_existing_position", "system_stopped"].includes(execution.status)) {
    const reason = "reason" in execution ? String(execution.reason ?? "") : "";
    await dbQuery(
      `UPDATE scalper_signals SET outcome='SKIPPED',closed_at=now(),mt5_error=$2 WHERE id=$1`,
      [signalId, `Streaming execution: ${execution.status}${reason ? ` (${reason})` : ""}`],
    );
  }
}

async function main() {
  await ensureSchema();
  const token = required("METAAPI_TOKEN");
  const accountId = required("METAAPI_ACCOUNT_ID");
  const m1Max = envInt("SCALPER_M1_CANDLES", 500, 50, 1000);
  const m5Max = envInt("SCALPER_M5_CANDLES", 300, 50, 1000);
  const pollMs = envInt("SCALPER_STREAM_POLL_MS", 250, 100, 5000);
  const controlPollMs = envInt("SCALPER_CONTROL_POLL_MS", 1000, 250, 10_000);
  const heartbeatMs = envInt("SCALPER_STREAM_HEARTBEAT_MS", 5000, 1000, 60_000);
  const syncMs = envInt("SCALPER_STREAM_SYNC_MS", 1000, 500, 30_000);
  const quotePersistMs = envInt("SCALPER_STREAM_QUOTE_PERSIST_MS", 1000, 250, 10_000);

  const api = new MetaApi(token);
  const account = await api.metatraderAccountApi.getAccount(accountId);
  const connection = account.getStreamingConnection();
  await connection.connect();
  await connection.waitSynchronized();

  const tradingConnection = connection as unknown as StreamingConnectionLike;
  let subscribed = false;
  let m1: Candle[] = [];
  let m5: Candle[] = [];
  let lastSignature = "";
  let lastControlCheck = 0;
  let lastHeartbeat = 0;
  let lastSync = 0;
  let lastQuotePersist = 0;
  let stopped = true;

  await markWorker("connected", { symbol: symbol(), mode: "MetaApi Streaming/WebSocket" });

  const marketDataSubscriptions = [{ type: "quotes" as const }];
  const marketDataUnsubscriptions = [{ type: "quotes" as const }];

  const shutdown = async (reason: string) => {
    try {
      await markWorker("stopping", { reason });
      if (subscribed) await connection.unsubscribeFromMarketData(symbol(), marketDataUnsubscriptions).catch(() => undefined);
      await connection.close();
      await markWorker("stopped", { reason });
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  while (true) {
    const now = Date.now();

    if (now - lastControlCheck >= controlPollMs) {
      lastControlCheck = now;
      stopped = await systemStopActive();
      if (stopped && subscribed) {
        await connection.unsubscribeFromMarketData(symbol(), marketDataUnsubscriptions).catch(() => undefined);
        subscribed = false;
        await setSetting("stream_last_quote", "");
        await markWorker("paused", { reason: "STOP TUTTO" });
      } else if (!stopped && !subscribed) {
        if (!m1.length || !m5.length) {
          const seeded = await seedCandles(m1Max, m5Max);
          m1 = seeded.m1;
          m5 = seeded.m5;
        }
        await connection.subscribeToMarketData(symbol(), marketDataSubscriptions);
        subscribed = true;
        await markWorker("streaming", { symbol: symbol(), m1: m1.length, m5: m5.length });
      }
    }

    if (!stopped && subscribed) {
      const rawPrice = connection.terminalState.price(symbol()) as unknown as Record<string, unknown> | undefined;
      if (rawPrice) {
        const quote = quoteFromPrice(rawPrice);
        if (quote) {
          const signature = `${quote.quotedAt}:${quote.bid}:${quote.ask}`;
          if (signature !== lastSignature) {
            lastSignature = signature;
            const newM1 = upsertTick(m1, 1, quote.mid, quote.quotedAt ?? now, m1Max);
            upsertTick(m5, 5, quote.mid, quote.quotedAt ?? now, m5Max);
            if (newM1 && m1.length > 36 && m5.length > 31) {
              try {
                await processClosedMinute(quote, m1, m5, tradingConnection);
              } catch (error) {
                await setSetting("stream_last_error", `${new Date().toISOString()} ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }

          if (now - lastQuotePersist >= quotePersistMs) {
            lastQuotePersist = now;
            await setSetting("stream_last_quote", JSON.stringify({ ...quote, receivedAt: new Date().toISOString() }));
          }
        }
      }

      if (now - lastSync >= syncMs) {
        lastSync = now;
        try {
          await syncStreamingExecutor(tradingConnection);
        } catch (error) {
          await setSetting("stream_last_error", `${new Date().toISOString()} ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (now - lastHeartbeat >= heartbeatMs) {
      lastHeartbeat = now;
      await markWorker(stopped ? "paused" : subscribed ? "streaming" : "connected", {
        symbol: symbol(),
        autoExec: autoExecEnabled(),
        m1: m1.length,
        m5: m5.length,
      });
    }

    await sleep(pollMs);
  }
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  try {
    await ensureSchema();
    await setSetting("stream_worker_status", "error");
    await setSetting("stream_last_error", `${new Date().toISOString()} ${message}`);
  } catch {
  }
  process.exit(1);
});

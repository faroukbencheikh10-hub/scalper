import MetaApi, { SynchronizationListener } from "metaapi.cloud-sdk";
import { dbQuery, ensureSchema, setSetting, systemStopActive } from "../src/lib/server/db";
import { autoExecEnabled } from "../src/lib/server/executor";
import { fetchCandles, symbol } from "../src/lib/server/metaApi";
import { evaluateScalper } from "../src/lib/server/scalperStrategy";
import { executeStreaming, reserveStreamingSignal, syncStreamingExecutor, type StreamingConnectionLike } from "../src/lib/server/streamingExecutor";
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
    return;
  }

  if (Date.parse(last.datetime) === bucket) {
    last.high = Math.max(last.high, mid);
    last.low = Math.min(last.low, mid);
    last.close = mid;
  }
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

class QuoteListener extends SynchronizationListener {
  constructor(private readonly handler: (price: Record<string, unknown>) => Promise<void>) {
    super();
  }

  async onSymbolPriceUpdated(_instanceIndex: string, price: any) {
    await this.handler(price as Record<string, unknown>);
  }
}

async function main() {
  await ensureSchema();
  const token = required("METAAPI_TOKEN");
  const accountId = required("METAAPI_ACCOUNT_ID");
  const m1Max = envInt("SCALPER_M1_CANDLES", 500, 50, 1000);
  const m5Max = envInt("SCALPER_M5_CANDLES", 300, 50, 1000);
  const controlPollMs = envInt("SCALPER_CONTROL_POLL_MS", 250, 100, 10_000);
  const heartbeatMs = envInt("SCALPER_STREAM_HEARTBEAT_MS", 3000, 1000, 60_000);
  const syncMs = envInt("SCALPER_STREAM_SYNC_MS", 250, 100, 30_000);
  const quotePersistMs = envInt("SCALPER_STREAM_QUOTE_PERSIST_MS", 500, 100, 10_000);
  const decisionPersistMs = envInt("SCALPER_STREAM_DECISION_PERSIST_MS", 500, 100, 10_000);

  const api = new MetaApi(token);
  const account = await api.metatraderAccountApi.getAccount(accountId);
  const connection = account.getStreamingConnection();
  const tradingConnection = connection as unknown as StreamingConnectionLike;

  let subscribed = false;
  let ready = false;
  let stopped = await systemStopActive();
  let m1: Candle[] = [];
  let m5: Candle[] = [];
  let latestQuote: Quote | null = null;
  let latestDecision: Record<string, unknown> | null = null;
  let latestPreview: Record<string, unknown> | null = null;
  let decisionBusy = false;
  let controlBusy = false;
  let syncBusy = false;
  let heartbeatBusy = false;
  let quotePersistBusy = false;
  let decisionPersistBusy = false;
  let signalLockUntil = 0;

  const marketDataSubscriptions = [{ type: "quotes" as const }];
  const marketDataUnsubscriptions = [{ type: "quotes" as const }];

  const onPrice = async (price: Record<string, unknown>) => {
    if (!ready || stopped || !subscribed) return;
    const priceSymbol = typeof price.symbol === "string" ? price.symbol : symbol();
    if (priceSymbol !== symbol()) return;

    const quote = quoteFromPrice(price);
    if (!quote) return;
    latestQuote = quote;

    upsertTick(m1, 1, quote.mid, quote.quotedAt ?? Date.now(), m1Max);
    upsertTick(m5, 5, quote.mid, quote.quotedAt ?? Date.now(), m5Max);
    if (m1.length < 35 || m5.length < 30) return;
    if (decisionBusy || Date.now() < signalLockUntil) return;

    const existing = (tradingConnection.terminalState.positions ?? []).find((p) => p.symbol === symbol());
    if (existing) return;

    const signal = evaluateScalper({ quote, m1, m5 });
    latestDecision = {
      at: new Date().toISOString(),
      mode: "event_driven_intrabar_fast_preflight",
      direction: signal.direction,
      setup: signal.setup,
      reasoning: signal.reasoning,
      quote,
    };

    if (signal.direction === "NO_TRADE") return;

    if (!autoExecEnabled()) {
      latestPreview = { at: new Date().toISOString(), ...signal };
      return;
    }

    decisionBusy = true;
    try {
      const reservation = await reserveStreamingSignal({
        direction: signal.direction,
        setup: signal.setup,
        entry: signal.entry!,
        stopLoss: signal.stopLoss!,
        takeProfit: signal.takeProfit!,
        riskReward: signal.riskReward!,
        reasoning: signal.reasoning,
      });

      if (!reservation.ok) {
        latestDecision = {
          at: new Date().toISOString(),
          mode: "event_driven_intrabar_fast_preflight",
          direction: signal.direction,
          setup: signal.setup,
          reasoning: signal.reasoning,
          quote,
          execution: reservation,
        };
        return;
      }

      const signalId = reservation.signalId;
      const execution = await executeStreaming(
        signalId,
        signal.direction,
        signal.stopLoss!,
        signal.takeProfit!,
        tradingConnection,
        { schemaReady: true, skipSync: true, systemStopped: stopped, preflightDone: true },
      );

      if (["blocked", "blocked_existing_position", "blocked_existing_signal", "system_stopped"].includes(execution.status)) {
        const reason = "reason" in execution ? String(execution.reason ?? "") : "";
        await dbQuery(
          `UPDATE scalper_signals SET outcome='SKIPPED',closed_at=now(),mt5_error=$2 WHERE id=$1`,
          [signalId, `Streaming execution: ${execution.status}${reason ? ` (${reason})` : ""}`],
        );
      } else if (execution.status === "opened" || execution.status === "pending_position_link") {
        signalLockUntil = Date.now() + 5000;
      }

      latestDecision = {
        at: new Date().toISOString(),
        mode: "event_driven_intrabar_fast_preflight",
        signalId,
        direction: signal.direction,
        setup: signal.setup,
        reasoning: signal.reasoning,
        quote,
        execution,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await setSetting("stream_last_error", `${new Date().toISOString()} ${message}`);
    } finally {
      decisionBusy = false;
    }
  };

  const listener = new QuoteListener(onPrice);
  connection.addSynchronizationListener(listener);
  await connection.connect();
  await connection.waitSynchronized();

  const subscribe = async () => {
    ready = false;
    const seeded = await seedCandles(m1Max, m5Max);
    m1 = seeded.m1;
    m5 = seeded.m5;
    await connection.subscribeToMarketData(symbol(), marketDataSubscriptions);
    subscribed = true;
    ready = true;
    await markWorker("streaming", {
      symbol: symbol(),
      mode: "MetaApi WebSocket event-driven intrabar + single DB preflight",
      m1: m1.length,
      m5: m5.length,
    });
  };

  if (!stopped) {
    await subscribe();
  } else {
    await markWorker("paused", { reason: "STOP TUTTO" });
  }

  const controlTimer = setInterval(() => {
    if (controlBusy) return;
    controlBusy = true;
    void (async () => {
      try {
        const nextStopped = await systemStopActive();
        if (nextStopped && !stopped) {
          stopped = true;
          ready = false;
          if (subscribed) {
            await connection.unsubscribeFromMarketData(symbol(), marketDataUnsubscriptions).catch(() => undefined);
            subscribed = false;
          }
          m1 = [];
          m5 = [];
          latestQuote = null;
          await setSetting("stream_last_quote", "");
          await markWorker("paused", { reason: "STOP TUTTO" });
        } else if (!nextStopped && stopped) {
          stopped = false;
          await subscribe();
        } else {
          stopped = nextStopped;
        }
      } catch (error) {
        console.error(error);
      } finally {
        controlBusy = false;
      }
    })();
  }, controlPollMs);

  const syncTimer = setInterval(() => {
    if (syncBusy || stopped || !subscribed) return;
    syncBusy = true;
    void syncStreamingExecutor(tradingConnection, { schemaReady: true, systemStopped: stopped })
      .then((result) => {
        if (result.closed > 0 || result.timedOut > 0) signalLockUntil = 0;
      })
      .catch((error) => setSetting("stream_last_error", `${new Date().toISOString()} ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        syncBusy = false;
      });
  }, syncMs);

  const quotePersistTimer = setInterval(() => {
    if (quotePersistBusy || !latestQuote) return;
    quotePersistBusy = true;
    const snapshot = latestQuote;
    void setSetting("stream_last_quote", JSON.stringify({ ...snapshot, receivedAt: new Date().toISOString() }))
      .catch((error) => console.error(error))
      .finally(() => {
        quotePersistBusy = false;
      });
  }, quotePersistMs);

  const decisionPersistTimer = setInterval(() => {
    if (decisionPersistBusy || (!latestDecision && !latestPreview)) return;
    decisionPersistBusy = true;
    const decision = latestDecision;
    const preview = latestPreview;
    void Promise.all([
      decision ? setSetting("stream_last_decision", JSON.stringify(decision)) : Promise.resolve(),
      preview ? setSetting("stream_last_preview", JSON.stringify(preview)) : Promise.resolve(),
    ])
      .catch((error) => console.error(error))
      .finally(() => {
        decisionPersistBusy = false;
      });
  }, decisionPersistMs);

  const heartbeatTimer = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void markWorker(stopped ? "paused" : subscribed ? "streaming" : "connected", {
      symbol: symbol(),
      mode: "MetaApi WebSocket event-driven intrabar + single DB preflight",
      autoExec: autoExecEnabled(),
      m1: m1.length,
      m5: m5.length,
    })
      .catch((error) => console.error(error))
      .finally(() => {
        heartbeatBusy = false;
      });
  }, heartbeatMs);

  const shutdown = async (reason: string) => {
    clearInterval(controlTimer);
    clearInterval(syncTimer);
    clearInterval(quotePersistTimer);
    clearInterval(decisionPersistTimer);
    clearInterval(heartbeatTimer);
    try {
      ready = false;
      await markWorker("stopping", { reason });
      if (subscribed) await connection.unsubscribeFromMarketData(symbol(), marketDataUnsubscriptions).catch(() => undefined);
      connection.removeSynchronizationListener(listener);
      await connection.close();
      await markWorker("stopped", { reason });
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
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

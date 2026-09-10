import MetaApi, { SynchronizationListener } from "metaapi.cloud-sdk";
import { dbQuery, ensureSchema, getSettings, setSetting } from "../src/lib/server/db";
import { autoExecEnabled, clampLots, lots, lotsMax, lotsMin, resolveLots } from "../src/lib/server/tradingConfig";
import { EXEC_LOTS_SETTING_KEY, lossAtStop } from "../src/lib/lots";
import { money, sendTelegram } from "../src/lib/server/notify";
import { deals, fetchCandles, symbol } from "../src/lib/server/metaApi";
import { getSessionStatus, sessionConfigFromEnv, sessionWindowStart } from "../src/lib/session";
import { contextM5M15, evaluateScalper, plannedEntryValid, STRATEGY_VERSION } from "../src/lib/server/scalperStrategy";
import { aggregateM15, closedBars } from "../src/lib/server/marketStructure";
import {
  applyAction, closeReasonFromState, countsAsLoss, entryBlockedByOpenPositions, isManagedSetup,
  m5CloseAction, openManagedExit, oppositeSignalIgnored, referencePrice, tickAction,
  type ManagedCloseReason, type ManagedExitState,
} from "../src/lib/server/positionManager";
import { riskPerLot } from "../src/lib/server/orderSafety";
import { staleQuoteDecision } from "../src/lib/server/staleQuoteGuard";
import { encodeWorkerHeartbeat } from "../src/lib/server/workerHeartbeat";
import { setupLabel } from "../src/lib/setups";
import { executeStreaming, reserveStreamingSignal, syncStreamingExecutor, type StreamingConnectionLike } from "../src/lib/server/streamingExecutor";
import type { Candle, Quote, ScalperSignal, SetupEvaluation } from "../src/lib/types";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} non impostata`);
  return value;
}

function envNum(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
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
  return Number.NaN;
}

function quoteFromPrice(price: Record<string, unknown>): Quote | null {
  const bid = Number(price.bid);
  const ask = Number(price.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid || !Number.isFinite(priceTimeMs(price))) return null;
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
  const now = new Date();
  await Promise.all([
    setSetting("stream_worker_status", status),
    setSetting("stream_worker_heartbeat", encodeWorkerHeartbeat(now, extra?.quoteAgeSec)),
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

type ManagedPosition = {
  id: string;
  symbol: string;
  openPrice: number;
  volume?: number;
  clientId?: string;
  type?: string;
  time?: string | Date;
};

type ManagedOrder = {
  id: string;
  symbol: string;
};

type FlattenConnection = StreamingConnectionLike & {
  terminalState: StreamingConnectionLike["terminalState"] & { orders?: ManagedOrder[] };
  cancelOrder: (orderId: string) => Promise<Record<string, unknown>>;
  modifyPosition: (positionId: string, stopLoss?: number, takeProfit?: number) => Promise<Record<string, unknown>>;
};

/** Motivo di chiusura scritto dalle chiusure forzate: il resto lo deduce il piano di uscita. */
const FORCED_CLOSE_REASON: Record<string, ManagedCloseReason> = {
  end_of_session: "flatten",
  system_stop: "stop",
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positionDirection(position: ManagedPosition): "BUY" | "SELL" | null {
  const type = String(position.type ?? "").toUpperCase();
  if (type.includes("BUY")) return "BUY";
  if (type.includes("SELL")) return "SELL";
  return null;
}

function assertTradeAccepted(result: Record<string, unknown>, label: string) {
  const numericCode = Number(result.numericCode);
  const stringCode = typeof result.stringCode === "string"
    ? result.stringCode
    : typeof result.description === "string"
      ? result.description
      : "";
  if (!stringCode && !Number.isFinite(numericCode)) return;
  if ([10008, 10009, 10010].includes(numericCode)) return;
  if (["TRADE_RETCODE_PLACED", "TRADE_RETCODE_DONE", "TRADE_RETCODE_DONE_PARTIAL"].includes(stringCode)) return;
  throw new Error(`${label} rifiutata da MetaApi: ${stringCode || numericCode || "codice sconosciuto"}`);
}

async function retryTrade(label: string, action: () => Promise<Record<string, unknown>>) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await action();
      assertTradeAccepted(result, label);
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(250 * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} fallita`);
}

function noTradeDecision(
  reasoning: string,
  quote: Quote | null,
  extra: { mode?: string; setup?: string | null; evaluations?: SetupEvaluation[] } = {},
) {
  return {
    at: new Date().toISOString(),
    mode: extra.mode ?? "session_guard",
    direction: "NO_TRADE",
    setup: extra.setup ?? null,
    reasoning,
    quote,
    evaluations: extra.evaluations ?? [],
  };
}

async function main() {
  await ensureSchema();
  await dbQuery(`ALTER TABLE scalper_signals ADD COLUMN IF NOT EXISTS client_id text`);
  const token = required("METAAPI_TOKEN");
  const accountId = required("METAAPI_ACCOUNT_ID");
  const m1Max = envInt("SCALPER_M1_CANDLES", 500, 50, 1000);
  const m5Max = envInt("SCALPER_M5_CANDLES", 300, 120, 1000);
  const controlPollMs = envInt("SCALPER_CONTROL_POLL_MS", 250, 100, 10_000);
  const heartbeatMs = envInt("SCALPER_STREAM_HEARTBEAT_MS", 3000, 1000, 60_000);
  const syncMs = envInt("SCALPER_STREAM_SYNC_MS", 250, 100, 30_000);
  const quotePersistMs = envInt("SCALPER_STREAM_QUOTE_PERSIST_MS", 500, 100, 10_000);
  const decisionPersistMs = envInt("SCALPER_STREAM_DECISION_PERSIST_MS", 500, 100, 10_000);
  const maxOpenPositions = envInt("SCALPER_MAX_OPEN_POSITIONS", 1, 1, 3);
  const dupCooldownMs = envInt("DUP_COOLDOWN_S", 90, 0, 3600) * 1000;
  const dupSetupBars = envInt("DUP_SETUP_BARS", 3, 0, 30);
  const tickLogMs = envInt("SCALPER_TICK_LOG_MS", 1000, 0, 60_000);
  const lossLockRefreshMs = envInt("SCALPER_LOSS_LOCK_REFRESH_MS", 30_000, 5_000, 300_000);
  const lossLockMs = envInt("LOSS_LOCK_MINUTES", 30, 0, 1440) * 60_000;
  const consecLossPauseMs = envInt("CONSEC_LOSS_PAUSE_MINUTES", 120, 0, 1440) * 60_000;
  const consecLossCount = envInt("CONSEC_LOSS_COUNT", 3, 2, 10);
  const riskMaxPct = envNum("RISK_MAX_PCT", 0);
  const riskFallbackLots = envNum("RISK_FALLBACK_LOTS", 0.01);
  const maxTradesPerDay = envInt("MAX_TRADES_PER_DAY", 12, 1, 1000);
  const tradeDedupSeconds = envNum("TRADE_DEDUP_SECONDS", 30);
  const reentryMs = envInt("SCALPER_MIN_REENTRY_SEC", 120, 0, 3600) * 1000;
  const finalQuoteMaxAgeMs = envInt("SCALPER_FINAL_QUOTE_MAX_AGE_MS", 2000, 250, 10_000);
  const staleQuoteSec = envInt("STALE_QUOTE_SEC", 120, 30, 3600);
  const staleQuoteExitSec = Math.max(staleQuoteSec + 30, envInt("STALE_QUOTE_EXIT_SEC", 300, 60, 7200));
  const sessionConfig = sessionConfigFromEnv();
  const workerStartedAtMs = Date.now();

  const api = new MetaApi(token);
  const account = await api.metatraderAccountApi.getAccount(accountId);
  let connection = account.getStreamingConnection();
  let tradingConnection = connection as unknown as FlattenConnection;

  let subscribed = false;
  let ready = false;
  let activeLots = lots();

  const refreshControl = async () => {
    const settings = await getSettings(["system_stop", EXEC_LOTS_SETTING_KEY]);
    activeLots = resolveLots(settings.get(EXEC_LOTS_SETTING_KEY));
    return settings.get("system_stop") === "true";
  };

  let stopped = await refreshControl();
  let m1: Candle[] = [];
  let m5: Candle[] = [];
  let latestQuote: Quote | null = null;
  let lastQuoteReceivedAtMs = 0;
  let quoteWatchStartedAtMs = workerStartedAtMs;
  let latestDecision: Record<string, unknown> | null = null;
  let latestPreview: Record<string, unknown> | null = null;
  let decisionBusy = false;
  let controlBusy = false;
  let syncBusy = false;
  let heartbeatBusy = false;
  let quotePersistBusy = false;
  let decisionPersistBusy = false;
  let flattenBusy = false;
  let staleReconnectBusy = false;
  let staleExitBusy = false;
  let signalLockUntil = 0;
  let orderErrorUntil = 0;
  let lastEmptyFlattenMarker: string | null = null;
  const dupDirectionUntil: Record<"BUY" | "SELL", number> = { BUY: 0, SELL: 0 };
  const dupSetupUntilBucket = new Map<string, number>();
  const lossLockUntil: Record<"BUY" | "SELL", number> = { BUY: 0, SELL: 0 };
  let lossPauseUntil = 0;
  const knownPositionIds = new Set<string>();
  let lastPositionCloseAt = 0;
  let lastReseedAttempt = 0;
  // Piano di uscita dei setup gestiti, per posizione. Sopravvive ai riavvii via scalper_signals.
  const managedExits = new Map<string, ManagedExitState>();
  let managedBusy = false;
  let lastM5CloseSeen = 0;
  const breakevenBuffer = envNum("ENTRY_BUFFER_USD", 0.1);

  const closedAtMs = (value: unknown) => {
    const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ""));
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const refreshLossGuards = async () => {
    const start = sessionWindowStart(new Date(), sessionConfig);
    const result = await dbQuery(
      `SELECT direction,outcome,close_reason,closed_at FROM scalper_signals
        WHERE outcome IN ('WIN','LOSS','BREAKEVEN') AND mt5_position_id IS NOT NULL
          AND closed_at >= $1::timestamptz
        ORDER BY closed_at DESC LIMIT 50`,
      [start.toISOString()],
    );
    const rows = result.rows as Array<{ direction?: string; outcome?: string; close_reason?: string; closed_at?: unknown }>;
    lossLockUntil.BUY = 0;
    lossLockUntil.SELL = 0;
    lossPauseUntil = 0;
    // Solo sl_initial e' una perdita: breakeven, trailing, flatten, stop e watchdog non bloccano nulla.
    for (const row of rows) {
      if (!countsAsLoss(row.outcome, row.close_reason)) continue;
      const direction = row.direction === "BUY" || row.direction === "SELL" ? row.direction : null;
      if (!direction || lossLockUntil[direction] > 0) continue;
      lossLockUntil[direction] = closedAtMs(row.closed_at) + lossLockMs;
    }
    let streak = 0;
    for (const row of rows) {
      if (!countsAsLoss(row.outcome, row.close_reason)) break;
      streak += 1;
      if (streak >= consecLossCount) {
        lossPauseUntil = closedAtMs(rows[0]?.closed_at) + consecLossPauseMs;
        break;
      }
    }
  };

  const hhmmUtc = (ms: number) => new Date(ms).toISOString().slice(11, 16);

  const lossGuards = () => {
    const now = Date.now();
    const directions = (["BUY", "SELL"] as const).filter((direction) => lossLockUntil[direction] > now);
    return {
      lossLockedDirections: [...directions],
      lossLockUntil: Object.fromEntries(directions.map((direction) => [direction, new Date(lossLockUntil[direction]).toISOString()])),
      lossPauseUntil: lossPauseUntil > now ? new Date(lossPauseUntil).toISOString() : null,
      lossLockMinutes: Math.round(lossLockMs / 60_000),
      consecLossPauseMinutes: Math.round(consecLossPauseMs / 60_000),
    };
  };

  const lossGuardLine = () => {
    const now = Date.now();
    const parts = (["BUY", "SELL"] as const)
      .filter((direction) => lossLockUntil[direction] > now)
      .map((direction) => `${direction} bloccato fino alle ${hhmmUtc(lossLockUntil[direction])} UTC`);
    if (lossPauseUntil > now) parts.push(`pausa ${consecLossCount} perdite consecutive fino alle ${hhmmUtc(lossPauseUntil)} UTC`);
    return parts.length > 0 ? parts.join(" \u00b7 ") : "nessun blocco da perdita attivo";
  };

  let lastTickLogKey = "";
  let lastTickLogAt = 0;

  const marketDataSubscriptions = [{ type: "quotes" as const }];
  const marketDataUnsubscriptions = [{ type: "quotes" as const }];

  const accountSnapshot = () => {
    const info = tradingConnection.terminalState.accountInformation;
    if (!info) return null;
    const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : null);
    return {
      balance: num(info.balance),
      equity: num(info.equity),
      margin: num(info.margin),
      freeMargin: num(info.freeMargin),
      leverage: num(info.leverage),
      currency: typeof info.currency === "string" ? info.currency : null,
    };
  };

  const balanceLine = () => {
    const account = accountSnapshot();
    if (!account) return "saldo n/d";
    return `saldo ${money(account.balance)} ${account.currency ?? "USD"} · libero ${money(account.freeMargin)}`;
  };

  let lastNotifiedBlock: string | null = null;
  const notifyBlock = (reason: string) => {
    if (lastNotifiedBlock === reason) return;
    lastNotifiedBlock = reason;
    void sendTelegram(`\u26d4 SCALPER ${symbol()} · ingresso bloccato: ${reason}\n${balanceLine()}`);
  };

  const workerDetail = () => ({
    symbol: symbol(),
    mode: `M15 trend / M5 pullback-retest / M1 chiusa + max ${maxOpenPositions} posizioni`,
    strategyVersion: STRATEGY_VERSION,
    autoExec: autoExecEnabled(),
    lots: activeLots,
    lotsMin: lotsMin(),
    lotsMax: lotsMax(),
    account: accountSnapshot(),
    openPositions: (tradingConnection.terminalState.positions ?? []).filter((position) => position.symbol === symbol()).length,
    maxOpenPositions,
    maxTradesPerDay,
    tradeDedupSeconds,
    managed: [...managedExits.values()].map((state) => ({
      positionId: state.positionId,
      setup: state.setup,
      direction: state.direction,
      openPrice: state.openPrice,
      initialStop: state.initialStop,
      target1: state.target1,
      stopLoss: state.stopLoss,
      target1Hit: state.target1Hit,
      breakevenPrice: state.breakevenPrice,
      breakevenAt: state.breakevenAt,
      trailingActive: state.trailingUpdates > 0,
      trailingUpdates: state.trailingUpdates,
    })),
    riskMaxPct,
    riskCapActive: riskMaxPct > 0,
    finalQuoteMaxAgeMs,
    quoteAgeSec: Math.max(0, Math.floor((Date.now() - (lastQuoteReceivedAtMs || quoteWatchStartedAtMs)) / 1000)),
    quoteReceivedAt: lastQuoteReceivedAtMs > 0 ? new Date(lastQuoteReceivedAtMs).toISOString() : null,
    staleQuoteSec,
    staleQuoteExitSec,
    ...lossGuards(),
    m1: m1.length,
    m5: m5.length,
    m15: aggregateM15(closedBars(m5, 5, Date.now()) ?? []).length,
    hoursUtc: sessionConfig.hoursUtc,
    flattenBeforeEndMin: sessionConfig.flattenBeforeEndMin,
    fridayCloseUtc: sessionConfig.fridayCloseUtc,
  });

  // --- Uscita gestita di m1_short e m1_range ---------------------------------------------------
  // Nessun TP al broker e nessun limite di durata: l'ordine parte col solo SL, target1 porta lo
  // stop a breakeven e da li' lo stop segue gli swing M5. Lo stop non torna mai indietro.

  const persistManagedExit = async (state: ManagedExitState) => {
    const values = [state.breakevenPrice, state.breakevenAt, state.trailingUpdates, state.trailingUpdates > 0, state.stopLoss];
    if (state.signalId) {
      await dbQuery(
        `UPDATE scalper_signals SET breakeven_price=$2,breakeven_at=$3::timestamptz,trailing_updates=$4,
                trailing_active=$5,final_sl=$6
          WHERE id=$1`,
        [state.signalId, ...values],
      );
    }
    // La riga trades nasce alla chiusura: finche' il trade e' aperto questo update non tocca nulla.
    await dbQuery(
      `UPDATE trades SET breakeven_price=$2,breakeven_at=$3::timestamptz,trailing_updates=$4,
              trailing_active=$5,final_sl=$6
        WHERE source='scalper' AND mt5_position_id=$1`,
      [state.positionId, ...values],
    );
  };

  /** Riprende i piani di uscita aperti: dopo un riavvio il worker ritrova breakeven e trailing. */
  const restoreManagedExits = async () => {
    const result = await dbQuery(
      `SELECT id::text AS id,setup,direction,mt5_position_id,mt5_open_price,entry,stop_loss,target1,take_profit,
              final_sl,breakeven_price,breakeven_at,trailing_updates
         FROM scalper_signals
        WHERE outcome IS NULL AND mt5_position_id IS NOT NULL`,
    );
    for (const row of result.rows) {
      const positionId = String(row.mt5_position_id ?? "");
      if (!positionId || !isManagedSetup(row.setup) || managedExits.has(positionId)) continue;
      const openPrice = Number(row.mt5_open_price ?? row.entry);
      const target1 = Number(row.target1 ?? row.take_profit);
      const initialStop = Number(row.stop_loss);
      if (![openPrice, target1, initialStop].every((value) => Number.isFinite(value))) continue;
      const breakevenAt = row.breakeven_at ? new Date(row.breakeven_at).toISOString() : null;
      managedExits.set(positionId, {
        positionId,
        signalId: String(row.id),
        setup: String(row.setup),
        direction: row.direction === "SELL" ? "SELL" : "BUY",
        openPrice,
        initialStop,
        target1,
        stopLoss: Number.isFinite(Number(row.final_sl)) ? Number(row.final_sl) : initialStop,
        target1Hit: breakevenAt !== null,
        breakevenPrice: Number.isFinite(Number(row.breakeven_price)) ? Number(row.breakeven_price) : null,
        breakevenAt,
        trailingUpdates: Number(row.trailing_updates ?? 0),
      });
    }
  };

  /** Chiusura confermata da MetaApi: fissa il motivo dedotto dal piano, senza sovrascrivere le forzate. */
  const finalizeManagedExit = async (state: ManagedExitState) => {
    const closeReason = closeReasonFromState(state);
    console.log("[scalper-worker] managed_exit_closed", JSON.stringify({
      at: new Date().toISOString(),
      positionId: state.positionId,
      signalId: state.signalId,
      setup: state.setup,
      direction: state.direction,
      closeReason,
      finalSl: state.stopLoss,
      breakevenAt: state.breakevenAt,
      trailingUpdates: state.trailingUpdates,
    }));
    if (!state.signalId) return;
    await dbQuery(
      `UPDATE scalper_signals
          SET close_reason=COALESCE(close_reason,$2),final_sl=COALESCE(final_sl,$3),
              trailing_updates=$4,trailing_active=$5,breakeven_price=$6,breakeven_at=$7::timestamptz
        WHERE id=$1`,
      [state.signalId, closeReason, state.stopLoss, state.trailingUpdates, state.trailingUpdates > 0,
        state.breakevenPrice, state.breakevenAt],
    );
  };

  const driveManagedExits = async (openPositions: ManagedPosition[], quote: Quote) => {
    if (managedBusy) return;
    const closedM5 = closedBars(m5, 5, Date.now()) ?? [];
    const lastM5At = closedM5.length > 0 ? Date.parse(closedM5.at(-1)!.datetime) : 0;
    // Senza posizioni gestite si tiene solo il segnaposto: il trailing partira' dalla prossima M5.
    if (managedExits.size === 0 || stopped || flattenBusy) {
      if (managedExits.size === 0 && Number.isFinite(lastM5At)) lastM5CloseSeen = lastM5At;
      return;
    }
    managedBusy = true;
    const freshM5Close = Number.isFinite(lastM5At) && lastM5At > lastM5CloseSeen;
    try {
      for (const position of openPositions) {
        const state = managedExits.get(position.id);
        if (!state) continue;
        let current = state;

        // 1. Primo tick che tocca target1 (BID sui long, ASK sugli short): stop a breakeven.
        const breakeven = tickAction(current, quote, Date.now(), breakevenBuffer);
        if (breakeven && breakeven.kind === "breakeven") {
          try {
            await retryTrade(`Breakeven posizione ${position.id}`, () => tradingConnection.modifyPosition(position.id, breakeven.stopLoss));
            current = applyAction(current, breakeven);
            managedExits.set(position.id, current);
            console.log("[scalper-worker] breakeven_set", JSON.stringify({
              at: breakeven.at,
              positionId: position.id,
              signalId: current.signalId,
              setup: current.setup,
              direction: current.direction,
              openPrice: current.openPrice,
              target1: current.target1,
              price: referencePrice(current.direction, quote),
              stopLoss: breakeven.stopLoss,
              previousStopLoss: state.stopLoss,
            }));
            await persistManagedExit(current);
            void sendTelegram(
              `\u{1f512} SCALPER ${symbol()} \u00b7 breakeven ${current.direction} ${setupLabel(current.setup)}:`
              + ` target1 ${money(current.target1)} raggiunto, SL a ${money(breakeven.stopLoss)}`
              + ` (${breakeven.at.slice(11, 19)} UTC).`,
            );
          } catch (error) {
            await setSetting("stream_last_error", `${new Date().toISOString()} Breakeven ${position.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        // 2. Trailing sulla struttura M5: solo dopo il breakeven e solo a M5 chiusa.
        if (!freshM5Close) continue;
        const trailing = m5CloseAction(current, closedM5);
        if (!trailing || trailing.kind !== "trailing") continue;
        try {
          await retryTrade(`Trailing posizione ${position.id}`, () => tradingConnection.modifyPosition(position.id, trailing.to));
          current = applyAction(current, trailing);
          managedExits.set(position.id, current);
          console.log("[scalper-worker] trailing_update", JSON.stringify({
            at: new Date().toISOString(),
            positionId: position.id,
            signalId: current.signalId,
            setup: current.setup,
            direction: current.direction,
            from: trailing.from,
            to: trailing.to,
            swingAt: trailing.swingAt,
            trailingUpdates: current.trailingUpdates,
          }));
          await persistManagedExit(current);
        } catch (error) {
          await setSetting("stream_last_error", `${new Date().toISOString()} Trailing ${position.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (freshM5Close) lastM5CloseSeen = lastM5At;
    } finally {
      managedBusy = false;
    }
  };

  let lastOppositeKey = "";
  let lastOppositeAt = 0;
  /** Segnale contrario con una posizione aperta: non chiude e non inverte, resta solo a log. */
  const logIgnoredOppositeSignal = (signal: ScalperSignal, quote: Quote, openDirection: string) => {
    const key = `${signal.setup ?? "-"}|${signal.direction}|${openDirection}`;
    const now = Date.now();
    if (key === lastOppositeKey && now - lastOppositeAt < tickLogMs) return;
    lastOppositeKey = key;
    lastOppositeAt = now;
    console.log("[scalper-worker] ignored_opposite_signal", JSON.stringify({
      at: new Date(now).toISOString(),
      setup: signal.setup,
      direction: signal.direction,
      openDirection,
      mid: quote.mid,
    }));
  };

  const findSignalForPosition = async (position: ManagedPosition) => {
    let result = await dbQuery(
      `SELECT id,direction,entry,stop_loss,mt5_open_price,created_at
         FROM scalper_signals
        WHERE mt5_position_id=$1
        ORDER BY created_at DESC LIMIT 1`,
      [position.id],
    );
    if (result.rows[0] || !position.clientId) return result.rows[0] ?? null;

    result = await dbQuery(
      `SELECT id,direction,entry,stop_loss,mt5_open_price,created_at
         FROM scalper_signals
        WHERE client_id=$1
        ORDER BY created_at DESC LIMIT 1`,
      [position.clientId],
    );
    if (result.rows[0]) {
      await dbQuery(
        `UPDATE scalper_signals
            SET mt5_position_id=COALESCE(mt5_position_id,$2),mt5_open_price=COALESCE(mt5_open_price,$3)
          WHERE id=$1`,
        [result.rows[0].id, position.id, position.openPrice],
      );
    }
    return result.rows[0] ?? null;
  };

  const recordClosedPosition = async (position: ManagedPosition, reason: string) => {
    let history: Awaited<ReturnType<typeof deals>> = [];
    let out: Awaited<ReturnType<typeof deals>>[number] | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      history = await deals(position.id);
      out = history
        .filter((deal) => deal.entryType && deal.entryType !== "DEAL_ENTRY_IN")
        .sort((a, b) => Date.parse(a.time ?? "") - Date.parse(b.time ?? ""))
        .at(-1);
      if (out && Number.isFinite(Number(out.price))) break;
      if (attempt < 3) await sleep(300 * 2 ** (attempt - 1));
    }
    if (!out || !Number.isFinite(Number(out.price))) {
      throw new Error(`Storico chiusura non disponibile per posizione ${position.id}`);
    }

    const inn = history
      .filter((deal) => deal.entryType === "DEAL_ENTRY_IN")
      .sort((a, b) => Date.parse(a.time ?? "") - Date.parse(b.time ?? ""))[0];
    const close = Number(out.price);
    const profit = Number(out.profit ?? 0);
    const signal = await findSignalForPosition(position);

    if (signal) {
      const open = Number(signal.mt5_open_price ?? inn?.price ?? position.openPrice ?? signal.entry);
      const risk = Math.abs(open - Number(signal.stop_loss));
      const signed = Number(signal.entry) < Number(signal.stop_loss) ? open - close : close - open;
      const resultR = risk > 0 ? Number((signed / risk).toFixed(2)) : 0;
      // Chiusura forzata: il motivo e' noto e sovrascrive quello dedotto dal piano di uscita.
      const closeReason = FORCED_CLOSE_REASON[reason] ?? reason;
      await dbQuery(
        `UPDATE scalper_signals
            SET mt5_position_id=COALESCE(mt5_position_id,$2),mt5_open_price=COALESCE(mt5_open_price,$3),
                mt5_close_price=$4,mt5_profit=$5,outcome=$6,result_r=$7,closed_at=COALESCE($8::timestamptz,now()),
                mt5_volume=COALESCE(mt5_volume,$9),close_reason=$10,final_sl=COALESCE(final_sl,stop_loss)
          WHERE id=$1`,
        [
          signal.id,
          position.id,
          open,
          close,
          profit,
          profit > 0 ? "WIN" : profit < 0 ? "LOSS" : "BREAKEVEN",
          resultR,
          out.time ?? null,
          Number(position.volume ?? inn?.volume ?? lots()),
          closeReason,
        ],
      );
      await dbQuery(
        `UPDATE trades SET reason=$2,close_reason=$3,
                payload=COALESCE(payload,'{}'::jsonb)||jsonb_build_object('closeReason',$3)
          WHERE source='scalper' AND mt5_position_id=$1`,
        [position.id, reason, closeReason],
      );
      const outcome = profit > 0 ? "WIN" : profit < 0 ? "LOSS" : "BREAKEVEN";
      void sendTelegram(
        `${profit > 0 ? "\u2705" : profit < 0 ? "\u274c" : "\u2796"} SCALPER ${symbol()} · chiusura ${outcome} (${closeReason})`
        + `\nprofitto ${money(profit)} · ${money(open)} \u2192 ${money(close)} · ${resultR >= 0 ? "+" : ""}${resultR}R`
        + `\n${balanceLine()}`,
      );
      return;
    }

    const direction = String(position.type ?? "").includes("SELL") ? "SELL" : String(position.type ?? "").includes("BUY") ? "BUY" : null;
    const openedAt = position.time instanceof Date ? position.time.toISOString() : typeof position.time === "string" ? position.time : null;
    const lot = Number(position.volume ?? inn?.volume ?? lots());
    const externalParams = [symbol(), position.id, direction, position.openPrice ?? inn?.price ?? null, close, profit, reason, openedAt, out.time ?? null, JSON.stringify({ volume: position.volume ?? null }), lot];
    const updated = await dbQuery(
      `UPDATE trades SET direction=$3,open_price=$4,close_price=$5,profit=$6,reason=$7,opened_at=$8,
              closed_at=COALESCE($9::timestamptz,now()),payload=$10::jsonb,lot=$11
        WHERE source='flatten_external' AND symbol=$1 AND mt5_position_id=$2`,
      externalParams,
    );
    if (updated.rowCount === 0) {
      await dbQuery(
        `INSERT INTO trades(source,scalper_signal_id,symbol,mt5_position_id,direction,open_price,close_price,profit,result_r,reason,opened_at,closed_at,payload,lot)
         VALUES('flatten_external',NULL,$1,$2,$3,$4,$5,$6,NULL,$7,$8,COALESCE($9::timestamptz,now()),$10::jsonb,$11)`,
        externalParams,
      );
    }
  };

  const flattenSymbol = async (reason: "end_of_session" | "system_stop", marker: string) => {
    if (flattenBusy) return;
    flattenBusy = true;
    const at = new Date().toISOString();
    const closed: string[] = [];
    const canceled: string[] = [];
    const failures: string[] = [];
    try {
      const positions = [...(tradingConnection.terminalState.positions ?? [])]
        .filter((position) => position.symbol === symbol()) as ManagedPosition[];
      const orders = [...(tradingConnection.terminalState.orders ?? [])]
        .filter((order) => order.symbol === symbol());

      if (positions.length === 0 && orders.length === 0) {
        if (lastEmptyFlattenMarker !== marker) {
          lastEmptyFlattenMarker = marker;
          await setSetting("stream_last_flatten", JSON.stringify({ at, closed, canceled, reason }));
        }
        return;
      }

      for (const position of positions) {
        try {
          await retryTrade(`Chiusura posizione ${position.id}`, () => tradingConnection.closePosition(position.id));
          closed.push(position.id);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }

      for (const order of orders) {
        try {
          await retryTrade(`Cancellazione ordine ${order.id}`, () => tradingConnection.cancelOrder(order.id));
          canceled.push(order.id);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }

      for (const position of positions.filter((item) => closed.includes(item.id))) {
        managedExits.delete(position.id);
        try {
          await recordClosedPosition(position, reason);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }

      await refreshLossGuards().catch(() => undefined);
      await setSetting("stream_last_flatten", JSON.stringify({ at, closed, canceled, reason, failures }));
      if (reason === "end_of_session") {
        void sendTelegram(
          `\u{1f514} SCALPER ${symbol()} · flatten fine sessione`
          + `\nposizioni chiuse ${closed.length} · ordini cancellati ${canceled.length}`
          + `${failures.length > 0 ? `\nerrori: ${failures.join(" | ")}` : ""}`
          + `\n${balanceLine()}`,
        );
      }
      if (failures.length > 0) {
        const message = `Flatten ${reason} incompleto: ${failures.join(" | ")}`;
        await setSetting("stream_last_error", `${new Date().toISOString()} ${message}`);
        throw new Error(message);
      }
      lastEmptyFlattenMarker = marker;
      signalLockUntil = 0;
    } finally {
      flattenBusy = false;
    }
  };

  const logTick = (signal: ScalperSignal, quote: Quote, blocked?: string) => {
    const evaluations = signal.evaluations ?? [];
    const key = `${signal.direction}|${signal.setup ?? "-"}|${blocked ?? ""}|`
      + evaluations.map((item) => `${item.setup}:${item.status}:${item.reason}`).join(";");
    const now = Date.now();
    if (key === lastTickLogKey && now - lastTickLogAt < tickLogMs) return;
    lastTickLogKey = key;
    lastTickLogAt = now;
    console.log("[scalper-worker] tick", JSON.stringify({
      at: new Date(now).toISOString(),
      symbol: symbol(),
      mid: quote.mid,
      spread: quote.spread,
      direction: signal.direction,
      setup: signal.setup,
      blocked: blocked ?? null,
      setups: evaluations.map((item) => ({ setup: item.setup, status: item.status, direction: item.direction ?? null, reason: item.reason })),
    }));
  };

  const sessionGuard = (quote: Quote | null) => {
    const status = getSessionStatus(new Date(), sessionConfig);
    if (status.weekendClosed) return { allowed: false, status, reasoning: "Mercato chiuso (weekend)" };
    if (status.inFlattenWindow) return { allowed: false, status, reasoning: `Chiusura sessione tra ${status.minutesUntilEnd ?? 0} min` };
    if (!status.inside) return { allowed: false, status, reasoning: `Fuori fascia scalper ${sessionConfig.hoursUtc} UTC` };
    return { allowed: true, status, reasoning: null as string | null };
  };

  const markSkipped = async (signalId: string, reason: string) => {
    await dbQuery(
      `UPDATE scalper_signals SET outcome='SKIPPED',closed_at=now(),mt5_error=$2 WHERE id=$1`,
      [signalId, reason],
    );
  };

  const quoteAgeMs = (quote: Quote | null) => {
    if (!quote || quote.quotedAt === null || !Number.isFinite(quote.quotedAt)) return Number.POSITIVE_INFINITY;
    return Math.max(0, Date.now() - quote.quotedAt);
  };

  const onPrice = async (price: Record<string, unknown>) => {
    if (!ready || stopped || !subscribed) return;
    const priceSymbol = typeof price.symbol === "string" ? price.symbol : symbol();
    if (priceSymbol !== symbol()) return;

    const quote = quoteFromPrice(price);
    if (!quote) return;
    if (quote.quotedAt! > Date.now() + 500 || Date.now() - quote.quotedAt! > finalQuoteMaxAgeMs
      || (latestQuote?.quotedAt && quote.quotedAt! < latestQuote.quotedAt)) return;
    lastQuoteReceivedAtMs = Date.now();
    const previousQuoteAt = latestQuote?.quotedAt ?? 0;
    if (previousQuoteAt > 0 && quote.quotedAt! - previousQuoteAt > 60_000 && Date.now() - lastReseedAttempt > 30_000) {
      lastReseedAttempt = Date.now();
      ready = false;
      try {
        const seeded = await seedCandles(m1Max, m5Max);
        m1 = seeded.m1; m5 = seeded.m5;
      } catch (error) {
        await setSetting("stream_last_error", new Date().toISOString() + " Ripristino storico dopo gap: " + String(error));
        return;
      } finally { ready = !stopped; }
      // Reevaluate only on the next fresh quote, after history has been restored.
      latestQuote = quote;
      return;
    }
    latestQuote = quote;

    upsertTick(m1, 1, quote.bid, quote.quotedAt ?? Date.now(), m1Max);
    upsertTick(m5, 5, quote.bid, quote.quotedAt ?? Date.now(), m5Max);

    const gate = sessionGuard(quote);
    if (!gate.allowed) {
      latestDecision = noTradeDecision(gate.reasoning!, quote);
      return;
    }

    // Le posizioni si leggono da terminalState: una posizione e' chiusa solo dopo conferma MetaApi.
    const openPositions = (tradingConnection.terminalState.positions ?? [])
      .filter((position) => position.symbol === symbol()) as ManagedPosition[];

    const openIds = new Set(openPositions.map((position) => position.id));
    for (const id of [...knownPositionIds]) {
      if (openIds.has(id)) continue;
      knownPositionIds.delete(id);
      lastPositionCloseAt = Date.now();
      const closing = managedExits.get(id);
      if (!closing) continue;
      managedExits.delete(id);
      void finalizeManagedExit(closing).catch((error) => console.error(error));
    }
    for (const id of openIds) knownPositionIds.add(id);

    // Breakeven e trailing girano anche mentre un ingresso e' in corso: sono gestione, non ingresso.
    await driveManagedExits(openPositions, quote);

    if (m1.length < 35 || m5.length < 30) return;
    if (decisionBusy || Date.now() < signalLockUntil || Date.now() < orderErrorUntil || flattenBusy) return;

    if (entryBlockedByOpenPositions(openPositions.length, maxOpenPositions)) {
      // In posizione nessun setup viene valutato per l'ingresso: la valutazione resta diagnostica e
      // serve solo a registrare i segnali contrari, che non chiudono e non invertono mai.
      const watching = evaluateScalper({ quote, m1, m5 });
      const reason = `Limite ${maxOpenPositions} posizioni XAUUSD aperte raggiunto.`;
      latestDecision = noTradeDecision(reason, quote, { setup: watching.setup, evaluations: watching.evaluations });
      const openDirections = openPositions.map(positionDirection).filter((value): value is "BUY" | "SELL" => value !== null);
      if (oppositeSignalIgnored(openDirections, watching.direction)) {
        logIgnoredOppositeSignal(watching, quote, openDirections.join("/"));
      }
      logTick(watching, quote, reason);
      return;
    }

    const signal = evaluateScalper({ quote, m1, m5 });
    latestDecision = {
      at: new Date().toISOString(),
      mode: "event_driven_intrabar_fast_preflight",
      direction: signal.direction,
      setup: signal.setup,
      reasoning: signal.reasoning,
      quote,
      evaluations: signal.evaluations,
    };

    if (signal.direction === "NO_TRADE") {
      logTick(signal, quote);
      return;
    }

    if (openPositions.length > 0) {
      const directions = openPositions.map(positionDirection);
      if (directions.some((direction) => direction === null)) {
        const reason = "Direzione di una posizione XAUUSD aperta non leggibile: nuovo ingresso bloccato per sicurezza.";
        latestDecision = noTradeDecision(reason, quote, { setup: signal.setup, evaluations: signal.evaluations });
        logTick(signal, quote, reason);
        return;
      }
      if (directions.some((direction) => direction !== signal.direction)) {
        const reason = `Posizioni XAUUSD già aperte in direzione opposta a ${signal.direction}.`;
        latestDecision = noTradeDecision(reason, quote, { setup: signal.setup, evaluations: signal.evaluations });
        logTick(signal, quote, reason);
        return;
      }
    }

    const guardNow = Date.now();
    const sinceLastClose = guardNow - lastPositionCloseAt;
    if (lastPositionCloseAt > 0 && sinceLastClose < reentryMs) {
      const reason = `Pausa re-entry dopo la chiusura: altri ${Math.ceil((reentryMs - sinceLastClose) / 1000)} s prima di un nuovo ingresso.`;
      latestDecision = noTradeDecision(reason, quote, { setup: signal.setup, evaluations: signal.evaluations });
      logTick(signal, quote, reason);
      return;
    }
    if (lossPauseUntil > guardNow) {
      const reason = `Pausa dopo ${consecLossCount} perdite consecutive: nessun ingresso fino alle ${hhmmUtc(lossPauseUntil)} UTC.`;
      latestDecision = noTradeDecision(reason, quote, { setup: signal.setup, evaluations: signal.evaluations });
      notifyBlock(reason);
      logTick(signal, quote, reason);
      return;
    }
    if (lossLockUntil[signal.direction] > guardNow) {
      const reason = `Perdita recente in ${signal.direction}: direzione bloccata fino alle ${hhmmUtc(lossLockUntil[signal.direction])} UTC.`;
      latestDecision = noTradeDecision(reason, quote, { setup: signal.setup, evaluations: signal.evaluations });
      notifyBlock(reason);
      logTick(signal, quote, reason);
      return;
    }

    const nowMs = Date.now();
    const directionUntil = dupDirectionUntil[signal.direction];
    if (nowMs < directionUntil) {
      const reason = `Cooldown anti-duplicazione ${signal.direction}: altri ${Math.ceil((directionUntil - nowMs) / 1000)} s dopo l'ultimo ordine.`;
      latestDecision = noTradeDecision(reason, quote, { setup: signal.setup, evaluations: signal.evaluations });
      logTick(signal, quote, reason);
      return;
    }
    const setupUntilBucket = signal.setup ? dupSetupUntilBucket.get(signal.setup) ?? 0 : 0;
    if (bucketStart(nowMs, 1) < setupUntilBucket) {
      const barsLeft = Math.ceil((setupUntilBucket - bucketStart(nowMs, 1)) / 60_000);
      const reason = `Cooldown anti-duplicazione setup ${signal.setup}: altre ${barsLeft} candele M1 dopo l'ultimo ordine.`;
      latestDecision = noTradeDecision(reason, quote, { setup: signal.setup, evaluations: signal.evaluations });
      logTick(signal, quote, reason);
      return;
    }

    logTick(signal, quote);

    if (!autoExecEnabled()) {
      latestPreview = { at: new Date().toISOString(), ...signal };
      return;
    }

    decisionBusy = true;
    let reservedSignalId: string | null = null;
    let executionStarted = false;
    try {
      const preReservationGate = sessionGuard(quote);
      if (!preReservationGate.allowed) {
        latestDecision = noTradeDecision(preReservationGate.reasoning!, quote);
        return;
      }

      // Contesto M5/M15 dell'ingresso: viaggia con il segnale e finisce in trades.context_json.
      const entryContext = isManagedSetup(signal.setup)
        ? contextM5M15(closedBars(m5, 5, Date.now()) ?? [], Date.now())
        : null;
      const reservation = await reserveStreamingSignal({
        setupKey: signal.setupKey!,
        direction: signal.direction,
        setup: signal.setup,
        entry: signal.entry!,
        stopLoss: signal.stopLoss!,
        takeProfit: signal.takeProfit!,
        riskReward: signal.riskReward!,
        reasoning: signal.reasoning,
        openPositionCount: openPositions.length,
        context: entryContext === null ? null : {
          biasM5: entryContext.biasM5,
          m15State: entryContext.m15State,
          m15BreakoutRecent: entryContext.m15BreakoutRecent,
        },
      });

      if (!reservation.ok) {
        const blockedReason = "reason" in reservation ? String(reservation.reason ?? "") : "";
        if (["max_trades_per_day", "max_daily_loss", "three_loss_cooldown", "loss_cooldown"].includes(blockedReason)) {
          notifyBlock(blockedReason);
        }
        latestDecision = {
          at: new Date().toISOString(),
          mode: "event_driven_intrabar_fast_preflight",
          direction: signal.direction,
          setup: signal.setup,
          reasoning: signal.reasoning,
          quote,
          evaluations: signal.evaluations,
          execution: reservation,
        };
        return;
      }

      const signalId = reservation.signalId;
      reservedSignalId = signalId;
      const finalGate = sessionGuard(latestQuote ?? quote);
      if (!finalGate.allowed) {
        await markSkipped(signalId, finalGate.reasoning!);
        latestDecision = noTradeDecision(finalGate.reasoning!, latestQuote ?? quote, { setup: signal.setup, evaluations: signal.evaluations });
        return;
      }

      const finalQuote = latestQuote;
      const ageMs = quoteAgeMs(finalQuote);
      if (!finalQuote || ageMs > finalQuoteMaxAgeMs) {
        const reason = `Final preflight: quote non abbastanza fresca (${Number.isFinite(ageMs) ? `${Math.round(ageMs)} ms` : "n/d"}, massimo ${finalQuoteMaxAgeMs} ms).`;
        await markSkipped(signalId, reason);
        latestDecision = noTradeDecision(reason, finalQuote ?? quote, {
          mode: "final_strategy_preflight",
          setup: signal.setup,
          evaluations: signal.evaluations,
        });
        return;
      }

      const finalSignal = evaluateScalper({ quote: finalQuote, m1, m5 });
      if (finalSignal.direction !== signal.direction || finalSignal.setup !== signal.setup || finalSignal.setupKey !== signal.setupKey) {
        const reason = finalSignal.direction === "NO_TRADE"
          ? `Final preflight: ${signal.direction}/${signal.setup ?? "—"} invalidato — ${finalSignal.reasoning}`
          : `Final preflight: segnale cambiato ${signal.direction}/${signal.setup ?? "—"} → ${finalSignal.direction}/${finalSignal.setup ?? "—"}.`;
        await markSkipped(signalId, reason);
        latestDecision = {
          at: new Date().toISOString(),
          mode: "final_strategy_preflight",
          signalId,
          direction: "NO_TRADE",
          setup: signal.setup,
          reasoning: reason,
          quote: finalQuote,
          evaluations: finalSignal.evaluations,
          preflight: {
            initialDirection: signal.direction,
            initialSetup: signal.setup,
            finalDirection: finalSignal.direction,
            finalSetup: finalSignal.setup,
            quoteAgeMs: ageMs,
          },
        };
        logTick(finalSignal, finalQuote, reason);
        return;
      }

      await dbQuery(
        `UPDATE scalper_signals
            SET entry=$2,stop_loss=$3,take_profit=$4,risk_reward=$5,reasoning=$6,
                target1=$4,final_sl=$3
          WHERE id=$1 AND outcome IS NULL AND mt5_order_id IS NULL`,
        [
          signalId,
          finalSignal.entry,
          finalSignal.stopLoss,
          finalSignal.takeProfit,
          finalSignal.riskReward,
          finalSignal.reasoning,
        ],
      );

      const account = accountSnapshot();
      const balance = Number(account?.balance);
      const slDistance = Math.abs(finalSignal.entry! - finalSignal.stopLoss!);
      const balanceKnown = Number.isFinite(balance) && balance > 0;
      const riskCap = riskMaxPct > 0 && balanceKnown ? (balance * riskMaxPct) / 100 : null;
      const perLot = riskPerLot(slDistance,
        Number(connection.terminalState.specification(symbol())?.tickSize),
        Number(connection.terminalState.price(symbol())?.lossTickValue));
      const orderRisk = (size: number) => perLot === null ? lossAtStop(size, slDistance) : size * perLot;
      let orderLots = activeLots;
      let lotsCapped = false;
      if (riskCap !== null && orderRisk(orderLots) > riskCap) {
        const reduced = clampLots(riskFallbackLots);
        lotsCapped = reduced !== orderLots;
        orderLots = reduced;
      }
      const riskMoney = orderRisk(orderLots);
      if (riskMaxPct > 0 && (!balanceKnown || perLot === null || (riskCap !== null && riskMoney > riskCap))) {
        const reason = "Cap rischio: saldo non disponibile o rischio ancora eccessivo dopo la riduzione dei lotti.";
        await markSkipped(signalId, reason);
        latestDecision = noTradeDecision(reason, finalQuote, { setup: finalSignal.setup, evaluations: finalSignal.evaluations });
        return;
      }
      const riskPct = balanceKnown && perLot !== null ? (riskMoney / balance) * 100 : null;
      // Sui setup gestiti il livello calcolato e' target1, non un TP: al broker non viene inviato.
      const managedExit = isManagedSetup(finalSignal.setup);
      const target1 = finalSignal.takeProfit!;
      const riskPlan = {
        lots: orderLots,
        requestedLots: activeLots,
        lotsCapped,
        managedExit,
        target1,
        target1Distance: Number(Math.abs(target1 - finalSignal.entry!).toFixed(2)),
        slDistance: Number(slDistance.toFixed(2)),
        tpDistance: Number(Math.abs(finalSignal.takeProfit! - finalSignal.entry!).toFixed(2)),
        riskReward: finalSignal.riskReward,
        risk: Number(riskMoney.toFixed(2)),
        riskPct: riskPct === null ? null : Number(riskPct.toFixed(2)),
        riskMaxPct,
        riskCapActive: riskCap !== null,
        currency: perLot === null ? "USD (stima)" : account?.currency ?? null,
        overCap: riskCap !== null && riskMoney > riskCap,
        slPlan: finalSignal.slPlan,
      };

      const sendQuote = latestQuote ?? finalQuote;
      const sendAgeMs = quoteAgeMs(sendQuote);
      const sendCheck = evaluateScalper({ quote: sendQuote, m1, m5 });
      const entryDrift = sendCheck.direction === "NO_TRADE" || sendCheck.entry === null
        ? Number.POSITIVE_INFINITY
        : Math.abs(sendCheck.entry - finalSignal.entry!);
      const maxEntryDrift = Math.max(0.25, slDistance * 0.15);
      if (
        sendAgeMs > finalQuoteMaxAgeMs
        || sendCheck.direction !== finalSignal.direction
        || sendCheck.setup !== finalSignal.setup
        || sendCheck.setupKey !== finalSignal.setupKey
        || entryDrift > maxEntryDrift
        || !plannedEntryValid(finalSignal, sendQuote)
      ) {
        const reason = sendAgeMs > finalQuoteMaxAgeMs
          ? `Final send-check: quote vecchia ${Math.round(sendAgeMs)} ms.`
          : sendCheck.direction !== finalSignal.direction || sendCheck.setup !== finalSignal.setup
            ? `Final send-check: ${finalSignal.direction}/${finalSignal.setup ?? "—"} non più valido, ora ${sendCheck.direction}/${sendCheck.setup ?? "—"}.`
            : !plannedEntryValid(finalSignal, sendQuote)
              ? "Final send-check: SL/TP pianificati non rispettano più il rapporto netto o il limite di stop."
              : `Final send-check: prezzo mosso di ${entryDrift.toFixed(2)}$ oltre il massimo ${maxEntryDrift.toFixed(2)}$.`;
        await markSkipped(signalId, reason);
        latestDecision = {
          at: new Date().toISOString(),
          mode: "final_strategy_preflight",
          signalId,
          direction: "NO_TRADE",
          setup: finalSignal.setup,
          reasoning: reason,
          quote: sendQuote,
          evaluations: sendCheck.evaluations,
          preflight: {
            initialDirection: signal.direction,
            initialSetup: signal.setup,
            finalDirection: sendCheck.direction,
            finalSetup: sendCheck.setup,
            quoteAgeMs: sendAgeMs,
            entryDrift: Number.isFinite(entryDrift) ? Number(entryDrift.toFixed(2)) : null,
            maxEntryDrift: Number(maxEntryDrift.toFixed(2)),
          },
        };
        logTick(sendCheck, sendQuote, reason);
        return;
      }

      console.log("[scalper-worker] order_plan", JSON.stringify({
        signalId,
        setup: finalSignal.setup,
        direction: finalSignal.direction,
        entry: finalSignal.entry,
        stopLoss: finalSignal.stopLoss,
        // Nessun take profit sui setup gestiti: resta solo target1, che sposta lo stop a breakeven.
        takeProfit: managedExit ? null : finalSignal.takeProfit,
        finalPreflight: {
          quoteAgeMs: sendAgeMs,
          entryDrift: Number(entryDrift.toFixed(2)),
          maxEntryDrift: Number(maxEntryDrift.toFixed(2)),
        },
        ...riskPlan,
      }));

      executionStarted = true;
      const execution = await executeStreaming(
        signalId,
        finalSignal.direction,
        finalSignal.stopLoss!,
        managedExit ? null : finalSignal.takeProfit!,
        tradingConnection,
        { schemaReady: true, skipSync: true, systemStopped: stopped, preflightDone: true, lots: orderLots, price: sendQuote.mid },
      );

      if ([
        "blocked",
        "blocked_existing_position",
        "blocked_existing_signal",
        "blocked_position_limit",
        "blocked_opposite_position",
        "blocked_unknown_position_direction",
        "insufficient_margin",
        "disabled",
        "system_stopped",
      ].includes(execution.status)) {
        const reason = "reason" in execution ? String(execution.reason ?? "") : "";
        await markSkipped(signalId, `Streaming execution: ${execution.status}${reason ? ` (${reason})` : ""}`);
      } else if (execution.status === "opened" || execution.status === "pending_position_link") {
        const sentAt = Date.now();
        signalLockUntil = sentAt + 5000;
        dupDirectionUntil[finalSignal.direction] = sentAt + dupCooldownMs;
        if (finalSignal.setup) dupSetupUntilBucket.set(finalSignal.setup, bucketStart(sentAt, 1) + dupSetupBars * 60_000);
        lastNotifiedBlock = null;
        if (managedExit && execution.status === "opened" && execution.positionId) {
          const openPrice = Number(execution.openPrice ?? finalSignal.entry);
          const state = openManagedExit({
            positionId: String(execution.positionId),
            signalId,
            setup: finalSignal.setup!,
            direction: finalSignal.direction,
            openPrice: Number.isFinite(openPrice) ? openPrice : finalSignal.entry!,
            initialStop: finalSignal.stopLoss!,
            target1,
          });
          managedExits.set(state.positionId, state);
          knownPositionIds.add(state.positionId);
          await persistManagedExit(state).catch((error) => console.error(error));
        }
        const targetLabel = managedExit ? "target1" : "TP";
        void sendTelegram(
          `\u{1f7e2} SCALPER ${symbol()} · apertura ${finalSignal.direction}`
          + `\nlotti ${orderLots}${lotsCapped ? ` (ridotti da ${activeLots} per il cap rischio)` : ""}`
          + ` · entry ${money(finalSignal.entry)} · SL ${money(finalSignal.stopLoss)} · ${targetLabel} ${money(target1)}`
          + `\nSL ${money(riskPlan.slDistance)}$ · ${targetLabel} ${money(riskPlan.target1Distance)}$ a ${finalSignal.riskReward}R`
          + ` · rischio ${money(riskPlan.risk)} ${riskPlan.currency ?? "EUR"}${riskPlan.riskPct === null ? "" : ` (${money(riskPlan.riskPct)}% del saldo)`}`
          + `${managedExit ? "\nuscita gestita: nessun TP al broker, breakeven a target1 poi trailing sulla struttura M5" : ""}`
          + `\nsetup ${setupLabel(finalSignal.setup)} (${finalSignal.setup ?? "—"}) · ${balanceLine()}`,
        );
      } else if (execution.status === "error" || execution.status === "pending_confirmation") {
        orderErrorUntil = Date.now() + 60_000;
        void sendTelegram(
          `\u26a0\ufe0f SCALPER ${symbol()} · errore ordine ${finalSignal.direction}`
          + `\n${"error" in execution ? String(execution.error) : "errore sconosciuto"}`,
        );
      }

      latestDecision = {
        at: new Date().toISOString(),
        mode: "event_driven_intrabar_final_preflight",
        signalId,
        direction: finalSignal.direction,
        setup: finalSignal.setup,
        reasoning: finalSignal.reasoning,
        quote: sendQuote,
        evaluations: sendCheck.evaluations,
        preflight: {
          quoteAgeMs: sendAgeMs,
          entryDrift: Number(entryDrift.toFixed(2)),
          maxEntryDrift: Number(maxEntryDrift.toFixed(2)),
        },
        risk: riskPlan,
        execution,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (reservedSignalId && !executionStarted) await markSkipped(reservedSignalId, "Preflight fallito: " + message).catch(() => undefined);
      await setSetting("stream_last_error", `${new Date().toISOString()} ${message}`);
    } finally {
      decisionBusy = false;
    }
  };

  const listener = new QuoteListener(onPrice);
  connection.addSynchronizationListener(listener);
  await connection.connect();
  let synchronizationMessage = "Attendo sincronizzazione broker.";
  await markWorker("waiting_broker", { ...workerDetail(), reason: synchronizationMessage });
  void sendTelegram(
    `\u{1f7e1} SCALPER ${symbol()} · attesa sincronizzazione broker iniziata.`
    + `\nRitento ogni 30 secondi senza fermare il worker.`,
  );
  const waitingHeartbeatTimer = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void markWorker("waiting_broker", { ...workerDetail(), reason: synchronizationMessage })
      .catch((error) => console.error(error))
      .finally(() => {
        heartbeatBusy = false;
      });
  }, heartbeatMs);
  try {
    for (;;) {
      try {
        await connection.waitSynchronized();
        break;
      } catch (error) {
        synchronizationMessage = error instanceof Error ? error.message : String(error);
        console.warn("[scalper-worker] waitSynchronized retry", synchronizationMessage);
        await Promise.all([
          setSetting("stream_last_error", `${new Date().toISOString()} ${synchronizationMessage}`),
          markWorker("waiting_broker", { ...workerDetail(), reason: synchronizationMessage }),
        ]).catch((settingError) => console.error(settingError));
        await sleep(30_000);
      }
    }
  } finally {
    clearInterval(waitingHeartbeatTimer);
  }
  await markWorker(stopped ? "paused" : "streaming", workerDetail());
  void sendTelegram(
    `\u{1f7e2} SCALPER ${symbol()} · sincronizzazione broker riuscita${stopped ? ", sistema in pausa." : ", worker di nuovo streaming."}`,
  );
  const purged = await dbQuery(
    `UPDATE scalper_signals
        SET outcome='ERROR',closed_at=now(),mt5_error='purged at startup'
      WHERE outcome IS NULL AND mt5_position_id IS NULL AND mt5_order_id IS NULL AND client_id IS NULL`,
  );
  await refreshLossGuards();
  await restoreManagedExits().catch((error) => console.error(error));
  console.log("[scalper-worker] synchronized", {
    symbol: symbol(),
    purgedSignals: purged.rowCount,
    lossGuards: lossGuards(),
    managedExits: managedExits.size,
  });

  const subscribe = async (resetQuoteWatch = true) => {
    ready = false;
    if (resetQuoteWatch) quoteWatchStartedAtMs = Date.now();
    const seeded = await seedCandles(m1Max, m5Max);
    m1 = seeded.m1;
    m5 = seeded.m5;
    await connection.subscribeToMarketData(symbol(), marketDataSubscriptions);
    subscribed = true;
    ready = true;
    await markWorker("streaming", workerDetail());
  };

  const reconnectStaleQuotes = async (quoteAgeSec: number | null) => {
    if (staleReconnectBusy || staleExitBusy || stopped) return;
    staleReconnectBusy = true;
    ready = false;
    subscribed = false;
    latestQuote = null;
    console.warn("[scalper-worker] stale_quote_reconnect", JSON.stringify({
      at: new Date().toISOString(), quoteAgeSec, staleQuoteSec, staleQuoteExitSec,
    }));
    await markWorker("stale_reconnect", { ...workerDetail(), quoteAgeSec, reason: "quote ferme" })
      .catch((error) => console.error(error));
    try {
      connection.removeSynchronizationListener(listener);
      await connection.close().catch((error) => console.warn("[scalper-worker] stale close", error));
      connection = account.getStreamingConnection();
      tradingConnection = connection as unknown as FlattenConnection;
      connection.addSynchronizationListener(listener);
      await connection.connect();
      await connection.waitSynchronized();
      if (stopped || staleExitBusy) return;
      await subscribe(false);
      console.log("[scalper-worker] stale_quote_reconnected", JSON.stringify({
        at: new Date().toISOString(), quoteAgeSec,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[scalper-worker] stale_quote_reconnect_failed", message);
      await setSetting("stream_last_error", `${new Date().toISOString()} stale quote reconnect: ${message}`)
        .catch((settingError) => console.error(settingError));
    } finally {
      staleReconnectBusy = false;
    }
  };

  void sendTelegram(
    `\u{1f680} SCALPER ${symbol()} · worker avviato`
    + `\nlotti attivi ${activeLots} · autoExec ${autoExecEnabled() ? "ON" : "OFF"} · max ${maxOpenPositions} posizioni`
    + `\n${balanceLine()}${stopped ? "\nSTOP TUTTO attivo" : ""}`,
  );

  if (!stopped) {
    await subscribe();
  } else {
    await flattenSymbol("system_stop", "startup-system-stop").catch(() => undefined);
    await markWorker("paused", { ...workerDetail(), reason: "STOP TUTTO" });
  }

  const staleQuoteTimer = setInterval(() => {
    const now = Date.now();
    const status = getSessionStatus(new Date(now), sessionConfig);
    if (stopped || !status.inside) return;
    const sessionStartAtMs = status.sessionStartAt ? Date.parse(status.sessionStartAt) : Number.NaN;
    const decision = staleQuoteDecision({
      active: true,
      nowMs: now,
      lastQuoteReceivedAtMs: lastQuoteReceivedAtMs || null,
      sessionStartAtMs: Number.isFinite(sessionStartAtMs) ? sessionStartAtMs : null,
      fallbackStartAtMs: quoteWatchStartedAtMs,
      staleQuoteSec,
      staleQuoteExitSec,
    });
    if (decision.action === "exit") {
      if (staleExitBusy) return;
      staleExitBusy = true;
      ready = false;
      subscribed = false;
      console.error("[scalper-worker] stale_quote_exit", JSON.stringify({
        at: new Date(now).toISOString(), quoteAgeSec: decision.quoteAgeSec, staleQuoteExitSec,
      }));
      void (async () => {
        await markWorker("stale_exit", {
          ...workerDetail(), quoteAgeSec: decision.quoteAgeSec, reason: "quote ferme",
        }).catch((error) => console.error(error));
        await sendTelegram(
          `🚨 SCALPER ${symbol()} · worker riavviato per quote ferme`
          + `
nessuna quote valida da ${decision.quoteAgeSec ?? "?"} s`,
        ).catch((error) => console.error(error));
      })().finally(() => process.exit(1));
      return;
    }
    if (decision.action === "reconnect" && !staleReconnectBusy) {
      void reconnectStaleQuotes(decision.quoteAgeSec);
    }
  }, 30_000);

  const controlTimer = setInterval(() => {
    if (controlBusy) return;
    controlBusy = true;
    void (async () => {
      try {
        const nextStopped = await refreshControl();
        if (nextStopped && !stopped) {
          stopped = true;
          ready = false;
          lastNotifiedBlock = null;
          void sendTelegram(`\u{1f6d1} SCALPER ${symbol()} · STOP TUTTO dalla dashboard: flatten posizioni e blocco nuove aperture.\n${balanceLine()}`);
          await flattenSymbol("system_stop", `system-stop-${Date.now()}`).catch(() => undefined);
          if (subscribed) {
            await connection.unsubscribeFromMarketData(symbol(), marketDataUnsubscriptions).catch(() => undefined);
            subscribed = false;
          }
          m1 = [];
          m5 = [];
          latestQuote = null;
          await setSetting("stream_last_quote", "");
          await markWorker("paused", { ...workerDetail(), reason: "STOP TUTTO" });
        } else if (!nextStopped && stopped) {
          stopped = false;
          lastNotifiedBlock = null;
          void sendTelegram(`\u{1f7e2} SCALPER ${symbol()} · sistema riattivato dalla dashboard · lotti ${activeLots}.\n${balanceLine()}`);
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

  const sessionTimer = setInterval(() => {
    const status = getSessionStatus(new Date(), sessionConfig);
    const positions = (tradingConnection.terminalState.positions ?? []).filter((position) => position.symbol === symbol());
    const orders = (tradingConnection.terminalState.orders ?? []).filter((order) => order.symbol === symbol());
    const hasExposure = positions.length > 0 || orders.length > 0;

    if (stopped) {
      if (hasExposure) void flattenSymbol("system_stop", "system-stop-active").catch(() => undefined);
      return;
    }

    if (status.weekendClosed) {
      latestDecision = noTradeDecision("Mercato chiuso (weekend)", latestQuote);
      if (hasExposure) void flattenSymbol("end_of_session", `weekend-${new Date().toISOString().slice(0, 10)}`).catch(() => undefined);
      return;
    }

    if (status.inFlattenWindow) {
      latestDecision = noTradeDecision(`Chiusura sessione tra ${status.minutesUntilEnd ?? 0} min`, latestQuote);
      void flattenSymbol("end_of_session", status.sessionEndAt ?? `session-${new Date().toISOString().slice(0, 10)}`).catch(() => undefined);
      return;
    }

    if (!status.inside) {
      latestDecision = noTradeDecision(`Fuori fascia scalper ${sessionConfig.hoursUtc} UTC`, latestQuote);
      if (hasExposure) void flattenSymbol("end_of_session", `outside-${new Date().toISOString().slice(0, 10)}`).catch(() => undefined);
    }
  }, 1000);

  const syncTimer = setInterval(() => {
    if (syncBusy || flattenBusy || stopped || !subscribed) return;
    syncBusy = true;
    void syncStreamingExecutor(tradingConnection, { schemaReady: true, systemStopped: stopped })
      .then(async (result) => {
        if (result.closed > 0) {
          signalLockUntil = 0;
          await refreshLossGuards().catch((error) => console.error(error));
        }
        for (const closure of result.closures ?? []) {
          void sendTelegram(
            `${closure.profit > 0 ? "\u2705" : closure.profit < 0 ? "\u274c" : "\u2796"} SCALPER ${symbol()} · chiusura ${closure.outcome} (${closure.closeReason ?? "SL/TP"})`
            + `\nprofitto ${money(closure.profit)} · ${money(closure.openPrice)} \u2192 ${money(closure.closePrice)} · ${closure.resultR >= 0 ? "+" : ""}${closure.resultR}R`
            + `${countsAsLoss(closure.outcome, closure.closeReason) ? `\n${lossGuardLine()}` : ""}`
            + `\n${balanceLine()}`,
          );
        }
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
    const receivedAt = lastQuoteReceivedAtMs > 0 ? new Date(lastQuoteReceivedAtMs).toISOString() : null;
    void setSetting("stream_last_quote", JSON.stringify({ ...snapshot, receivedAt }))
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

  const lossLockTimer = setInterval(() => {
    void refreshLossGuards().catch((error) => console.error(error));
    // Riprende i piani di uscita non ancora in memoria (ordine collegato in ritardo, worker riavviato).
    void restoreManagedExits().catch((error) => console.error(error));
  }, lossLockRefreshMs);

  const heartbeatTimer = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void markWorker(stopped ? "paused" : subscribed ? "streaming" : "connected", workerDetail())
      .catch((error) => console.error(error))
      .finally(() => {
        heartbeatBusy = false;
      });
  }, heartbeatMs);

  const shutdown = async (reason: string) => {
    clearInterval(staleQuoteTimer);
    clearInterval(controlTimer);
    clearInterval(sessionTimer);
    clearInterval(syncTimer);
    clearInterval(quotePersistTimer);
    clearInterval(decisionPersistTimer);
    clearInterval(lossLockTimer);
    clearInterval(heartbeatTimer);
    try {
      ready = false;
      await markWorker("stopping", { ...workerDetail(), reason });
      if (subscribed) await connection.unsubscribeFromMarketData(symbol(), marketDataUnsubscriptions).catch(() => undefined);
      connection.removeSynchronizationListener(listener);
      await connection.close();
      await markWorker("stopped", { ...workerDetail(), reason });
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

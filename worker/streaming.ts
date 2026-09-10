import MetaApi, { SynchronizationListener } from "metaapi.cloud-sdk";
import { dbQuery, ensureSchema, getSettings, setSetting } from "../src/lib/server/db";
import { autoExecEnabled, clampLots, lots, lotsMax, lotsMin, resolveLots } from "../src/lib/server/tradingConfig";
import { EXEC_LOTS_SETTING_KEY, lossAtStop } from "../src/lib/lots";
import { money, sendTelegram } from "../src/lib/server/notify";
import { deals, fetchCandles, symbol } from "../src/lib/server/metaApi";
import { getSessionStatus, sessionConfigFromEnv, sessionWindowStart } from "../src/lib/session";
import { contextM5M15, evaluateScalper, m15GateMode, plannedEntryValid, STRATEGY_VERSION } from "../src/lib/server/scalperStrategy";
import { aggregateM15, closedBars } from "../src/lib/server/marketStructure";
import { atr } from "../src/lib/server/indicators";
import {
  applyAction, buildModifyPositionCommand, closeConfirmedByAbsence, countsAsLoss,
  entryBlockedByOpenPositions, isManagedSetup, m5CloseAction, openManagedExit, oppositeSignalIgnored,
  referencePrice, retargetOnFill, tickAction, trackMissing,
  type ManagedCloseReason, type ManagedExitState, type MissingPosition,
} from "../src/lib/server/positionManager";
import {
  decideTpBrokerUpdate, initTrailingTp, initialLevels as sltpInitialLevels, recalcTighterStop,
  sltpMode, stopsLevelMinDistanceUsd, takeProfitTouched, tpCloseReason, updateTrailingTp,
  type SltpMode,
} from "../src/lib/server/dynamicSlTp";
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
  // Non popolati dal cast stretto sopra, ma presenti sull'oggetto MetaApi reale: fallback per
  // recuperare il TP live quando lo stato interno non lo conosce (vedi resolveBrokerTp sotto).
  stopLoss?: number;
  takeProfit?: number;
};

type ManagedOrder = {
  id: string;
  symbol: string;
};

/**
 * Stato in memoria di una posizione gestita da SLTP_MODE=fixed|trailing. peak/tpTriggered hanno
 * senso solo in modalita' "trailing" (fixed non li usa mai: currentTp resta sempre initialTp).
 */
type SltpExitState = {
  positionId: string;
  signalId: string | null;
  direction: "BUY" | "SELL";
  entry: number;
  mode: "fixed" | "trailing";
  stopLoss: number;
  slUpdates: number;
  initialTp: number;
  currentTp: number;
  tpTriggered: boolean;
  peak: number;
  lastUpdateAtMs: number | null;
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

/** Log esplicito di ogni modifica posizione inviata a MetaApi: sl e tp esatti, mai solo uno dei due. */
function logPositionModify(input: { positionId: string; reason: string; sl: number; tp: number; signalId?: string | null }) {
  console.log("[scalper-worker] position_modify", JSON.stringify({
    at: new Date().toISOString(),
    positionId: input.positionId,
    signalId: input.signalId ?? null,
    reason: input.reason,
    sl: input.sl,
    tp: input.tp,
  }));
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
  // SLTP_MODE=fixed|trailing: motore unico di SL/TP da struttura, sostituisce managedExits per le
  // posizioni aperte mentre e' attivo. Sopravvive ai riavvii riusando le stesse colonne esistenti
  // (final_sl, target1, tp_broker, breakeven_price, breakeven_at, trailing_updates/active) con un
  // significato diverso, distinto da managedExits solo tramite context_json.sltp (nessuna colonna
  // nuova: vedi dynamicSlTp.ts per il contratto completo).
  const sltpExits = new Map<string, SltpExitState>();
  // Una posizione sparita dal terminal state non e' chiusa: MetaApi la perde per qualche tick
  // subito dopo l'apertura. Serve la conferma per tempo e tick, o un deal di chiusura in history.
  const missingPositions = new Map<string, MissingPosition>();
  const positionGoneConfirmMs = envInt("POSITION_GONE_CONFIRM_SEC", 10, 0, 600) * 1000;
  const positionGoneConfirmTicks = envInt("POSITION_GONE_CONFIRM_TICKS", 3, 1, 100);
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
      `SELECT direction,outcome,close_reason,mt5_profit,closed_at FROM scalper_signals
        WHERE outcome IN ('WIN','LOSS','BREAKEVEN') AND mt5_position_id IS NOT NULL
          AND closed_at >= $1::timestamptz
        ORDER BY closed_at DESC LIMIT 50`,
      [start.toISOString()],
    );
    const rows = result.rows as Array<{ direction?: string; outcome?: string; close_reason?: string; mt5_profit?: unknown; closed_at?: unknown }>;
    lossLockUntil.BUY = 0;
    lossLockUntil.SELL = 0;
    lossPauseUntil = 0;
    // Solo sl_initial e' una perdita: breakeven, trailing, flatten, stop e watchdog non bloccano nulla.
    for (const row of rows) {
      if (!countsAsLoss(row.outcome, row.close_reason, row.mt5_profit)) continue;
      const direction = row.direction === "BUY" || row.direction === "SELL" ? row.direction : null;
      if (!direction || lossLockUntil[direction] > 0) continue;
      lossLockUntil[direction] = closedAtMs(row.closed_at) + lossLockMs;
    }
    let streak = 0;
    for (const row of rows) {
      if (!countsAsLoss(row.outcome, row.close_reason, row.mt5_profit)) break;
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
      tpBroker: state.brokerTp,
      fillPending: state.fillPending,
      stopLoss: state.stopLoss,
      target1Hit: state.target1Hit,
      breakevenPrice: state.breakevenPrice,
      breakevenAt: state.breakevenAt,
      trailingActive: state.trailingUpdates > 0,
      trailingUpdates: state.trailingUpdates,
    })),
    // SLTP_MODE=fixed|trailing: "off" lascia questo array sempre vuoto, la card posizione della
    // dashboard resta quella di sopra basata su "managed"/"risk".
    m15GateMode: m15GateMode(),
    sltpMode: sltpMode(),
    sltp: [...sltpExits.values()].map((state) => ({
      positionId: state.positionId,
      direction: state.direction,
      entry: state.entry,
      mode: state.mode,
      stopLoss: state.stopLoss,
      slUpdates: state.slUpdates,
      initialTp: state.initialTp,
      currentTp: state.currentTp,
      tpTriggered: state.tpTriggered,
      peak: state.peak,
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
    const values = [state.breakevenPrice, state.breakevenAt, state.trailingUpdates, state.trailingUpdates > 0,
      state.stopLoss, state.target1, state.brokerTp, state.openPrice];
    if (state.signalId) {
      await dbQuery(
        `UPDATE scalper_signals SET breakeven_price=$2,breakeven_at=$3::timestamptz,trailing_updates=$4,
                trailing_active=$5,final_sl=$6,target1=$7,tp_broker=$8,mt5_open_price=COALESCE(mt5_open_price,$9)
          WHERE id=$1`,
        [state.signalId, ...values],
      );
    }
    // La riga trades nasce alla chiusura: finche' il trade e' aperto questo update non tocca nulla.
    await dbQuery(
      `UPDATE trades SET breakeven_price=$2,breakeven_at=$3::timestamptz,trailing_updates=$4,
              trailing_active=$5,final_sl=$6,target1=$7,tp_broker=$8
        WHERE source='scalper' AND mt5_position_id=$1`,
      [state.positionId, ...values.slice(0, 7)],
    );
  };

  /** Riprende i piani di uscita aperti: dopo un riavvio il worker ritrova breakeven e trailing. */
  const restoreManagedExits = async () => {
    const result = await dbQuery(
      `SELECT id::text AS id,setup,direction,mt5_position_id,mt5_open_price,entry,stop_loss,target1,take_profit,
              tp_broker,final_sl,breakeven_price,breakeven_at,trailing_updates
         FROM scalper_signals
        WHERE outcome IS NULL AND mt5_position_id IS NOT NULL`,
    );
    for (const row of result.rows) {
      const positionId = String(row.mt5_position_id ?? "");
      if (!positionId || !isManagedSetup(row.setup) || managedExits.has(positionId)) continue;
      const entry = Number(row.entry);
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
        brokerTp: Number.isFinite(Number(row.tp_broker)) ? Number(row.tp_broker) : null,
        stopLoss: Number.isFinite(Number(row.final_sl)) ? Number(row.final_sl) : initialStop,
        target1Hit: breakevenAt !== null,
        breakevenPrice: Number.isFinite(Number(row.breakeven_price)) ? Number(row.breakeven_price) : null,
        breakevenAt,
        trailingUpdates: Number(row.trailing_updates ?? 0),
        target1Distance: Math.abs(target1 - (Number.isFinite(entry) ? entry : openPrice)),
        fillPending: row.mt5_open_price === null || row.mt5_open_price === undefined,
      });
    }
  };

  /**
   * Chiusura CONFERMATA: fissa i livelli raggiunti dal piano, non il motivo. Il motivo lo scrive
   * chi conosce il prezzo di chiusura reale (syncStreamingExecutor dal deal, o le chiusure forzate):
   * dedurlo qui dallo stato interno etichettava come sl_initial anche trade chiusi in profitto.
   */
  const finalizeManagedExit = async (state: ManagedExitState, via: "absence" | "deal") => {
    console.log("[scalper-worker] managed_exit_closed", JSON.stringify({
      at: new Date().toISOString(),
      positionId: state.positionId,
      signalId: state.signalId,
      setup: state.setup,
      direction: state.direction,
      confirmedVia: via,
      finalSl: state.stopLoss,
      initialStop: state.initialStop,
      breakevenPrice: state.breakevenPrice,
      breakevenAt: state.breakevenAt,
      trailingUpdates: state.trailingUpdates,
      target1: state.target1,
      brokerTp: state.brokerTp,
    }));
    if (!state.signalId) return;
    await dbQuery(
      `UPDATE scalper_signals
          SET final_sl=COALESCE(final_sl,$2),trailing_updates=$3,trailing_active=$4,
              breakeven_price=$5,breakeven_at=$6::timestamptz,target1=COALESCE(target1,$7),
              tp_broker=COALESCE(tp_broker,$8)
        WHERE id=$1`,
      [state.signalId, state.stopLoss, state.trailingUpdates, state.trailingUpdates > 0,
        state.breakevenPrice, state.breakevenAt, state.target1, state.brokerTp],
    );
  };

  // --- SLTP_MODE=fixed|trailing: SL/TP da struttura M1+ATR+spread, sostituisce l'uscita gestita
  // sopra mentre e' attivo. Riusa le stesse colonne (final_sl=SL corrente, target1=TP iniziale
  // fisso, tp_broker=TP corrente al broker, trailing_updates/active=quante volte lo SL si e'
  // stretto, breakeven_price=picco/valle tracciato, breakeven_at=quando il TP trailing ha
  // scattato) con un significato diverso da managedExits, distinto solo da context_json.sltp:
  // nessuna colonna nuova, nessuna ambiguita' perche' le due mappe non si popolano mai per la
  // stessa posizione (managedExits solo con SLTP_MODE=off, sltpExits solo altrimenti).

  const persistSltpExit = async (state: SltpExitState) => {
    if (state.signalId) {
      await dbQuery(
        `UPDATE scalper_signals
            SET final_sl=$2,target1=$3,tp_broker=$4,trailing_updates=$5,trailing_active=$6,
                breakeven_price=$7,breakeven_at=CASE WHEN $8 THEN COALESCE(breakeven_at,now()) ELSE breakeven_at END,
                context_json=COALESCE(context_json,'{}'::jsonb)
                  ||jsonb_build_object('sltp',jsonb_build_object('mode',$9::text,'triggered',$8))
          WHERE id=$1`,
        [state.signalId, state.stopLoss, state.initialTp, state.currentTp, state.slUpdates,
          state.slUpdates > 0, state.peak, state.tpTriggered, state.mode],
      );
    }
    await dbQuery(
      `UPDATE trades SET final_sl=$2,target1=$3,tp_broker=$4,trailing_updates=$5,trailing_active=$6,
              breakeven_price=$7,breakeven_at=CASE WHEN $8 THEN COALESCE(breakeven_at,now()) ELSE breakeven_at END
        WHERE source='scalper' AND mt5_position_id=$1`,
      [state.positionId, state.stopLoss, state.initialTp, state.currentTp, state.slUpdates,
        state.slUpdates > 0, state.peak, state.tpTriggered],
    );
  };

  /** Riprende i piani SLTP aperti dopo un riavvio: solo le righe con context_json.sltp. */
  const restoreSltpExits = async () => {
    const result = await dbQuery(
      `SELECT id::text AS id,direction,mt5_position_id,mt5_open_price,entry,final_sl,target1,tp_broker,
              trailing_updates,breakeven_price,breakeven_at,context_json
         FROM scalper_signals
        WHERE outcome IS NULL AND mt5_position_id IS NOT NULL AND context_json->'sltp' IS NOT NULL`,
    );
    for (const row of result.rows) {
      const positionId = String(row.mt5_position_id ?? "");
      if (!positionId || sltpExits.has(positionId)) continue;
      const entry = Number(row.mt5_open_price ?? row.entry);
      const stopLoss = Number(row.final_sl);
      const initialTp = Number(row.target1);
      const currentTp = Number.isFinite(Number(row.tp_broker)) ? Number(row.tp_broker) : initialTp;
      if (![entry, stopLoss, initialTp, currentTp].every((value) => Number.isFinite(value))) continue;
      const sltp = (row.context_json as { sltp?: { mode?: string; triggered?: boolean } } | null)?.sltp;
      sltpExits.set(positionId, {
        positionId,
        signalId: String(row.id),
        direction: row.direction === "SELL" ? "SELL" : "BUY",
        entry,
        mode: sltp?.mode === "trailing" ? "trailing" : "fixed",
        stopLoss,
        slUpdates: Number(row.trailing_updates ?? 0),
        initialTp,
        currentTp,
        tpTriggered: sltp?.triggered === true,
        // Il picco esatto pre-riavvio non e' recuperabile senza una colonna dedicata: si riparte
        // in modo conservativo dal livello corrente (mai piu' generoso di quanto gia' noto al
        // broker), che al prossimo nuovo massimo/minimo torna a crescere normalmente.
        peak: Number.isFinite(Number(row.breakeven_price)) ? Number(row.breakeven_price) : entry,
        lastUpdateAtMs: null,
      });
    }
  };

  /**
   * Un solo modifyPosition per tick per posizione: SL e TP (quando cambia) viaggiano insieme,
   * cosi' un valore non toccato non rischia mai di essere azzerato da un campo omesso. Se il
   * broker rifiuta, un solo ritentativo al minimo consentito dallo stopsLevel; se rifiuta ancora
   * si rinuncia e si logga sltp_rejected, mantenendo il livello precedente (il prossimo tick
   * ritenta da capo, rispettando comunque il rate-limit).
   */
  const applySltpLevels = async (input: {
    positionId: string;
    signalId?: string | null;
    direction: "BUY" | "SELL";
    stopLoss: number;
    takeProfit: number;
    /** Livello attualmente noto al broker: il ritentativo al minimo stopsLevel non deve mai andare oltre, mai allargare lo stop. */
    previousStopLoss: number;
    stopsLevelMinUsd: number;
    currentPrice: number;
    label: string;
  }): Promise<{ stopLoss: number; takeProfit: number } | null> => {
    try {
      await retryTrade(input.label, () => tradingConnection.modifyPosition(input.positionId, input.stopLoss, input.takeProfit));
      logPositionModify({ positionId: input.positionId, signalId: input.signalId, reason: "sltp_update", sl: input.stopLoss, tp: input.takeProfit });
      return { stopLoss: input.stopLoss, takeProfit: input.takeProfit };
    } catch (firstError) {
      if (!(input.stopsLevelMinUsd > 0)) {
        console.warn("[scalper-worker] sltp_rejected", JSON.stringify({
          at: new Date().toISOString(), positionId: input.positionId, label: input.label, error: String(firstError),
        }));
        return null;
      }
      // Il minimo dello stopsLevel non deve mai spingere lo SL oltre quello gia' noto al broker:
      // "mantieni/apri senza quel livello" vale anche per il ritentativo, lo SL si stringe soltanto.
      const safeSl = input.direction === "BUY"
        ? Math.max(input.previousStopLoss, Math.min(input.stopLoss, input.currentPrice - input.stopsLevelMinUsd))
        : Math.min(input.previousStopLoss, Math.max(input.stopLoss, input.currentPrice + input.stopsLevelMinUsd));
      const safeTp = input.direction === "BUY"
        ? Math.max(input.takeProfit, input.currentPrice + input.stopsLevelMinUsd)
        : Math.min(input.takeProfit, input.currentPrice - input.stopsLevelMinUsd);
      try {
        await retryTrade(`${input.label} (minimo stopsLevel)`, () => tradingConnection.modifyPosition(input.positionId, safeSl, safeTp));
        logPositionModify({ positionId: input.positionId, signalId: input.signalId, reason: "sltp_update_stopslevel_fallback", sl: safeSl, tp: safeTp });
        return { stopLoss: safeSl, takeProfit: safeTp };
      } catch (secondError) {
        console.warn("[scalper-worker] sltp_rejected", JSON.stringify({
          at: new Date().toISOString(), positionId: input.positionId, label: input.label, error: String(secondError),
        }));
        return null;
      }
    }
  };

  const driveSltpExits = async (openPositions: ManagedPosition[], quote: Quote) => {
    if (sltpExits.size === 0 || stopped || flattenBusy) return;
    const closedM1 = closedBars(m1, 1, Date.now()) ?? [];
    if (closedM1.length < 20) return;
    const atrM1 = atr(closedM1, 14, true);
    if (!atrM1 || !(atrM1 > 0)) return;
    const spreadUsd = quote.spread;
    const spec = connection.terminalState.specification?.(symbol());
    const tickSizeUsd = Number(spec?.tickSize) > 0 ? Number(spec!.tickSize) : 0.01;
    const stopsLevelMinUsd = stopsLevelMinDistanceUsd(spec?.stopsLevel, spec?.point ?? tickSizeUsd);
    const nowMs = Date.now();

    for (const position of openPositions) {
      const state = sltpExits.get(position.id);
      if (!state) continue;
      const priceRef = referencePrice(state.direction, quote);
      // Riferimento del rate-limit catturato una volta sola: SL e TP condividono lo stesso
      // budget di aggiornamenti (SLTP_UPDATE_MIN_INTERVAL_SEC), ma la decisione dell'uno non deve
      // far apparire "appena aggiornato" l'altro nello stesso tick.
      const rateLimitReferenceMs = state.lastUpdateAtMs;

      // 1. TP trailing: aggiorna picco/trigger sempre, anche se l'aggiornamento al broker slitta
      // per il rate-limit, cosi' il tocco sotto si valuta sempre sul livello vero.
      let tpCandidate: number | null = null;
      if (state.mode === "trailing") {
        const trail = updateTrailingTp(
          { peak: state.peak, triggered: state.tpTriggered, currentTp: state.currentTp },
          { direction: state.direction, currentPrice: priceRef, initialTp: state.initialTp, entry: state.entry },
        );
        state.peak = trail.peak;
        state.tpTriggered = trail.triggered;
        if (trail.currentTp !== state.currentTp) tpCandidate = trail.currentTp;
        state.currentTp = trail.currentTp;
      }

      // 2. SL: si stringe soltanto, stesso motore in fixed e trailing.
      const slDecision = recalcTighterStop({
        direction: state.direction, currentPrice: priceRef, currentStopLoss: state.stopLoss,
        m1: closedM1, atrM1, spreadUsd, tickSizeUsd, nowMs, lastUpdateAtMs: rateLimitReferenceMs,
      });

      // 3. Un solo modifyPosition combinato per tick per posizione, quando SL e/o TP migliorano
      // abbastanza da giustificare un aggiornamento e il rate-limit lo consente.
      const tpDecision = tpCandidate === null ? null : decideTpBrokerUpdate({
        direction: state.direction, candidateTp: tpCandidate, currentBrokerTp: state.currentTp,
        tickSizeUsd, nowMs, lastUpdateAtMs: rateLimitReferenceMs,
      });
      if (slDecision.kind === "update" || tpDecision?.kind === "update") {
        const nextSl = slDecision.kind === "update" ? slDecision.stopLoss : state.stopLoss;
        const nextTp = tpDecision?.kind === "update" ? tpDecision.takeProfit : state.currentTp;
        const applied = await applySltpLevels({
          positionId: position.id, signalId: state.signalId, direction: state.direction, stopLoss: nextSl, takeProfit: nextTp,
          previousStopLoss: state.stopLoss, stopsLevelMinUsd, currentPrice: priceRef,
          label: `SL/TP posizione ${position.id}`,
        });
        if (applied) {
          if (applied.stopLoss !== state.stopLoss) state.slUpdates++;
          state.stopLoss = applied.stopLoss;
          state.currentTp = applied.takeProfit;
          state.lastUpdateAtMs = nowMs;
        }
      }

      sltpExits.set(position.id, state);
      await persistSltpExit(state).catch((error) => console.error(error));

      // 3. Tocco del TP corrente: chiusura attiva a mercato. E' una rete di sicurezza aggiuntiva
      // al TP gia' impostato al broker: se il broker chiude prima lui va bene lo stesso, lo
      // riconosce syncStreamingExecutor dal deal reale via context_json.sltp.
      if (takeProfitTouched({ direction: state.direction, triggered: state.tpTriggered, referencePriceUsd: priceRef, tpLevel: state.currentTp })) {
        try {
          await retryTrade(`Chiusura TP ${state.mode} posizione ${position.id}`, () => tradingConnection.closePosition(position.id));
          sltpExits.delete(position.id);
          await recordClosedPosition(position, tpCloseReason(state.tpTriggered)).catch((error) => console.error(error));
        } catch (error) {
          await setSetting("stream_last_error", `${new Date().toISOString()} Chiusura TP ${position.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  };

  /**
   * Una posizione assente dal terminal state e' chiusa solo dopo la conferma: abbastanza tick
   * consecutivi e abbastanza tempo, oppure un deal di chiusura in history. Prima di allora non si
   * finalizza nulla, non parte la pausa re-entry e non si conta nessuna perdita.
   */
  const confirmPositionClosed = (positionId: string, via: "absence" | "deal") => {
    if (!knownPositionIds.has(positionId)) return;
    knownPositionIds.delete(positionId);
    missingPositions.delete(positionId);
    lastPositionCloseAt = Date.now();
    // Il broker puo' aver chiuso lui una posizione SLTP_MODE prima del check attivo del worker: il
    // motivo si legge dal prezzo reale in syncStreamingExecutor via context_json.sltp, qui basta
    // smettere di gestirla.
    sltpExits.delete(positionId);
    const closing = managedExits.get(positionId);
    if (!closing) return;
    managedExits.delete(positionId);
    void finalizeManagedExit(closing, via).catch((error) => console.error(error));
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

        // 0. Fill arrivato in ritardo: target1 si rimisura sul prezzo reale, una volta sola.
        if (current.fillPending) {
          const filled = Number(position.openPrice);
          if (Number.isFinite(filled) && filled > 0) {
            const corrected = retargetOnFill(current, filled);
            console.log("[scalper-worker] fill_price_recovered", JSON.stringify({
              at: new Date().toISOString(), positionId: position.id, signalId: current.signalId,
              openPrice: filled, target1From: current.target1, target1To: corrected.target1,
            }));
            current = corrected;
            managedExits.set(position.id, current);
            await persistManagedExit(current).catch((error) => console.error(error));
          }
        }

        // 1. Primo tick che tocca target1 (BID sui long, ASK sugli short): stop a breakeven.
        const breakeven = tickAction(current, quote, Date.now(), breakevenBuffer);
        if (breakeven && breakeven.kind === "breakeven") {
          // SEMPRE sl e tp espliciti nella stessa modifyPosition: un tp omesso viene letto dal
          // broker come "cancellalo", non "lascialo com'era" (vedi trade MT5 #220522199).
          const command = buildModifyPositionCommand(breakeven, current.brokerTp, position);
          if (command.blocked) {
            await setSetting("stream_last_error", `${new Date().toISOString()} Breakeven ${position.id}: TP al broker sconosciuto, modifica saltata per non cancellarlo.`);
            console.error("[scalper-worker] position_modify_skipped", JSON.stringify({
              at: new Date().toISOString(), positionId: position.id, signalId: current.signalId, reason: "breakeven_tp_unknown",
            }));
          } else {
            try {
              await retryTrade(`Breakeven posizione ${position.id}`, () => tradingConnection.modifyPosition(position.id, command.sl, command.tp));
              logPositionModify({ positionId: position.id, signalId: current.signalId, reason: "breakeven", sl: command.sl, tp: command.tp });
              current = { ...applyAction(current, breakeven), brokerTp: command.tp };
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
                stopLoss: command.sl,
                previousStopLoss: state.stopLoss,
                tpBroker: command.tp,
              }));
              await persistManagedExit(current);
              void sendTelegram(
                `\u{1f512} SCALPER ${symbol()} \u00b7 breakeven ${current.direction} ${setupLabel(current.setup)}:`
                + ` target1 ${money(current.target1)} raggiunto, SL a ${money(command.sl)}`
                + ` (${breakeven.at.slice(11, 19)} UTC).`,
              );
            } catch (error) {
              await setSetting("stream_last_error", `${new Date().toISOString()} Breakeven ${position.id}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }

        // 2. Trailing sulla struttura M5: solo dopo il breakeven e solo a M5 chiusa.
        if (!freshM5Close) continue;
        const trailing = m5CloseAction(current, closedM5);
        if (!trailing || trailing.kind !== "trailing") continue;
        const trailingCommand = buildModifyPositionCommand(trailing, current.brokerTp, position);
        if (trailingCommand.blocked) {
          await setSetting("stream_last_error", `${new Date().toISOString()} Trailing ${position.id}: TP al broker sconosciuto, modifica saltata per non cancellarlo.`);
          console.error("[scalper-worker] position_modify_skipped", JSON.stringify({
            at: new Date().toISOString(), positionId: position.id, signalId: current.signalId, reason: "trailing_tp_unknown",
          }));
          continue;
        }
        try {
          await retryTrade(`Trailing posizione ${position.id}`, () => tradingConnection.modifyPosition(position.id, trailingCommand.sl, trailingCommand.tp));
          logPositionModify({ positionId: position.id, signalId: current.signalId, reason: "trailing_m5", sl: trailingCommand.sl, tp: trailingCommand.tp });
          current = { ...applyAction(current, trailing), brokerTp: trailingCommand.tp };
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
            tpBroker: trailingCommand.tp,
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
        `UPDATE trades SET reason=$2,close_reason=$3,status='closed',
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
              closed_at=COALESCE($9::timestamptz,now()),payload=$10::jsonb,lot=$11,status='closed'
        WHERE source='flatten_external' AND symbol=$1 AND mt5_position_id=$2`,
      externalParams,
    );
    if (updated.rowCount === 0) {
      await dbQuery(
        `INSERT INTO trades(source,scalper_signal_id,symbol,mt5_position_id,direction,open_price,close_price,profit,result_r,reason,opened_at,closed_at,payload,lot,status)
         VALUES('flatten_external',NULL,$1,$2,$3,$4,$5,$6,NULL,$7,$8,COALESCE($9::timestamptz,now()),$10::jsonb,$11,'closed')`,
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
    const tickNow = Date.now();
    for (const id of [...knownPositionIds]) {
      if (openIds.has(id)) {
        // Riapparsa: era un buco del terminal state, non una chiusura.
        const missing = missingPositions.get(id);
        if (missing) {
          missingPositions.delete(id);
          console.log("[scalper-worker] position_reappeared", JSON.stringify({
            at: new Date(tickNow).toISOString(), positionId: id,
            missingTicks: missing.ticks, missingMs: tickNow - missing.since,
          }));
        }
        continue;
      }
      const missing = trackMissing(missingPositions.get(id), tickNow);
      missingPositions.set(id, missing);
      if (closeConfirmedByAbsence(missing, tickNow, positionGoneConfirmMs, positionGoneConfirmTicks)) {
        confirmPositionClosed(id, "absence");
      }
    }
    for (const id of openIds) {
      knownPositionIds.add(id);
      missingPositions.delete(id);
    }

    // Breakeven e trailing girano anche mentre un ingresso e' in corso: sono gestione, non ingresso.
    await driveManagedExits(openPositions, quote);
    await driveSltpExits(openPositions, quote);

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
        tpBroker: signal.tpBroker ?? null,
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

      // SLTP_MODE=fixed|trailing: sostituisce SL/TP calcolati dalla strategia con struttura M1 +
      // ATR M1 + spread, capped a SL_MAX/TP_MAX. off (default) lascia finalSignal invariato, bit
      // per bit come main: nessuna delle funzioni di dynamicSlTp.ts viene mai chiamata in quel caso.
      const activeSltpMode: SltpMode = sltpMode();
      if (activeSltpMode !== "off") {
        const closedM1ForLevels = closedBars(m1, 1, Date.now()) ?? [];
        const atrM1ForLevels = atr(closedM1ForLevels, 14, true);
        if (!atrM1ForLevels || !(atrM1ForLevels > 0) || !Number.isFinite(finalSignal.entry)) {
          const reason = "SLTP_MODE: ATR M1 non disponibile, nessun ordine senza livelli calcolabili dalla struttura.";
          await markSkipped(signalId, reason);
          latestDecision = noTradeDecision(reason, finalQuote, { setup: finalSignal.setup, evaluations: finalSignal.evaluations });
          return;
        }
        const levelsSpec = connection.terminalState.specification?.(symbol());
        const levelsTickSizeUsd = Number(levelsSpec?.tickSize) > 0 ? Number(levelsSpec!.tickSize) : 0.01;
        const levelsStopsLevelMinUsd = stopsLevelMinDistanceUsd(levelsSpec?.stopsLevel, levelsSpec?.point ?? levelsTickSizeUsd);
        const sltpInitial = sltpInitialLevels({
          direction: finalSignal.direction as "BUY" | "SELL",
          entry: finalSignal.entry!,
          m1: closedM1ForLevels,
          atrM1: atrM1ForLevels,
          spreadUsd: finalQuote.spread,
          brokerMinDistanceUsd: levelsStopsLevelMinUsd,
          tickSizeUsd: levelsTickSizeUsd,
        });
        if (!sltpInitial.valid) {
          const reason = "SLTP_MODE: SL/TP da struttura non calcolabili al prezzo corrente, nessun ordine senza livelli validi.";
          await markSkipped(signalId, reason);
          latestDecision = noTradeDecision(reason, finalQuote, { setup: finalSignal.setup, evaluations: finalSignal.evaluations });
          return;
        }
        finalSignal.stopLoss = sltpInitial.stopLoss;
        finalSignal.takeProfit = sltpInitial.takeProfit;
        finalSignal.tpBroker = null;
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
      // Con SLTP_MODE attivo il motore cambia del tutto (vedi sltpExits sotto): l'uscita gestita
      // "classica" (breakeven poi trailing M5) resta solo per SLTP_MODE=off, come oggi in main.
      const useSltpEngine = activeSltpMode !== "off";
      const managedExit = !useSltpEngine && isManagedSetup(finalSignal.setup);
      const target1 = finalSignal.takeProfit!;
      // Ogni ordine parte con SL e TP: sui setup gestiti il TP e' la rete di sicurezza, non l'obiettivo.
      const brokerTp = managedExit ? finalSignal.tpBroker ?? null : finalSignal.takeProfit!;
      if (managedExit && !Number.isFinite(Number(brokerTp))) {
        const reason = "TP di sicurezza non calcolabile: nessun ordine senza rete al broker.";
        await markSkipped(signalId, reason);
        latestDecision = noTradeDecision(reason, finalQuote, { setup: finalSignal.setup, evaluations: finalSignal.evaluations });
        return;
      }
      const riskPlan = {
        lots: orderLots,
        requestedLots: activeLots,
        lotsCapped,
        managedExit,
        target1,
        tpBroker: brokerTp,
        tpBrokerDistance: Number(Math.abs(Number(brokerTp) - finalSignal.entry!).toFixed(2)),
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
      // plannedEntryValid ricontrolla il piano R:R/minNetR della STRATEGIA: con SLTP_MODE attivo
      // SL/TP sono gia' stati sostituiti sopra con quelli da struttura, che rispondono ai loro
      // stessi vincoli (sltpInitial.valid, gia' verificato) e non a quelli del setup originale.
      const plannedInvalid = !useSltpEngine && !plannedEntryValid(finalSignal, sendQuote);
      if (
        sendAgeMs > finalQuoteMaxAgeMs
        || sendCheck.direction !== finalSignal.direction
        || sendCheck.setup !== finalSignal.setup
        || sendCheck.setupKey !== finalSignal.setupKey
        || entryDrift > maxEntryDrift
        || plannedInvalid
      ) {
        const reason = sendAgeMs > finalQuoteMaxAgeMs
          ? `Final send-check: quote vecchia ${Math.round(sendAgeMs)} ms.`
          : sendCheck.direction !== finalSignal.direction || sendCheck.setup !== finalSignal.setup
            ? `Final send-check: ${finalSignal.direction}/${finalSignal.setup ?? "—"} non più valido, ora ${sendCheck.direction}/${sendCheck.setup ?? "—"}.`
            : plannedInvalid
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
        // Il TP mandato al broker: sui setup gestiti e' quello di sicurezza, non target1.
        takeProfit: brokerTp,
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
        Number(brokerTp),
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
          // target1, breakeven e trailing si misurano dal prezzo di fill REALE, non dall'entry
          // teorica: al timeout si parte dall'entry teorica e si corregge al primo refresh utile.
          const filled = Number(execution.openPrice);
          const fillKnown = Number.isFinite(filled) && filled > 0;
          if (!fillKnown) {
            console.warn("[scalper-worker] fill_price_missing", JSON.stringify({
              at: new Date().toISOString(), signalId, positionId: String(execution.positionId),
              fallbackEntry: finalSignal.entry,
            }));
          }
          const target1Distance = Math.abs(target1 - finalSignal.entry!);
          const state = retargetOnFill(openManagedExit({
            positionId: String(execution.positionId),
            signalId,
            setup: finalSignal.setup!,
            direction: finalSignal.direction,
            openPrice: finalSignal.entry!,
            initialStop: finalSignal.stopLoss!,
            target1,
            brokerTp: Number(brokerTp),
            target1Distance,
            fillPending: !fillKnown,
          }), fillKnown ? filled : finalSignal.entry!);
          state.fillPending = !fillKnown;
          managedExits.set(state.positionId, state);
          knownPositionIds.add(state.positionId);
          missingPositions.delete(state.positionId);
          await persistManagedExit(state).catch((error) => console.error(error));
        }
        if (useSltpEngine && execution.status === "opened" && execution.positionId) {
          // SL/TP da struttura: si riparte dal fill reale quando disponibile, altrimenti
          // dall'entry teorica (corretto comunque dai ricalcoli successivi ad ogni tick).
          const filled = Number(execution.openPrice);
          const openPrice = Number.isFinite(filled) && filled > 0 ? filled : finalSignal.entry!;
          const sltpState: SltpExitState = {
            positionId: String(execution.positionId),
            signalId,
            direction: finalSignal.direction,
            entry: openPrice,
            mode: activeSltpMode === "trailing" ? "trailing" : "fixed",
            stopLoss: finalSignal.stopLoss!,
            slUpdates: 0,
            initialTp: finalSignal.takeProfit!,
            currentTp: finalSignal.takeProfit!,
            tpTriggered: false,
            peak: openPrice,
            lastUpdateAtMs: null,
          };
          sltpExits.set(sltpState.positionId, sltpState);
          knownPositionIds.add(sltpState.positionId);
          missingPositions.delete(sltpState.positionId);
          await persistSltpExit(sltpState).catch((error) => console.error(error));
        }
        const targetLabel = managedExit ? "Target1" : "TP";
        const sltpLabel = activeSltpMode === "trailing" ? "TP trailing" : activeSltpMode === "fixed" ? "TP fisso" : targetLabel;
        void sendTelegram(
          `\u{1f7e2} SCALPER ${symbol()} · apertura ${finalSignal.direction}`
          + `\nlotti ${orderLots}${lotsCapped ? ` (ridotti da ${activeLots} per il cap rischio)` : ""}`
          + ` · entry ${money(finalSignal.entry)} · SL ${money(finalSignal.stopLoss)} · ${sltpLabel} ${money(target1)}`
          + `\nSL ${money(riskPlan.slDistance)}$ · ${sltpLabel} ${money(riskPlan.target1Distance)}$ a ${finalSignal.riskReward}R`
          + ` · rischio ${money(riskPlan.risk)} ${riskPlan.currency ?? "EUR"}${riskPlan.riskPct === null ? "" : ` (${money(riskPlan.riskPct)}% del saldo)`}`
          + `${managedExit ? `\nTP broker (sicurezza) ${money(brokerTp)} a ${money(riskPlan.tpBrokerDistance)}$ · uscita gestita: breakeven a Target1 poi trailing M5` : ""}`
          + `${useSltpEngine ? `\nSLTP_MODE=${activeSltpMode}: SL da struttura, si stringe soltanto${activeSltpMode === "trailing" ? "; TP trailing dopo il trigger di estensione" : "; TP fisso"}.` : ""}`
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
  await restoreSltpExits().catch((error) => console.error(error));
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
          // Un deal di chiusura in history e' conferma piena: non serve aspettare l'assenza.
          confirmPositionClosed(closure.positionId, "deal");
          void sendTelegram(
            `${closure.profit > 0 ? "\u2705" : closure.profit < 0 ? "\u274c" : "\u2796"} SCALPER ${symbol()} · chiusura ${closure.outcome} (${closure.closeReason ?? "SL/TP"})`
            + `\nprofitto ${money(closure.profit)} · ${money(closure.openPrice)} \u2192 ${money(closure.closePrice)} · ${closure.resultR >= 0 ? "+" : ""}${closure.resultR}R`
            + `${countsAsLoss(closure.outcome, closure.closeReason, closure.profit) ? `\n${lossGuardLine()}` : ""}`
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
    void restoreSltpExits().catch((error) => console.error(error));
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

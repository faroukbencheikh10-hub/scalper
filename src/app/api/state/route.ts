import { NextResponse } from "next/server";
import { dbQuery, ensureSchema } from "@/lib/server/db";
import { lotsMax, lotsMin, resolveLots } from "@/lib/server/tradingConfig";
import { EXEC_LOTS_SETTING_KEY, LOT_CHOICES } from "@/lib/lots";
import { getSessionStatus, sessionConfigFromEnv, type SessionConfig } from "@/lib/session";
import { parseWorkerHeartbeat } from "@/lib/server/workerHeartbeat";

export const dynamic = "force-dynamic";

const SETTING_KEYS = [
  "stream_worker_status",
  "stream_worker_heartbeat",
  "stream_worker_detail",
  "stream_last_quote",
  "stream_last_decision",
  "stream_last_flatten",
  "stream_last_error",
  "system_stop",
  "system_stop_changed_at",
  EXEC_LOTS_SETTING_KEY,
] as const;

type OperationalState = "LIVE" | "WAITING" | "STOP" | "OFFLINE";
type ParsedError = { raw: string; message: string; at: string | null; atMs: number | null };
type WorkerAccount = { balance?: number | null; equity?: number | null; margin?: number | null; freeMargin?: number | null; leverage?: number | null; currency?: string | null };
type ManagedExit = { positionId?: string; setup?: string; direction?: string; openPrice?: number; initialStop?: number; target1?: number; tpBroker?: number | null; fillPending?: boolean; stopLoss?: number; target1Hit?: boolean; breakevenPrice?: number | null; breakevenAt?: string | null; trailingActive?: boolean; trailingUpdates?: number };
type QuickExit = { positionId?: string; setup?: string; direction?: string; openPrice?: number; tpBroker?: number | null; tpRejected?: boolean; fillPending?: boolean; closing?: { reason?: string; attempts?: number } | null };
type WorkerDetail = { symbol?: string; mode?: string; autoExec?: boolean; lots?: number; lotsMin?: number; lotsMax?: number; account?: WorkerAccount | null; maxOpenPositions?: number; openPositions?: number; maxTradesPerDay?: number; tradeDedupSeconds?: number; managed?: ManagedExit[]; exitMode?: string; tpQuickUsd?: number; emergencySlUsd?: number; reEntrySec?: number; quick?: QuickExit[]; riskMaxPct?: number; riskCapActive?: boolean; lossLockedDirections?: string[]; lossLockUntil?: Record<string, string>; lossPauseUntil?: string | null; lossLockMinutes?: number; consecLossPauseMinutes?: number; quoteAgeSec?: number | null; m1?: number; m5?: number; hoursUtc?: string; flattenBeforeEndMin?: number; fridayCloseUtc?: string };

function parseJson<T = Record<string, unknown>>(value: string | undefined): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function parseStreamError(value: string | undefined): ParsedError | null {
  if (!value) return null;
  const firstSpace = value.indexOf(" ");
  const timestamp = firstSpace > 0 ? value.slice(0, firstSpace) : value;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return { raw: value, message: value, at: null, atMs: null };
  return { raw: value, message: firstSpace > 0 ? value.slice(firstSpace + 1).trim() || value : value, at: new Date(parsed).toISOString(), atMs: parsed };
}

function workerSessionConfig(detail: WorkerDetail | null): SessionConfig {
  const fallback = sessionConfigFromEnv();
  return {
    hoursUtc: detail?.hoursUtc?.trim() || fallback.hoursUtc,
    flattenBeforeEndMin: Number.isFinite(detail?.flattenBeforeEndMin) ? Math.max(0, Number(detail?.flattenBeforeEndMin)) : fallback.flattenBeforeEndMin,
    fridayCloseUtc: detail?.fridayCloseUtc?.trim() || fallback.fridayCloseUtc,
  };
}

export async function GET() {
  try {
    await ensureSchema();
    const [settingsResult, signals, stats, lastClosed] = await Promise.all([
      dbQuery(`SELECT key,value FROM scalper_settings WHERE key = ANY($1::text[])`, [SETTING_KEYS]),
      dbQuery(`SELECT * FROM scalper_signals ORDER BY created_at DESC LIMIT 20`),
      dbQuery(`SELECT COUNT(*) FILTER (WHERE outcome IN ('WIN','LOSS','BREAKEVEN'))::int AS total, COUNT(*) FILTER (WHERE outcome='WIN')::int AS wins, COUNT(*) FILTER (WHERE outcome='LOSS')::int AS losses, COUNT(*) FILTER (WHERE outcome='BREAKEVEN')::int AS breakeven, COALESCE(SUM(mt5_profit) FILTER (WHERE outcome IN ('WIN','LOSS','BREAKEVEN')),0)::float8 AS profit, COALESCE(SUM(result_r) FILTER (WHERE outcome IN ('WIN','LOSS','BREAKEVEN')),0)::float8 AS result_r FROM scalper_signals`),
      dbQuery(`SELECT direction,setup,outcome,mt5_profit,result_r,mt5_open_price,mt5_close_price,closed_at FROM scalper_signals WHERE outcome IN ('WIN','LOSS','BREAKEVEN') ORDER BY closed_at DESC NULLS LAST LIMIT 1`),
    ]);

    const settings = new Map<string, string>();
    for (const row of settingsResult.rows as Array<{ key: string; value: string }>) settings.set(row.key, row.value);

    const now = new Date();
    const workerStatus = settings.get("stream_worker_status") ?? "not_started";
    const workerHeartbeat = parseWorkerHeartbeat(settings.get("stream_worker_heartbeat"));
    const workerDetail = parseJson<WorkerDetail>(settings.get("stream_worker_detail"));
    const quote = parseJson(settings.get("stream_last_quote"));
    const lastDecision = parseJson(settings.get("stream_last_decision"));
    const lastFlatten = parseJson<{ at?: string; closed?: string[]; canceled?: string[]; reason?: string; failures?: string[] }>(settings.get("stream_last_flatten"));
    const parsedError = parseStreamError(settings.get("stream_last_error"));
    const stopped = settings.get("system_stop") === "true";

    const heartbeatMs = workerHeartbeat.atMs ?? Number.NaN;
    const heartbeatAgeMs = workerHeartbeat.atMs !== null ? Math.max(0, now.getTime() - workerHeartbeat.atMs) : null;
    const heartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs < 60_000;
    const config = workerSessionConfig(workerDetail);
    const sessionStatus = getSessionStatus(now, config);

    let state: OperationalState;
    if (stopped) state = "STOP";
    else if (!heartbeatFresh) state = "OFFLINE";
    else if (!sessionStatus.inside || sessionStatus.inFlattenWindow) state = "WAITING";
    else state = "LIVE";

    const errorIsCurrent = Boolean(parsedError?.atMs !== null && parsedError?.atMs !== undefined && (!Number.isFinite(heartbeatMs) || parsedError.atMs > heartbeatMs));
    const st = stats.rows[0] ?? {};
    const wins = Number(st.wins ?? 0), losses = Number(st.losses ?? 0), decided = wins + losses;

    return NextResponse.json({
      ok: true,
      name: "scalper",
      mode: "MetaApi Streaming/WebSocket",
      serverTime: now.toISOString(),
      operational: { state, heartbeatFresh, heartbeatAgeSeconds: heartbeatAgeMs === null ? null : Math.floor(heartbeatAgeMs / 1000), quoteAgeSec: workerHeartbeat.quoteAgeSec ?? workerDetail?.quoteAgeSec ?? null },
      session: {
        hoursUtc: config.hoursUtc,
        inside: sessionStatus.inside,
        weekendClosed: sessionStatus.weekendClosed,
        inFlattenWindow: sessionStatus.inFlattenWindow,
        minutesUntilEnd: sessionStatus.minutesUntilEnd,
        sessionStartAt: sessionStatus.sessionStartAt,
        sessionEndAt: sessionStatus.sessionEndAt,
        flattenAt: sessionStatus.flattenAt,
        nextStartAt: sessionStatus.nextStartAt,
        nextFlattenAt: sessionStatus.nextFlattenAt,
        flattenBeforeEndMin: config.flattenBeforeEndMin,
        fridayCloseUtc: config.fridayCloseUtc,
        blockReason: sessionStatus.blockReason,
      },
      systemStopped: stopped,
      systemStopChangedAt: settings.get("system_stop_changed_at") ?? null,
      quote,
      autoExec: typeof workerDetail?.autoExec === "boolean" ? workerDetail.autoExec : null,
      lots: resolveLots(settings.get(EXEC_LOTS_SETTING_KEY)),
      lotsMin: lotsMin(),
      lotsMax: lotsMax(),
      lotChoices: LOT_CHOICES,
      account: workerDetail?.account ?? null,
      results: { total: Number(st.total ?? 0), wins, losses, breakeven: Number(st.breakeven ?? 0), winRate: decided > 0 ? Number(((wins / decided) * 100).toFixed(1)) : 0, profit: Number(st.profit ?? 0), resultR: Number(st.result_r ?? 0), last: lastClosed.rows[0] ?? null },
      stream: { status: workerStatus, heartbeat: workerHeartbeat.at, heartbeatData: { at: workerHeartbeat.at, quoteAgeSec: workerHeartbeat.quoteAgeSec }, detail: workerDetail, lastDecision, lastFlatten, currentError: errorIsCurrent && parsedError ? { message: parsedError.message, at: parsedError.at } : null, historicalError: !errorIsCurrent && parsedError ? { message: parsedError.message, at: parsedError.at } : null },
      signals: signals.rows,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

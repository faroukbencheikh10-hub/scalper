import { NextResponse } from "next/server";
import { dbQuery, ensureSchema } from "@/lib/server/db";
import { lots } from "@/lib/server/executor";

export const dynamic = "force-dynamic";

const SETTING_KEYS = [
  "stream_worker_status",
  "stream_worker_heartbeat",
  "stream_worker_detail",
  "stream_last_quote",
  "stream_last_decision",
  "stream_last_error",
  "system_stop",
  "system_stop_changed_at",
] as const;

type OperationalState = "LIVE" | "WAITING" | "STOP" | "OFFLINE";

type ParsedError = {
  raw: string;
  message: string;
  at: string | null;
  atMs: number | null;
};

function parseJson<T = Record<string, unknown>>(value: string | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function parseMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

function parseHours(raw: string) {
  const [from, to] = raw.split("-").map((part) => part.trim());
  if (!from || !to) return null;
  const start = parseMinutes(from);
  const end = parseMinutes(to);
  if (start === null || end === null) return null;
  return { raw, from, to, start, end };
}

function insideHours(now: Date, raw: string) {
  const hours = parseHours(raw);
  if (!hours || hours.start === hours.end) return true;
  const current = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (hours.start < hours.end) return current >= hours.start && current < hours.end;
  return current >= hours.start || current < hours.end;
}

function nextSessionStart(now: Date, raw: string) {
  const hours = parseHours(raw);
  if (!hours || hours.start === hours.end || insideHours(now, raw)) return null;

  const current = now.getUTCHours() * 60 + now.getUTCMinutes();
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCHours(Math.floor(hours.start / 60), hours.start % 60, 0, 0);

  if (hours.start < hours.end) {
    if (current >= hours.end) next.setUTCDate(next.getUTCDate() + 1);
  } else if (current >= hours.start) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  return next.toISOString();
}

function parseStreamError(value: string | undefined): ParsedError | null {
  if (!value) return null;
  const firstSpace = value.indexOf(" ");
  const timestamp = firstSpace > 0 ? value.slice(0, firstSpace) : value;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return { raw: value, message: value, at: null, atMs: null };
  }
  return {
    raw: value,
    message: firstSpace > 0 ? value.slice(firstSpace + 1).trim() || value : value,
    at: new Date(parsed).toISOString(),
    atMs: parsed,
  };
}

export async function GET() {
  try {
    await ensureSchema();

    const [settingsResult, signals, stats, lastClosed] = await Promise.all([
      dbQuery(`SELECT key,value FROM scalper_settings WHERE key = ANY($1::text[])`, [SETTING_KEYS]),
      dbQuery(`SELECT * FROM scalper_signals ORDER BY created_at DESC LIMIT 20`),
      dbQuery(`SELECT
        COUNT(*) FILTER (WHERE outcome IN ('WIN','LOSS','BREAKEVEN'))::int AS total,
        COUNT(*) FILTER (WHERE outcome='WIN')::int AS wins,
        COUNT(*) FILTER (WHERE outcome='LOSS')::int AS losses,
        COUNT(*) FILTER (WHERE outcome='BREAKEVEN')::int AS breakeven,
        COALESCE(SUM(mt5_profit) FILTER (WHERE outcome IN ('WIN','LOSS','BREAKEVEN')),0)::float8 AS profit,
        COALESCE(SUM(result_r) FILTER (WHERE outcome IN ('WIN','LOSS','BREAKEVEN')),0)::float8 AS result_r
      FROM scalper_signals`),
      dbQuery(`SELECT direction,setup,outcome,mt5_profit,result_r,mt5_open_price,mt5_close_price,closed_at
        FROM scalper_signals
        WHERE outcome IN ('WIN','LOSS','BREAKEVEN')
        ORDER BY closed_at DESC NULLS LAST
        LIMIT 1`),
    ]);

    const settings = new Map<string, string>();
    for (const row of settingsResult.rows as Array<{ key: string; value: string }>) settings.set(row.key, row.value);

    const now = new Date();
    const workerStatus = settings.get("stream_worker_status") ?? "not_started";
    const workerHeartbeat = settings.get("stream_worker_heartbeat");
    const workerDetail = parseJson<{ symbol?: string; mode?: string; autoExec?: boolean; m1?: number; m5?: number }>(settings.get("stream_worker_detail"));
    const quote = parseJson(settings.get("stream_last_quote"));
    const lastDecision = parseJson(settings.get("stream_last_decision"));
    const parsedError = parseStreamError(settings.get("stream_last_error"));
    const stopped = settings.get("system_stop") === "true";

    const heartbeatMs = workerHeartbeat ? Date.parse(workerHeartbeat) : Number.NaN;
    const heartbeatAgeMs = Number.isFinite(heartbeatMs) ? Math.max(0, now.getTime() - heartbeatMs) : null;
    const heartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs < 60_000;
    const hoursRaw = process.env.SCALPER_HOURS_UTC?.trim() || "06:30-20:30";
    const inTradeHours = insideHours(now, hoursRaw);

    let state: OperationalState;
    if (stopped) state = "STOP";
    else if (!heartbeatFresh) state = "OFFLINE";
    else if (!inTradeHours) state = "WAITING";
    else state = "LIVE";

    const errorIsCurrent = Boolean(
      parsedError?.atMs !== null &&
      parsedError?.atMs !== undefined &&
      (!Number.isFinite(heartbeatMs) || parsedError.atMs > heartbeatMs),
    );

    const st = stats.rows[0] ?? {};
    const wins = Number(st.wins ?? 0);
    const losses = Number(st.losses ?? 0);
    const decided = wins + losses;

    return NextResponse.json({
      ok: true,
      name: "scalper",
      mode: "MetaApi Streaming/WebSocket",
      serverTime: now.toISOString(),
      operational: {
        state,
        heartbeatFresh,
        heartbeatAgeSeconds: heartbeatAgeMs === null ? null : Math.floor(heartbeatAgeMs / 1000),
      },
      session: {
        hoursUtc: hoursRaw,
        inside: inTradeHours,
        nextStartAt: nextSessionStart(now, hoursRaw),
      },
      systemStopped: stopped,
      systemStopChangedAt: settings.get("system_stop_changed_at") ?? null,
      quote,
      autoExec: typeof workerDetail?.autoExec === "boolean" ? workerDetail.autoExec : null,
      lots: lots(),
      results: {
        total: Number(st.total ?? 0),
        wins,
        losses,
        breakeven: Number(st.breakeven ?? 0),
        winRate: decided > 0 ? Number(((wins / decided) * 100).toFixed(1)) : 0,
        profit: Number(st.profit ?? 0),
        resultR: Number(st.result_r ?? 0),
        last: lastClosed.rows[0] ?? null,
      },
      stream: {
        status: workerStatus,
        heartbeat: workerHeartbeat ?? null,
        detail: workerDetail,
        lastDecision,
        currentError: errorIsCurrent && parsedError ? { message: parsedError.message, at: parsedError.at } : null,
        historicalError: !errorIsCurrent && parsedError ? { message: parsedError.message, at: parsedError.at } : null,
      },
      signals: signals.rows,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

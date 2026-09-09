import { NextResponse } from "next/server";
import { ensureSchema, getSettings } from "@/lib/server/db";

export const dynamic = "force-dynamic";

const MAX_HEARTBEAT_AGE_SEC = 180;

export async function GET() {
  try {
    await ensureSchema();
    const settings = await getSettings(["stream_worker_heartbeat", "stream_worker_status", "system_stop"]);
    const status = settings.get("stream_worker_status") ?? "not_started";
    const stopped = settings.get("system_stop") === "true";
    const heartbeat = settings.get("stream_worker_heartbeat");
    const heartbeatMs = heartbeat ? Date.parse(heartbeat) : Number.NaN;
    const heartbeatAgeSec = Number.isFinite(heartbeatMs)
      ? Math.max(0, Math.floor((Date.now() - heartbeatMs) / 1000))
      : null;

    if (stopped || (heartbeatAgeSec !== null && heartbeatAgeSec < MAX_HEARTBEAT_AGE_SEC)) {
      return NextResponse.json({ ok: true, heartbeatAgeSec, status, systemStopped: stopped });
    }

    return NextResponse.json({
      ok: false,
      reason: heartbeatAgeSec === null
        ? "heartbeat worker assente"
        : `heartbeat worker vecchio di ${heartbeatAgeSec} s (max ${MAX_HEARTBEAT_AGE_SEC} s)`,
      heartbeatAgeSec,
      status,
    }, { status: 503 });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      heartbeatAgeSec: null,
      status: "unknown",
    }, { status: 503 });
  }
}

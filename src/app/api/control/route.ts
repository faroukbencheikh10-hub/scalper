import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, getSetting, setSystemStop, systemStopActive } from "@/lib/server/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureSchema();
    return NextResponse.json({
      ok: true,
      stopped: await systemStopActive(),
      changedAt: await getSetting("system_stop_changed_at") ?? null,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const body = await req.json().catch(() => ({}));
    if (typeof body?.stopped !== "boolean") {
      return NextResponse.json({ ok: false, error: "stopped boolean richiesto" }, { status: 400 });
    }
    await setSystemStop(body.stopped);
    return NextResponse.json({
      ok: true,
      stopped: body.stopped,
      note: body.stopped
        ? "STOP TUTTO attivo: nuove entrate bloccate. Il worker chiude a mercato tutte le posizioni XAUUSD e cancella gli ordini pendenti XAUUSD."
        : "Sistema riattivato.",
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

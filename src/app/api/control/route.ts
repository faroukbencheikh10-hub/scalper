import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, getSetting, setSetting, setSystemStop, systemStopActive } from "@/lib/server/db";
import { clampLots, lotsMax, lotsMin, resolveLots } from "@/lib/server/tradingConfig";
import { EXEC_LOTS_SETTING_KEY, LOT_CHOICES } from "@/lib/lots";
import { dashboardGuard } from "@/lib/server/dashboardAuth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await dashboardGuard(req);
  if (denied) return denied;
  try {
    await ensureSchema();
    return NextResponse.json({
      ok: true,
      stopped: await systemStopActive(),
      changedAt: await getSetting("system_stop_changed_at") ?? null,
      lots: resolveLots(await getSetting(EXEC_LOTS_SETTING_KEY)),
      lotsMin: lotsMin(),
      lotsMax: lotsMax(),
      lotChoices: LOT_CHOICES,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const denied = await dashboardGuard(req);
  if (denied) return denied;
  try {
    await ensureSchema();
    const body = await req.json().catch(() => ({}));

    if (body?.action === "set_lots") {
      const requested = Number(body.lots);
      if (!Number.isFinite(requested) || requested <= 0) {
        return NextResponse.json({ ok: false, error: "lots numerico positivo richiesto" }, { status: 400 });
      }
      const applied = clampLots(requested);
      await setSetting(EXEC_LOTS_SETTING_KEY, applied.toFixed(2));
      return NextResponse.json({
        ok: true,
        lots: applied,
        requested,
        clamped: applied !== requested,
        lotsMin: lotsMin(),
        lotsMax: lotsMax(),
        note: applied !== requested
          ? `Lotti impostati a ${applied.toFixed(2)} (richiesti ${requested}, limiti ${lotsMin().toFixed(2)}–${lotsMax().toFixed(2)}). Il worker li applica al prossimo ciclo di controllo.`
          : `Lotti impostati a ${applied.toFixed(2)}. Il worker li applica al prossimo ciclo di controllo.`,
      });
    }

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

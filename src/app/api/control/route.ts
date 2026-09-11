import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, getSetting, setSetting, setSystemStop, systemStopActive } from "@/lib/server/db";
import { clampLots, lotsMax, lotsMin, resolveLots } from "@/lib/server/tradingConfig";
import { EXEC_LOTS_SETTING_KEY, LOT_CHOICES } from "@/lib/lots";
import {
  clampFastTpUsd, DEFAULT_FAST_TP_USD, EXIT_MODE_SETTING_KEY, FAST_TP_USD_SETTING_KEY,
  MIN_FAST_TP_USD, resolveExitMode, resolveFastTpUsd,
} from "@/lib/exitMode";
import {
  parseHhMm, resolveScheduledCloseConfig, scheduledCloseStatus, SCHEDULED_CLOSE_ENABLED_KEY,
  SCHEDULED_CLOSE_END_KEY, SCHEDULED_CLOSE_START_KEY, SCHEDULED_CLOSE_TIMEZONE_KEY,
  SCHEDULED_CLOSE_TIMEZONE,
} from "@/lib/scheduledClose";
import { dashboardGuard } from "@/lib/server/dashboardAuth";

export const dynamic = "force-dynamic";

/** Le quattro chiavi della chiusura programmata, lette esattamente come le legge il worker. */
async function readScheduledCloseConfig() {
  const [enabled, startLocal, endLocal, timeZone] = await Promise.all([
    getSetting(SCHEDULED_CLOSE_ENABLED_KEY),
    getSetting(SCHEDULED_CLOSE_START_KEY),
    getSetting(SCHEDULED_CLOSE_END_KEY),
    getSetting(SCHEDULED_CLOSE_TIMEZONE_KEY),
  ]);
  const values: Record<string, string | undefined> = {
    [SCHEDULED_CLOSE_ENABLED_KEY]: enabled,
    [SCHEDULED_CLOSE_START_KEY]: startLocal,
    [SCHEDULED_CLOSE_END_KEY]: endLocal,
    [SCHEDULED_CLOSE_TIMEZONE_KEY]: timeZone,
  };
  return resolveScheduledCloseConfig((key) => values[key]);
}

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
      exitMode: resolveExitMode(await getSetting(EXIT_MODE_SETTING_KEY)),
      fastTpUsd: resolveFastTpUsd(await getSetting(FAST_TP_USD_SETTING_KEY)),
      fastTpUsdMin: MIN_FAST_TP_USD,
      scheduledClose: scheduledCloseStatus(new Date(), await readScheduledCloseConfig()),
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

    if (body?.action === "set_exit_mode") {
      if (body.exitMode !== "normal" && body.exitMode !== "fast") {
        return NextResponse.json({ ok: false, error: "exitMode 'normal' o 'fast' richiesto" }, { status: 400 });
      }
      const exitMode = body.exitMode as "normal" | "fast";
      const requestedTp = body.fastTpUsd === undefined ? DEFAULT_FAST_TP_USD : Number(body.fastTpUsd);
      if (!Number.isFinite(requestedTp) || requestedTp <= 0) {
        return NextResponse.json({ ok: false, error: "fastTpUsd numerico positivo richiesto" }, { status: 400 });
      }
      const appliedTp = clampFastTpUsd(requestedTp);
      await setSetting(EXIT_MODE_SETTING_KEY, exitMode);
      await setSetting(FAST_TP_USD_SETTING_KEY, appliedTp.toFixed(2));
      return NextResponse.json({
        ok: true,
        exitMode,
        fastTpUsd: appliedTp,
        requestedFastTpUsd: requestedTp,
        clamped: appliedTp !== requestedTp,
        note: exitMode === "fast"
          ? `Modalita' fast attiva: target ${appliedTp.toFixed(2)}$ dall'entry${appliedTp !== requestedTp ? ` (richiesti ${requestedTp}, minimo ${MIN_FAST_TP_USD})` : ""}. Si applica solo alle nuove posizioni, non a quelle gia' aperte.`
          : "Modalita' normale attiva: target1, breakeven e trailing come prima. Si applica solo alle nuove posizioni, non a quelle gia' aperte.",
      });
    }

    if (body?.action === "set_scheduled_close") {
      // Gli orari arrivano gia' convertiti nel fuso di riferimento dalla dashboard, come "HH:MM".
      // Si scrivono solo se presenti nel body: spegnere la programmazione non li cancella mai.
      for (const [field, value] of [["startLocal", body.startLocal], ["endLocal", body.endLocal]] as const) {
        if (value !== undefined && parseHhMm(typeof value === "string" ? value : null) === null) {
          return NextResponse.json({ ok: false, error: `${field} deve essere "HH:MM"` }, { status: 400 });
        }
      }
      if (body.startLocal !== undefined) await setSetting(SCHEDULED_CLOSE_START_KEY, String(body.startLocal).trim());
      if (body.endLocal !== undefined) await setSetting(SCHEDULED_CLOSE_END_KEY, String(body.endLocal).trim());
      await setSetting(SCHEDULED_CLOSE_TIMEZONE_KEY, SCHEDULED_CLOSE_TIMEZONE);

      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
          return NextResponse.json({ ok: false, error: "enabled boolean richiesto" }, { status: 400 });
        }
        // Si accende solo con una finestra davvero utilizzabile: due orari validi e diversi.
        if (body.enabled) {
          const pending = await readScheduledCloseConfig();
          if (!scheduledCloseStatus(new Date(), pending).configured) {
            return NextResponse.json(
              { ok: false, error: "Imposta prima due orari validi e diversi fra loro." },
              { status: 400 },
            );
          }
        }
        await setSetting(SCHEDULED_CLOSE_ENABLED_KEY, body.enabled ? "true" : "false");
      }

      const status = scheduledCloseStatus(new Date(), await readScheduledCloseConfig());
      return NextResponse.json({
        ok: true,
        scheduledClose: status,
        note: !status.enabled
          ? "Chiusura programmata spenta: nessun effetto sulle aperture. Gli orari restano salvati."
          : status.active
            ? `Chiusura programmata attiva e in corso (${status.startLocal}-${status.endLocal} ${status.timeZone}): nessun nuovo ordine fino alle ${status.endLocal}. Le posizioni gia' aperte restano gestite normalmente.`
            : `Chiusura programmata attiva: nessun nuovo ordine dalle ${status.startLocal} alle ${status.endLocal} (${status.timeZone}). Fuori da quella finestra il bot opera come sempre.`,
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

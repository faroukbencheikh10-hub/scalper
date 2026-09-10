// Watchdog: processo one-shot (cron Railway ogni 5 min) che termina sempre con exit 0.
// Se il worker streaming e' morto avvisa su Telegram e, se necessario, chiude le
// posizioni rimaste aperte usando MetaApi REST.
//
// Non esiste e non deve esistere alcuna chiusura per eta' o durata della posizione: i trade
// restano aperti finche' non li chiude lo stop, il flatten di fine fascia o lo STOP. Le soglie
// WATCHDOG_MAX_AGE_SEC e WATCHDOG_CLOSE_AFTER_SEC misurano solo l'eta' dell'heartbeat del worker,
// cioe' da quanto il worker non risponde, mai da quanto e' aperta una posizione.

import { dbQuery, ensureSchema, getSettings, setSetting } from "../src/lib/server/db";
import { deals, symbol } from "../src/lib/server/metaApi";
import { money, sendTelegram } from "../src/lib/server/notify";
import { lots } from "../src/lib/server/tradingConfig";
import { getSessionStatus, sessionConfigFromEnv } from "../src/lib/session";
import { watchdogClosePosition, watchdogPositions, type WatchdogPosition } from "../src/lib/server/watchdogMetaApi";
import { effectiveQuoteAgeSec } from "../src/lib/server/staleQuoteGuard";
import { parseWorkerHeartbeat } from "../src/lib/server/workerHeartbeat";

const ALERT_INTERVAL_MS = 30 * 60_000;
const STALE_QUOTE_ALERT_INTERVAL_MS = 10 * 60_000;
const STALE_QUOTE_SEC = 180;
const SESSION_END_GUARD_MIN = 15;
const ALERT_SETTING_KEY = "watchdog_last_alert";
const STALE_QUOTE_ALERT_SETTING_KEY = "watchdog_last_stale_quote_alert";
const RAILWAY_API_URL = "https://backboard.railway.com/graphql/v2";

function envInt(name: string, fallback: number, min: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function positionDirection(position: WatchdogPosition) {
  const type = String(position.type ?? "").toUpperCase();
  if (type.includes("SELL")) return "SELL";
  if (type.includes("BUY")) return "BUY";
  return null;
}

/** Fine fascia imminente o mercato gia' chiuso per il venerdi'/weekend. */
function sessionForcesClose() {
  const status = getSessionStatus(new Date(), sessionConfigFromEnv());
  if (status.weekendClosed) return "mercato chiuso (weekend / oltre SCALPER_FRIDAY_CLOSE_UTC)";
  if (status.minutesUntilEnd !== null && status.minutesUntilEnd <= SESSION_END_GUARD_MIN) {
    return `fine fascia fra ${status.minutesUntilEnd} min`;
  }
  if (!status.inside) return "fuori fascia operativa";
  return null;
}

/** Registra la chiusura in scalper_signals/trades come fa il flatten del worker. */
async function recordClosure(position: WatchdogPosition, reason: string) {
  const history = await deals(position.id);
  const out = history
    .filter((deal) => deal.entryType && deal.entryType !== "DEAL_ENTRY_IN")
    .sort((a, b) => Date.parse(a.time ?? "") - Date.parse(b.time ?? ""))
    .at(-1);
  const inn = history
    .filter((deal) => deal.entryType === "DEAL_ENTRY_IN")
    .sort((a, b) => Date.parse(a.time ?? "") - Date.parse(b.time ?? ""))[0];
  if (!out || !Number.isFinite(Number(out.price))) {
    throw new Error(`Storico chiusura non disponibile per posizione ${position.id}`);
  }

  const close = Number(out.price);
  const profit = Number(out.profit ?? 0);
  const volume = Number(position.volume ?? inn?.volume ?? lots());

  const found = await dbQuery(
    `SELECT id,entry,stop_loss,mt5_open_price
       FROM scalper_signals
      WHERE mt5_position_id=$1
      ORDER BY created_at DESC LIMIT 1`,
    [position.id],
  );
  const signal = found.rows[0];

  if (signal) {
    const open = Number(signal.mt5_open_price ?? position.openPrice ?? inn?.price ?? signal.entry);
    const risk = Math.abs(open - Number(signal.stop_loss));
    const signed = Number(signal.entry) < Number(signal.stop_loss) ? open - close : close - open;
    const resultR = risk > 0 ? Number((signed / risk).toFixed(2)) : 0;
    // La chiusura d'emergenza non e' mai una perdita del setup: close_reason resta "watchdog".
    await dbQuery(
      `UPDATE scalper_signals
          SET mt5_open_price=COALESCE(mt5_open_price,$2),mt5_close_price=$3,mt5_profit=$4,
              outcome=$5,result_r=$6,closed_at=COALESCE($7::timestamptz,now()),
              mt5_volume=COALESCE(mt5_volume,$8),close_reason='watchdog',final_sl=COALESCE(final_sl,stop_loss)
        WHERE id=$1`,
      [signal.id, open, close, profit, profit > 0 ? "WIN" : profit < 0 ? "LOSS" : "BREAKEVEN", resultR, out.time ?? null, volume],
    );
    await dbQuery(
      `UPDATE trades SET reason=$2,close_reason='watchdog',
              payload=COALESCE(payload,'{}'::jsonb)||jsonb_build_object('closeReason','watchdog')
        WHERE source='scalper' AND mt5_position_id=$1`,
      [position.id, reason],
    );
    return { profit, close, outcome: profit > 0 ? "WIN" : profit < 0 ? "LOSS" : "BREAKEVEN" };
  }

  const openedAt = typeof position.time === "string" ? position.time : null;
  const params = [
    symbol(), position.id, positionDirection(position), position.openPrice ?? inn?.price ?? null,
    close, profit, reason, openedAt, out.time ?? null, JSON.stringify({ volume: position.volume ?? null }), volume,
  ];
  const updated = await dbQuery(
    `UPDATE trades SET direction=$3,open_price=$4,close_price=$5,profit=$6,reason=$7,opened_at=$8,
            closed_at=COALESCE($9::timestamptz,now()),payload=$10::jsonb,lot=$11
      WHERE source='flatten_external' AND symbol=$1 AND mt5_position_id=$2`,
    params,
  );
  if (updated.rowCount === 0) {
    await dbQuery(
      `INSERT INTO trades(source,scalper_signal_id,symbol,mt5_position_id,direction,open_price,close_price,profit,result_r,reason,opened_at,closed_at,payload,lot)
       VALUES('flatten_external',NULL,$1,$2,$3,$4,$5,$6,NULL,$7,$8,COALESCE($9::timestamptz,now()),$10::jsonb,$11)`,
      params,
    );
  }
  return { profit, close, outcome: profit > 0 ? "WIN" : profit < 0 ? "LOSS" : "BREAKEVEN" };
}

async function alertThrottled(
  text: string,
  lastAlert: string | undefined,
  settingKey = ALERT_SETTING_KEY,
  intervalMs = ALERT_INTERVAL_MS,
) {
  const previous = lastAlert ? Date.parse(lastAlert) : Number.NaN;
  if (Number.isFinite(previous) && Date.now() - previous < intervalMs) return false;
  await setSetting(settingKey, new Date().toISOString());
  await sendTelegram(text);
  return true;
}

function parsedObject(raw: string | undefined) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function railwayGraphql<T>(token: string, query: string, variables: Record<string, string>) {
  const response = await fetch(RAILWAY_API_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json() as { data?: T; errors?: Array<{ message?: string }> };
  if (!response.ok || payload.errors?.length) {
    const graphError = payload.errors?.map((item) => item.message ?? "GraphQL error").join(" | ");
    throw new Error(`Railway GraphQL ${response.status}: ${graphError || response.statusText}`);
  }
  if (!payload.data) throw new Error("Railway GraphQL: risposta senza data");
  return payload.data;
}

type RailwayServiceData = {
  service: {
    serviceInstances: {
      edges: Array<{
        node: {
          environmentId?: string | null;
          latestDeployment?: { id?: string | null; createdAt?: string | null } | null;
        };
      }>;
    };
  } | null;
};

async function restartRailwayService(token: string, serviceId: string) {
  const lookup = await railwayGraphql<RailwayServiceData>(
    token,
    `query StaleQuoteService($serviceId: String!) {
      service(id: $serviceId) {
        serviceInstances { edges { node { environmentId latestDeployment { id createdAt } } } }
      }
    }`,
    { serviceId },
  );
  const instances = lookup.service?.serviceInstances.edges.map((edge) => edge.node) ?? [];
  const preferredEnvironmentId = process.env.RAILWAY_ENVIRONMENT_ID?.trim();
  const candidates = instances
    .filter((node) => node.latestDeployment?.id)
    .sort((a, b) => {
      const bAt = Date.parse(b.latestDeployment?.createdAt ?? "");
      const aAt = Date.parse(a.latestDeployment?.createdAt ?? "");
      return (Number.isFinite(bAt) ? bAt : 0) - (Number.isFinite(aAt) ? aAt : 0);
    });
  const target = (preferredEnvironmentId
    ? candidates.find((node) => node.environmentId === preferredEnvironmentId)
    : null) ?? candidates[0];
  if (!target?.latestDeployment?.id) throw new Error(`Railway: nessun deployment trovato per service ${serviceId}`);

  if (target.environmentId) {
    try {
      await railwayGraphql<{ serviceInstanceRedeploy: boolean }>(
        token,
        `mutation StaleQuoteRedeploy($environmentId: String!, $serviceId: String!) {
          serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId)
        }`,
        { environmentId: target.environmentId, serviceId },
      );
      return { method: "serviceInstanceRedeploy", deploymentId: target.latestDeployment.id };
    } catch (error) {
      console.warn("[scalper-watchdog] serviceInstanceRedeploy fallita, provo deploymentRestart", errorText(error));
    }
  }

  await railwayGraphql<{ deploymentRestart: boolean }>(
    token,
    `mutation StaleQuoteRestart($id: String!) { deploymentRestart(id: $id) }`,
    { id: target.latestDeployment.id },
  );
  return { method: "deploymentRestart", deploymentId: target.latestDeployment.id };
}

async function main() {
  await ensureSchema();
  const settings = await getSettings([
    "stream_worker_heartbeat",
    "stream_worker_status",
    "system_stop",
    "stream_last_error",
    "stream_worker_detail",
    "stream_last_quote",
    ALERT_SETTING_KEY,
    STALE_QUOTE_ALERT_SETTING_KEY,
  ]);

  if (settings.get("system_stop") === "true") {
    console.log("[scalper-watchdog] system_stop attivo: nessuna azione");
    return;
  }

  const maxAgeSec = envInt("WATCHDOG_MAX_AGE_SEC", 180, 30);
  const closeAfterSec = envInt("WATCHDOG_CLOSE_AFTER_SEC", 600, 60);
  const nowMs = Date.now();
  const sessionStatus = getSessionStatus(new Date(nowMs), sessionConfigFromEnv());
  const sessionStartAtMs = sessionStatus.sessionStartAt ? Date.parse(sessionStatus.sessionStartAt) : Number.NaN;
  const sessionAgeSec = Number.isFinite(sessionStartAtMs)
    ? Math.max(0, Math.floor((nowMs - sessionStartAtMs) / 1000))
    : null;
  const heartbeat = parseWorkerHeartbeat(settings.get("stream_worker_heartbeat"));
  const detail = parsedObject(settings.get("stream_worker_detail"));
  const detailAgeRaw = Number(detail?.quoteAgeSec);
  const detailAgeSec = Number.isFinite(detailAgeRaw) && detailAgeRaw >= 0
    ? sessionAgeSec === null ? Math.floor(detailAgeRaw) : Math.min(Math.floor(detailAgeRaw), sessionAgeSec)
    : null;
  const lastQuote = parsedObject(settings.get("stream_last_quote"));
  const receivedAtMs = lastQuote?.receivedAt ? Date.parse(String(lastQuote.receivedAt)) : Number.NaN;
  const storedAgeSec = effectiveQuoteAgeSec(
    nowMs,
    Number.isFinite(receivedAtMs) ? receivedAtMs : null,
    Number.isFinite(sessionStartAtMs) ? sessionStartAtMs : null,
    Number.isFinite(sessionStartAtMs) ? sessionStartAtMs : nowMs,
  );
  const heartbeatQuoteAgeSec = heartbeat.quoteAgeSec === null
    ? null
    : sessionAgeSec === null ? heartbeat.quoteAgeSec : Math.min(heartbeat.quoteAgeSec, sessionAgeSec);
  const quoteAges = [heartbeatQuoteAgeSec, detailAgeSec, storedAgeSec].filter((value): value is number => value !== null);
  const quoteAgeSec = quoteAges.length > 0 ? Math.max(...quoteAges) : null;

  if (sessionStatus.inside && quoteAgeSec !== null && quoteAgeSec > STALE_QUOTE_SEC) {
    console.warn("[scalper-watchdog] quote ferme", { quoteAgeSec, thresholdSec: STALE_QUOTE_SEC });
    const alerted = await alertThrottled(
      `🚨 SCALPER ${symbol()} · quote MetaApi ferme da ${quoteAgeSec} s (soglia ${STALE_QUOTE_SEC} s)`,
      settings.get(STALE_QUOTE_ALERT_SETTING_KEY),
      STALE_QUOTE_ALERT_SETTING_KEY,
      STALE_QUOTE_ALERT_INTERVAL_MS,
    );
    const railwayToken = process.env.RAILWAY_API_TOKEN?.trim();
    const currentRailwayServiceId = process.env.RAILWAY_SERVICE_ID?.trim();
    const currentRailwayServiceName = process.env.RAILWAY_SERVICE_NAME?.trim();
    const railwayWorkerServiceId = process.env.SCALPER_WORKER_SERVICE_ID?.trim()
      || (currentRailwayServiceName === "scalper-worker" ? currentRailwayServiceId : undefined);
    if (alerted && railwayToken && railwayWorkerServiceId) {
      try {
        const restart = await restartRailwayService(railwayToken, railwayWorkerServiceId);
        console.warn("[scalper-watchdog] railway_restart", restart);
      } catch (error) {
        const message = `Railway restart fallito: ${errorText(error)}`;
        console.error("[scalper-watchdog]", message);
        await setSetting("stream_last_error", `${new Date().toISOString()} ${message}`).catch(() => undefined);
      }
    }
  }

  const heartbeatMs = heartbeat.atMs ?? Number.NaN;
  const ageSec = heartbeat.atMs !== null ? Math.max(0, Math.floor((Date.now() - heartbeat.atMs) / 1000)) : null;

  if (ageSec !== null && ageSec <= maxAgeSec) {
    console.log("[scalper-watchdog] worker vivo", { ageSec });
    return;
  }

  const status = settings.get("stream_worker_status") ?? "not_started";
  const lastError = settings.get("stream_last_error") ?? "";
  const ageLabel = ageSec === null ? "mai visto" : `${ageSec} s fa`;
  console.warn("[scalper-watchdog] worker non risponde", { ageSec, status });

  await alertThrottled(
    `\u{1f6a8} SCALPER ${symbol()} · worker non risponde`
    + `\nultimo heartbeat: ${ageLabel} (max ${maxAgeSec} s) · stato ${status}`
    + `${lastError ? `\nultimo errore: ${lastError}` : ""}`,
    settings.get(ALERT_SETTING_KEY),
  );

  let positions: WatchdogPosition[] = [];
  try {
    positions = (await watchdogPositions()).filter((position) => position.symbol === symbol());
  } catch (error) {
    console.error("[scalper-watchdog] lettura posizioni fallita", errorText(error));
    await sendTelegram(`⚠️ SCALPER ${symbol()} · watchdog non riesce a leggere le posizioni: ${errorText(error)}`);
    return;
  }

  if (positions.length === 0) {
    console.log("[scalper-watchdog] nessuna posizione aperta");
    return;
  }

  const sessionReason = sessionForcesClose();
  const deadTooLong = ageSec === null || ageSec > closeAfterSec;
  if (!deadTooLong && !sessionReason) {
    console.log("[scalper-watchdog] posizioni aperte ma sotto soglia di chiusura", { ageSec, closeAfterSec });
    return;
  }

  const reason = sessionReason ? "end_of_session" : "system_stop";
  const trigger = sessionReason ?? `worker morto da ${ageSec ?? "?"} s (> ${closeAfterSec} s)`;
  const closed: string[] = [];
  const failures: string[] = [];
  const details: string[] = [];

  for (const position of positions) {
    try {
      await watchdogClosePosition(position.id);
      closed.push(position.id);
    } catch (error) {
      failures.push(`${position.id}: ${errorText(error)}`);
    }
  }

  for (const position of positions.filter((item) => closed.includes(item.id))) {
    try {
      const recorded = await recordClosure(position, reason);
      details.push(`${positionDirection(position) ?? "?"} ${money(position.volume)} lotti → ${recorded.outcome} ${money(recorded.profit)}`);
    } catch (error) {
      failures.push(`registrazione ${position.id}: ${errorText(error)}`);
    }
  }

  await setSetting("stream_last_flatten", JSON.stringify({
    at: new Date().toISOString(),
    closed,
    canceled: [],
    reason: `watchdog:${reason}`,
    failures,
  }));

  await sendTelegram(
    `\u{1f6d1} SCALPER ${symbol()} · watchdog ha chiuso le posizioni`
    + `\nmotivo: ${trigger}`
    + `\nchiuse ${closed.length}/${positions.length}`
    + `${details.length > 0 ? `\n${details.join("\n")}` : ""}`
    + `${failures.length > 0 ? `\nerrori: ${failures.join(" | ")}` : ""}`,
  );
}

main()
  .catch((error) => {
    console.error("[scalper-watchdog]", errorText(error));
  })
  .finally(() => {
    // Cron job: sempre exit 0, anche in errore, per non marcare il run come fallito.
    process.exit(0);
  });

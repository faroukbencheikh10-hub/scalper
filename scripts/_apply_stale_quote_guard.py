from pathlib import Path
import json
import subprocess


def replace_once(path: str, old: str, new: str):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))


Path("src/lib/server/staleQuoteGuard.ts").write_text('''export type StaleQuoteAction = "idle" | "reconnect" | "exit";

export type StaleQuoteDecisionInput = {
  active: boolean;
  nowMs: number;
  lastQuoteReceivedAtMs: number | null;
  sessionStartAtMs: number | null;
  fallbackStartAtMs: number;
  staleQuoteSec: number;
  staleQuoteExitSec: number;
};

function finiteMs(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function effectiveQuoteAgeSec(
  nowMs: number,
  lastQuoteReceivedAtMs: number | null,
  sessionStartAtMs: number | null,
  fallbackStartAtMs: number,
) {
  const refs = [
    finiteMs(lastQuoteReceivedAtMs),
    finiteMs(sessionStartAtMs),
    finiteMs(fallbackStartAtMs),
  ].filter((value): value is number => value !== null);
  if (refs.length === 0) return null;
  return Math.max(0, Math.floor((nowMs - Math.max(...refs)) / 1000));
}

export function staleQuoteDecision(input: StaleQuoteDecisionInput): {
  action: StaleQuoteAction;
  quoteAgeSec: number | null;
} {
  if (!input.active) return { action: "idle", quoteAgeSec: null };
  const quoteAgeSec = effectiveQuoteAgeSec(
    input.nowMs,
    input.lastQuoteReceivedAtMs,
    input.sessionStartAtMs,
    input.fallbackStartAtMs,
  );
  if (quoteAgeSec === null) return { action: "idle", quoteAgeSec: null };
  if (quoteAgeSec > input.staleQuoteExitSec) return { action: "exit", quoteAgeSec };
  if (quoteAgeSec > input.staleQuoteSec) return { action: "reconnect", quoteAgeSec };
  return { action: "idle", quoteAgeSec };
}
''')

# worker/streaming.ts: transport health only, no strategy edits.
replace_once(
    "worker/streaming.ts",
    'import { riskPerLot } from "../src/lib/server/orderSafety";\n',
    'import { riskPerLot } from "../src/lib/server/orderSafety";\nimport { staleQuoteDecision } from "../src/lib/server/staleQuoteGuard";\n',
)
replace_once(
    "worker/streaming.ts",
    '  const finalQuoteMaxAgeMs = envInt("SCALPER_FINAL_QUOTE_MAX_AGE_MS", 2000, 250, 10_000);\n  const sessionConfig = sessionConfigFromEnv();\n',
    '  const finalQuoteMaxAgeMs = envInt("SCALPER_FINAL_QUOTE_MAX_AGE_MS", 2000, 250, 10_000);\n  const staleQuoteSec = envInt("STALE_QUOTE_SEC", 120, 30, 3600);\n  const staleQuoteExitSec = Math.max(staleQuoteSec + 30, envInt("STALE_QUOTE_EXIT_SEC", 300, 60, 7200));\n  const sessionConfig = sessionConfigFromEnv();\n  const workerStartedAtMs = Date.now();\n',
)
replace_once(
    "worker/streaming.ts",
    '  const connection = account.getStreamingConnection();\n  const tradingConnection = connection as unknown as FlattenConnection;\n',
    '  let connection = account.getStreamingConnection();\n  let tradingConnection = connection as unknown as FlattenConnection;\n',
)
replace_once(
    "worker/streaming.ts",
    '  let latestQuote: Quote | null = null;\n  let latestDecision: Record<string, unknown> | null = null;\n',
    '  let latestQuote: Quote | null = null;\n  let lastQuoteReceivedAtMs = 0;\n  let quoteWatchStartedAtMs = workerStartedAtMs;\n  let latestDecision: Record<string, unknown> | null = null;\n',
)
replace_once(
    "worker/streaming.ts",
    '  let decisionPersistBusy = false;\n  let flattenBusy = false;\n',
    '  let decisionPersistBusy = false;\n  let flattenBusy = false;\n  let staleReconnectBusy = false;\n  let staleExitBusy = false;\n',
)
replace_once(
    "worker/streaming.ts",
    '    finalQuoteMaxAgeMs,\n    ...lossGuards(),\n',
    '    finalQuoteMaxAgeMs,\n    quoteAgeSec: Math.max(0, Math.floor((Date.now() - (lastQuoteReceivedAtMs || quoteWatchStartedAtMs)) / 1000)),\n    quoteReceivedAt: lastQuoteReceivedAtMs > 0 ? new Date(lastQuoteReceivedAtMs).toISOString() : null,\n    staleQuoteSec,\n    staleQuoteExitSec,\n    ...lossGuards(),\n',
)
replace_once(
    "worker/streaming.ts",
    '    if (quote.quotedAt! > Date.now() + 500 || Date.now() - quote.quotedAt! > finalQuoteMaxAgeMs\n      || (latestQuote?.quotedAt && quote.quotedAt! < latestQuote.quotedAt)) return;\n    const previousQuoteAt = latestQuote?.quotedAt ?? 0;\n',
    '    if (quote.quotedAt! > Date.now() + 500 || Date.now() - quote.quotedAt! > finalQuoteMaxAgeMs\n      || (latestQuote?.quotedAt && quote.quotedAt! < latestQuote.quotedAt)) return;\n    lastQuoteReceivedAtMs = Date.now();\n    const previousQuoteAt = latestQuote?.quotedAt ?? 0;\n',
)
replace_once(
    "worker/streaming.ts",
    '''  const subscribe = async () => {
    ready = false;
    const seeded = await seedCandles(m1Max, m5Max);
    m1 = seeded.m1;
    m5 = seeded.m5;
    await connection.subscribeToMarketData(symbol(), marketDataSubscriptions);
    subscribed = true;
    ready = true;
    await markWorker("streaming", workerDetail());
  };

  void sendTelegram(
''',
    '''  const subscribe = async (resetQuoteWatch = true) => {
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
''',
)
replace_once(
    "worker/streaming.ts",
    '''  if (!stopped) {
    await subscribe();
  } else {
    await flattenSymbol("system_stop", "startup-system-stop").catch(() => undefined);
    await markWorker("paused", { ...workerDetail(), reason: "STOP TUTTO" });
  }

  const controlTimer = setInterval(() => {
''',
    '''  if (!stopped) {
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
          + `\nnessuna quote valida da ${decision.quoteAgeSec ?? "?"} s`,
        ).catch((error) => console.error(error));
      })().finally(() => process.exit(1));
      return;
    }
    if (decision.action === "reconnect" && !staleReconnectBusy) {
      void reconnectStaleQuotes(decision.quoteAgeSec);
    }
  }, 30_000);

  const controlTimer = setInterval(() => {
''',
)
replace_once(
    "worker/streaming.ts",
    '    void setSetting("stream_last_quote", JSON.stringify({ ...snapshot, receivedAt: new Date().toISOString() }))\n',
    '    const receivedAt = lastQuoteReceivedAtMs > 0 ? new Date(lastQuoteReceivedAtMs).toISOString() : null;\n    void setSetting("stream_last_quote", JSON.stringify({ ...snapshot, receivedAt }))\n',
)
replace_once(
    "worker/streaming.ts",
    '    clearInterval(controlTimer);\n    clearInterval(sessionTimer);\n',
    '    clearInterval(staleQuoteTimer);\n    clearInterval(controlTimer);\n    clearInterval(sessionTimer);\n',
)

# watchdog.ts: quote-health safety before the existing healthy-heartbeat early return.
replace_once(
    "worker/watchdog.ts",
    'import { watchdogClosePosition, watchdogPositions, type WatchdogPosition } from "../src/lib/server/watchdogMetaApi";\n',
    'import { watchdogClosePosition, watchdogPositions, type WatchdogPosition } from "../src/lib/server/watchdogMetaApi";\nimport { effectiveQuoteAgeSec } from "../src/lib/server/staleQuoteGuard";\n',
)
replace_once(
    "worker/watchdog.ts",
    'const ALERT_INTERVAL_MS = 30 * 60_000;\nconst SESSION_END_GUARD_MIN = 15;\nconst ALERT_SETTING_KEY = "watchdog_last_alert";\n',
    'const ALERT_INTERVAL_MS = 30 * 60_000;\nconst STALE_QUOTE_ALERT_INTERVAL_MS = 10 * 60_000;\nconst STALE_QUOTE_SEC = 180;\nconst SESSION_END_GUARD_MIN = 15;\nconst ALERT_SETTING_KEY = "watchdog_last_alert";\nconst STALE_QUOTE_ALERT_SETTING_KEY = "watchdog_last_stale_quote_alert";\nconst RAILWAY_API_URL = "https://backboard.railway.com/graphql/v2";\n',
)
replace_once(
    "worker/watchdog.ts",
    '''async function alertThrottled(text: string, lastAlert: string | undefined) {
  const previous = lastAlert ? Date.parse(lastAlert) : Number.NaN;
  if (Number.isFinite(previous) && Date.now() - previous < ALERT_INTERVAL_MS) return false;
  await setSetting(ALERT_SETTING_KEY, new Date().toISOString());
  await sendTelegram(text);
  return true;
}

async function main() {
''',
    '''async function alertThrottled(
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
''',
)
replace_once(
    "worker/watchdog.ts",
    '    "stream_last_error",\n    ALERT_SETTING_KEY,\n',
    '    "stream_last_error",\n    "stream_worker_detail",\n    "stream_last_quote",\n    ALERT_SETTING_KEY,\n    STALE_QUOTE_ALERT_SETTING_KEY,\n',
)
replace_once(
    "worker/watchdog.ts",
    '''  const maxAgeSec = envInt("WATCHDOG_MAX_AGE_SEC", 180, 30);
  const closeAfterSec = envInt("WATCHDOG_CLOSE_AFTER_SEC", 600, 60);
  const heartbeat = settings.get("stream_worker_heartbeat");
''',
    '''  const maxAgeSec = envInt("WATCHDOG_MAX_AGE_SEC", 180, 30);
  const closeAfterSec = envInt("WATCHDOG_CLOSE_AFTER_SEC", 600, 60);
  const nowMs = Date.now();
  const sessionStatus = getSessionStatus(new Date(nowMs), sessionConfigFromEnv());
  const sessionStartAtMs = sessionStatus.sessionStartAt ? Date.parse(sessionStatus.sessionStartAt) : Number.NaN;
  const sessionAgeSec = Number.isFinite(sessionStartAtMs)
    ? Math.max(0, Math.floor((nowMs - sessionStartAtMs) / 1000))
    : null;
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
  const quoteAges = [detailAgeSec, storedAgeSec].filter((value): value is number => value !== null);
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
    const railwayServiceId = process.env.RAILWAY_SERVICE_ID?.trim();
    if (alerted && railwayToken && railwayServiceId) {
      try {
        const restart = await restartRailwayService(railwayToken, railwayServiceId);
        console.warn("[scalper-watchdog] railway_restart", restart);
      } catch (error) {
        const message = `Railway restart fallito: ${errorText(error)}`;
        console.error("[scalper-watchdog]", message);
        await setSetting("stream_last_error", `${new Date().toISOString()} ${message}`).catch(() => undefined);
      }
    }
  }

  const heartbeat = settings.get("stream_worker_heartbeat");
''',
)

Path("scripts/stale-quote-scenarios.ts").write_text('''import assert from "node:assert/strict";
import { staleQuoteDecision } from "../src/lib/server/staleQuoteGuard";

let passed = 0;
function check(name: string, test: () => void) {
  try { test(); passed += 1; console.log("OK " + name); }
  catch (error) { console.error("FAIL " + name); throw error; }
}

const start = Date.UTC(2026, 8, 10, 6, 30, 0);
const decide = (seconds: number, overrides: Partial<Parameters<typeof staleQuoteDecision>[0]> = {}) =>
  staleQuoteDecision({
    active: true,
    nowMs: start + seconds * 1000,
    lastQuoteReceivedAtMs: start,
    sessionStartAtMs: start,
    fallbackStartAtMs: start,
    staleQuoteSec: 120,
    staleQuoteExitSec: 300,
    ...overrides,
  });

check("quote ferma -> reconnect -> exit", () => {
  assert.equal(decide(120).action, "idle");
  assert.deepEqual(decide(121), { action: "reconnect", quoteAgeSec: 121 });
  assert.equal(decide(299).action, "reconnect");
  assert.deepEqual(decide(301), { action: "exit", quoteAgeSec: 301 });
});
check("nuova quote azzera il silenzio", () => {
  assert.deepEqual(decide(301, { lastQuoteReceivedAtMs: start + 250_000 }), { action: "idle", quoteAgeSec: 51 });
});
check("fuori fascia nessuna azione", () => {
  assert.deepEqual(decide(900, { active: false }), { action: "idle", quoteAgeSec: null });
});
check("riapertura non eredita silenzio overnight", () => {
  const oldQuote = start - 10 * 60 * 60_000;
  assert.equal(decide(120, { lastQuoteReceivedAtMs: oldQuote }).action, "idle");
  assert.equal(decide(121, { lastQuoteReceivedAtMs: oldQuote }).action, "reconnect");
});
console.log(`Stale quote scenarios passed: ${passed}`);
''')

package = json.loads(Path("package.json").read_text())
package["scripts"]["scenarios"] = "tsx scripts/strategy-scenarios.ts && tsx scripts/stale-quote-scenarios.ts"
Path("package.json").write_text(json.dumps(package, indent=2, ensure_ascii=False) + "\n")

readme = Path("README.md")
text = readme.read_text()
if "## Auto-riparazione quote MetaApi" in text:
    raise SystemExit("README stale quote section already exists")
text += '''

## Auto-riparazione quote MetaApi

Il worker controlla la salute delle quote ogni 30 secondi solo dentro `SCALPER_HOURS_UTC`. Il silenzio normale fuori fascia o nel weekend non conta; alla riapertura il conteggio riparte dalla sessione corrente. Se una quote valida non arriva entro la prima soglia, il worker chiude la vecchia streaming connection MetaApi, ne crea una nuova, rifà `waitSynchronized()` e risottoscrive XAUUSD. Se il flusso non torna entro la soglia di uscita, salva `stream_worker_status=stale_exit`, invia Telegram con `worker riavviato per quote ferme` ed esce con codice 1, così Railway con restart policy `ALWAYS` può avviare un processo pulito.

Environment del recovery:

- `STALE_QUOTE_SEC` — secondi senza quote prima del reconnect; default `120`.
- `STALE_QUOTE_EXIT_SEC` — secondi senza quote prima di `process.exit(1)`; default `300`. Per sicurezza resta almeno 30 secondi sopra la soglia reconnect.
- `RAILWAY_API_TOKEN` — opzionale e server-only; il watchdog lo usa per il riavvio via Railway GraphQL. Se manca, manda solo l'alert Telegram.
- `RAILWAY_SERVICE_ID` — ID del servizio Railway da riavviare (`scalper-worker`). Il watchdog risolve l'environment del servizio, prova `serviceInstanceRedeploy` e usa `deploymentRestart` come fallback.

`stream_worker_detail` include `quoteAgeSec` e `quoteReceivedAt`. `stream_last_quote.receivedAt` è il timestamp reale dell'ultima quote valida ricevuta e non viene più avanzato artificialmente dal timer di persistenza. In fascia il watchdog considera quote stale oltre 180 secondi, limita il relativo alert Telegram a uno ogni 10 minuti e prova il restart Railway solo se entrambe le variabili Railway sono presenti.
'''
readme.write_text(text)

changed = set(subprocess.check_output(["git", "diff", "--name-only"], text=True).splitlines())
allowed = {
    "worker/streaming.ts",
    "worker/watchdog.ts",
    "src/lib/server/staleQuoteGuard.ts",
    "scripts/stale-quote-scenarios.ts",
    "package.json",
    "README.md",
}
if not changed <= allowed:
    raise SystemExit(f"unexpected files: {sorted(changed - allowed)}")
if "src/lib/server/scalperStrategy.ts" in changed:
    raise SystemExit("strategy changed unexpectedly")
print("Changed:", sorted(changed))

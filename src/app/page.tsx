"use client";

import { useCallback, useEffect, useState } from "react";
import { SystemControl } from "@/components/system-control";
import { setupLabel } from "@/lib/setups";

type OperationalState = "LIVE" | "WAITING" | "STOP" | "OFFLINE";
type Quote = { bid?: number; ask?: number; mid?: number; spread?: number; quotedAt?: number | string | null; receivedAt?: string | null };
type SetupEvaluation = { setup?: string; status?: string; direction?: string | null; reason?: string };
type RiskPlan = { lots?: number; requestedLots?: number; lotsCapped?: boolean; slDistance?: number; tpDistance?: number; riskReward?: number | null; risk?: number; riskPct?: number | null; riskMaxPct?: number; currency?: string | null; overCap?: boolean };
type Decision = { at?: string; direction?: string; setup?: string | null; reasoning?: string; evaluations?: SetupEvaluation[]; risk?: RiskPlan | null };
type StreamError = { message: string; at: string | null };
type Flatten = { at?: string; closed?: string[]; canceled?: string[]; reason?: string; failures?: string[] };
type Signal = { direction?: string; setup?: string | null; reasoning?: string; mt5_position_id?: string | null; entry?: number | string | null; stop_loss?: number | string | null };
type Account = { balance?: number | null; equity?: number | null; margin?: number | null; freeMargin?: number | null; leverage?: number | null; currency?: string | null };
type ResultItem = { outcome?: string; setup?: string | null; mt5_profit?: number | string | null; result_r?: number | string | null };

type DashboardState = {
  ok: boolean;
  error?: string;
  systemStopped: boolean;
  operational?: { state?: OperationalState; heartbeatFresh?: boolean; heartbeatAgeSeconds?: number | null };
  session?: {
    hoursUtc?: string;
    inside?: boolean;
    weekendClosed?: boolean;
    inFlattenWindow?: boolean;
    minutesUntilEnd?: number | null;
    sessionEndAt?: string | null;
    nextStartAt?: string | null;
    nextFlattenAt?: string | null;
    flattenBeforeEndMin?: number;
    fridayCloseUtc?: string;
    blockReason?: string | null;
  };
  quote?: Quote | null;
  autoExec?: boolean | null;
  lots?: number;
  lotsMin?: number;
  lotsMax?: number;
  lotChoices?: number[];
  account?: Account | null;
  stream?: {
    status?: string;
    heartbeat?: string | null;
    detail?: { symbol?: string; mode?: string; autoExec?: boolean; lots?: number; account?: Account | null; maxOpenPositions?: number; lossLockedDirections?: string[]; lossLockUntil?: Record<string, string>; lossPauseUntil?: string | null; lossLockMinutes?: number; consecLossPauseMinutes?: number; m1?: number; m5?: number } | null;
    lastDecision?: Decision | null;
    lastFlatten?: Flatten | null;
    currentError?: StreamError | null;
    historicalError?: StreamError | null;
  };
  results?: { total?: number; wins?: number; losses?: number; breakeven?: number; winRate?: number; profit?: number; resultR?: number; last?: ResultItem | null };
  signals?: Signal[];
};

const palette: Record<OperationalState, { color: string; background: string; border: string; label: string }> = {
  LIVE: { color: "#8fffc5", background: "rgba(39,145,101,.15)", border: "rgba(96,247,170,.55)", label: "LIVE" },
  WAITING: { color: "#ffe98d", background: "rgba(151,119,21,.18)", border: "rgba(255,228,107,.56)", label: "IN ATTESA" },
  STOP: { color: "#ffc18c", background: "rgba(160,82,22,.17)", border: "rgba(255,155,74,.58)", label: "STOP" },
  OFFLINE: { color: "#ff9db1", background: "rgba(160,41,75,.14)", border: "rgba(255,95,121,.52)", label: "OFFLINE" },
};

function formatTime(value: number | string | null | undefined, timeZone = "Europe/Paris") {
  if (value === null || value === undefined) return "—";
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return "—";
  return new Intl.DateTimeFormat("it-IT", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(parsed));
}

function formatHourMinute(value: number | string | null | undefined, timeZone = "UTC") {
  if (value === null || value === undefined) return "—";
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return "—";
  return new Intl.DateTimeFormat("it-IT", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(parsed));
}

function heartbeatText(heartbeat: string | null | undefined, now: number) {
  if (!heartbeat) return "mai";
  const at = Date.parse(heartbeat);
  if (!Number.isFinite(at)) return "non valido";
  return `${Math.max(0, Math.floor((now - at) / 1000))} s fa`;
}

function countdown(value: string | null | undefined, now: number) {
  if (!value) return "—";
  const target = Date.parse(value);
  if (!Number.isFinite(target)) return "—";
  const total = Math.max(0, Math.floor((target - now) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function money(value: number | undefined) {
  return Number.isFinite(value) ? value!.toFixed(2) : "—";
}

function shorten(value: string | undefined | null, max = 180) {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function currentState(data: DashboardState | null, now: number): OperationalState {
  if (!data) return "OFFLINE";
  if (data.systemStopped) return "STOP";
  const heartbeatMs = data.stream?.heartbeat ? Date.parse(data.stream.heartbeat) : Number.NaN;
  if (!Number.isFinite(heartbeatMs) || now - heartbeatMs >= 60_000) return "OFFLINE";
  if (!data.session?.inside || data.session?.inFlattenWindow) return "WAITING";
  return "LIVE";
}

export default function Home() {
  const [data, setData] = useState<DashboardState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pollError, setPollError] = useState<string | null>(null);

  const refreshState = useCallback(async () => {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      const payload = await response.json() as DashboardState;
      if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setData(payload);
      setPollError(null);
    } catch (error) {
      setPollError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refreshState();
    const polling = window.setInterval(() => void refreshState(), 5_000);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { window.clearInterval(polling); window.clearInterval(clock); };
  }, [refreshState]);

  const status = currentState(data, now);
  const style = palette[status];
  const quote = data?.quote;
  const decision = data?.stream?.lastDecision;
  const last = data?.signals?.[0];
  const direction = decision?.direction ?? last?.direction ?? "NO_TRADE";
  const decisionSetup = decision?.setup ?? null;
  const evaluations = decision?.evaluations ?? [];
  const lossLocked = data?.stream?.detail?.lossLockedDirections ?? [];
  const lossLockUntil = data?.stream?.detail?.lossLockUntil ?? {};
  const lossPauseUntil = data?.stream?.detail?.lossPauseUntil ?? null;
  const lossLockText = lossLocked.length > 0
    ? lossLocked.map((item) => `${item} fino ${formatHourMinute(lossLockUntil[item], "UTC")} UTC`).join(" · ")
    : "nessuno";
  const lossPauseText = lossPauseUntil ? `fino ${formatHourMinute(lossPauseUntil, "UTC")} UTC` : "no";
  const risk = decision?.risk ?? null;
  const riskText = risk && Number.isFinite(risk.risk)
    ? `${money(Number(risk.risk))} ${risk.currency ?? "EUR"}${Number.isFinite(risk.riskPct) ? ` · ${money(Number(risk.riskPct))}% del saldo` : ""}${risk.lotsCapped ? ` · lotti ridotti a ${risk.lots}` : ""}`
    : "—";
  const slTpText = risk && Number.isFinite(risk.slDistance)
    ? `SL ${money(Number(risk.slDistance))}$ · TP ${money(Number(risk.tpDistance))}$${Number.isFinite(risk.riskReward) ? ` (${risk.riskReward}R)` : ""}`
    : "—";
  const livePrice = Number.isFinite(quote?.mid) ? Number(quote?.mid).toFixed(2) : "—";
  const results = data?.results;
  const lastResult = results?.last;
  const totalProfit = Number(results?.profit ?? 0);
  const totalR = Number(results?.resultR ?? 0);
  const lastProfit = Number(lastResult?.mt5_profit ?? 0);
  const lastR = Number(lastResult?.result_r ?? 0);
  const account = data?.account ?? data?.stream?.detail?.account ?? null;
  const flatten = data?.stream?.lastFlatten;
  const nextFlatten = data?.session?.nextFlattenAt;

  const statusDescription = !data
    ? "Caricamento stato…"
    : status === "LIVE"
      ? "Heartbeat fresco · fascia operativa aperta · nuove entrate consentite."
      : status === "STOP"
        ? "STOP TUTTO attivo: il worker chiude le posizioni XAUUSD e blocca nuove aperture."
        : status === "OFFLINE"
          ? "Heartbeat assente o più vecchio di 60 secondi."
          : data.session?.weekendClosed
            ? "Mercato chiuso (weekend). Nessuna nuova apertura fino alla riapertura."
            : data.session?.inFlattenWindow
              ? `${data.session.blockReason ?? "Chiusura sessione imminente"}. Nuove aperture bloccate e posizioni portate a zero.`
              : `${data.session?.blockReason ?? "Fuori fascia operativa"}. Ripartenza ${formatHourMinute(data.session?.nextStartAt, "UTC")} UTC.`;

  return (
    <main>
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />

      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span>S</span></div>
          <div className="brand-copy"><strong>SCALPER</strong><span>XAUUSD · STREAMING CONTROL CENTER</span></div>
        </div>
        <div className="quote-panel">
          <span className="quote-label">{status === "LIVE" ? "● XAUUSD / LIVE" : "XAUUSD / ULTIMA QUOTE"}</span>
          <div className="price">{livePrice}<small>USD</small></div>
          <span style={{ display: "block", marginTop: 7, color: "#9aa7c7", font: "650 10px ui-monospace, monospace" }}>
            BID {money(quote?.bid)} · ASK {money(quote?.ask)} · SPR {money(quote?.spread)} · {formatTime(quote?.receivedAt ?? quote?.quotedAt)}
          </span>
        </div>
      </header>

      <section className={`status-shell ${status === "LIVE" ? "is-running" : status === "STOP" ? "is-stopped" : ""}`} style={{ borderColor: style.border }}>
        <div className="status-copy">
          <div className="status-kicker" style={{ color: style.color }}><span className="status-dot" aria-hidden="true" style={{ animation: status === "LIVE" ? undefined : "none" }} />{status === "WAITING" ? "IN ATTESA / SESSION GUARD" : status}</div>
          <h1>{status === "LIVE" ? "Scalper LIVE" : status === "WAITING" ? "Entrate in attesa" : status === "STOP" ? "Scalper in STOP" : "Worker offline"}</h1>
          <p>{statusDescription}</p>
          <p style={{ marginTop: 8 }}>Ultimo heartbeat <strong style={{ color: style.color }}>{heartbeatText(data?.stream?.heartbeat, now)}</strong>{decision ? <> · Decisione <strong className="signal-direction" data-direction={direction}>{direction}</strong>{decisionSetup ? <> · setup <strong>{setupLabel(decisionSetup)}</strong></> : null} — {shorten(decision.reasoning) || "nessun dettaglio"}</> : null}</p>
        </div>
        <div className="state-badge" style={{ color: style.color, background: style.background, borderColor: style.border }}>{status === "LIVE" ? "● LIVE" : style.label}</div>
      </section>

      {pollError ? <p style={{ margin: "0 0 16px", padding: "10px 14px", border: "1px solid rgba(255,95,121,.4)", borderRadius: 12, color: "#ffb0c0", background: "rgba(120,25,49,.12)" }}>Aggiornamento non riuscito: {pollError}. Riprovo ogni 5 s.</p> : null}

      {data ? (
        <SystemControl
          stopped={data.systemStopped}
          lots={data.lots}
          lotChoices={data.lotChoices}
          price={Number.isFinite(quote?.mid) ? Number(quote?.mid) : null}
          entry={last?.entry === null || last?.entry === undefined ? null : Number(last.entry)}
          stopLoss={last?.stop_loss === null || last?.stop_loss === undefined ? null : Number(last.stop_loss)}
          account={data.account ?? data.stream?.detail?.account ?? null}
          onChanged={(stopped) => setData((current) => current ? { ...current, systemStopped: stopped } : current)}
          onLotsChanged={(lots) => setData((current) => current ? { ...current, lots } : current)}
        />
      ) : null}

      {data?.stream?.currentError ? (
        <article className="rules-card" style={{ marginBottom: 18, borderColor: "rgba(255,95,121,.5)" }}>
          <div className="card-heading rules-heading"><div><span className="card-index">!</span><h3>Errore corrente</h3></div><span style={{ color: "#ff8fa9" }}>{formatTime(data.stream.currentError.at)}</span></div>
          <p>{data.stream.currentError.message}</p>
        </article>
      ) : null}

      <section className="dashboard-head">
        <div><span className="eyebrow">REAL-TIME OPERATIONS · POLLING 5S</span><h2>Control center</h2></div>
        <div className="micro-status">
          <span>M1 {data?.stream?.detail?.m1 ?? "—"}</span><span>M5 {data?.stream?.detail?.m5 ?? "—"}</span>
          <span>{data?.session?.hoursUtc ?? "—"} UTC</span><span>MT5 {data?.autoExec === true ? "AUTO ON" : data?.autoExec === false ? "AUTO OFF" : "—"}</span>
        </div>
      </section>

      <section className="grid" aria-label="Stato operativo">
        <article className="stream-card">
          <div className="card-heading"><div><span className="card-index">01</span><h3>Worker streaming</h3></div><span style={{ color: style.color, font: "800 10px ui-monospace, monospace" }}>{style.label}</span></div>
          <div className="dir" style={{ color: style.color }}>{data?.stream?.status ?? "not_started"}</div>
          <p>Heartbeat e stato letti da <code>scalper_settings</code>.</p>
          <p className="heartbeat">Ultimo heartbeat <span>{heartbeatText(data?.stream?.heartbeat, now)}</span></p>
        </article>

        <article className="signal-card">
          <div className="card-heading"><div><span className="card-index">02</span><h3>Ultima decisione</h3></div><span className="signal-glyph">↗</span></div>
          <div className="dir signal-direction" data-direction={direction}>{direction}</div>
          <p>{decision?.reasoning ?? "In attesa della prima decisione."}</p>
          <p className="heartbeat">Setup usato <span>{setupLabel(decisionSetup)}</span></p>
          <p className="heartbeat">Decisione <span>{formatTime(decision?.at)}</span></p>
        </article>

        <article className="execution-card">
          <div className="card-heading"><div><span className="card-index">03</span><h3>Esecuzione</h3></div><span className="signal-glyph">⚡</span></div>
          <dl className="metrics">
            <div><dt>Auto MT5</dt><dd className={data?.autoExec === true ? "positive" : "negative"}>{data?.autoExec === true ? "ON" : data?.autoExec === false ? "OFF" : "—"}</dd></div>
            <div><dt>Lotti</dt><dd>{Number.isFinite(data?.lots) ? Number(data?.lots).toFixed(2) : "—"}</dd></div>
            <div><dt>Margine libero</dt><dd>{money(Number(account?.freeMargin ?? Number.NaN))}</dd></div>
            <div><dt>Spread</dt><dd>{money(quote?.spread)} $</dd></div>
            <div><dt>Setup ultimo segnale</dt><dd className="mt5-value">{setupLabel(last?.setup)}</dd></div>
            <div><dt>SL / TP ultimo ordine</dt><dd className="mt5-value">{slTpText}</dd></div>
            <div><dt>Rischio ultimo ordine</dt><dd className={`mt5-value${risk?.overCap ? " negative" : ""}`}>{riskText}</dd></div>
            <div><dt>Re-entry bloccato</dt><dd className="mt5-value">{lossLockText}</dd></div>
            <div><dt>Pausa perdite</dt><dd className="mt5-value">{lossPauseText}</dd></div>
            <div><dt>Posizione</dt><dd className="mt5-value">{data?.systemStopped ? "flatten + STOP" : last?.mt5_position_id ? "aperta" : "nessuna"}</dd></div>
          </dl>
        </article>

        <article className="rules-card">
          <div className="card-heading rules-heading"><div><span className="card-index">04</span><h3>Risultati</h3></div><span className="rainbow-label">PERFORMANCE</span></div>
          <dl className="rules">
            <div><dt>Trade chiusi</dt><dd>{results?.total ?? 0}</dd></div><div><dt>WIN</dt><dd className="positive">{results?.wins ?? 0}</dd></div><div><dt>LOSS</dt><dd className="negative">{results?.losses ?? 0}</dd></div><div><dt>Win rate</dt><dd>{Number(results?.winRate ?? 0).toFixed(1)}%</dd></div><div><dt>Profitto totale</dt><dd className={totalProfit > 0 ? "positive" : totalProfit < 0 ? "negative" : ""}>{totalProfit >= 0 ? "+" : ""}{totalProfit.toFixed(2)}</dd></div>
          </dl>
          <p className="heartbeat">Breakeven <span>{results?.breakeven ?? 0}</span> · R totale <span>{totalR >= 0 ? "+" : ""}{totalR.toFixed(2)}R</span> · Ultimo <span>{lastResult ? `${lastResult.outcome} · ${setupLabel(lastResult.setup)} · ${lastProfit >= 0 ? "+" : ""}${lastProfit.toFixed(2)} · ${lastR >= 0 ? "+" : ""}${lastR.toFixed(2)}R` : "—"}</span></p>
        </article>

        <article className="rules-card">
          <div className="card-heading rules-heading"><div><span className="card-index">05</span><h3>Sessione e flatten</h3></div><span className="rainbow-label">RISK CLOSE</span></div>
          <dl className="rules">
            <div><dt>Fascia UTC</dt><dd>{data?.session?.hoursUtc ?? "—"}</dd></div>
            <div><dt>Flatten prima</dt><dd>{data?.session?.flattenBeforeEndMin ?? 5} min</dd></div>
            <div><dt>Friday close max</dt><dd>{data?.session?.fridayCloseUtc ?? "20:30"} UTC</dd></div>
            <div><dt>Prossimo flatten</dt><dd>{nextFlatten ? `${formatHourMinute(nextFlatten, "UTC")} UTC` : "—"}</dd></div>
            <div><dt>Countdown</dt><dd>{countdown(nextFlatten, now)}</dd></div>
          </dl>
          <p className="heartbeat">Chiusura posizioni alle <span>{nextFlatten ? `${formatHourMinute(nextFlatten, "UTC")} UTC (${formatHourMinute(nextFlatten, "Europe/Paris")} Paris)` : "—"}</span></p>
          <p className="heartbeat">Ultimo flatten <span>{flatten?.at ? `${formatTime(flatten.at)} · ${flatten.reason ?? "—"} · chiuse ${(flatten.closed ?? []).length} · pendenti cancellati ${(flatten.canceled ?? []).length}${(flatten.failures ?? []).length ? ` · errori ${flatten.failures!.length}` : ""}` : "mai"}</span></p>
        </article>

        <article className="rules-card">
          <div className="card-heading rules-heading"><div><span className="card-index">06</span><h3>Setup valutati</h3></div><span className="rainbow-label">ULTIMO TICK</span></div>
          {evaluations.length > 0 ? (
            <dl className="rules setups">
              {evaluations.map((item, index) => (
                <div key={`${item.setup ?? "setup"}-${index}`}>
                  <dt>{setupLabel(item.setup)}{item.direction ? ` · ${item.direction}` : ""}</dt>
                  <dd>
                    <span className="setup-status" data-status={item.status === "triggered" ? "triggered" : "rejected"}>
                      {item.status === "triggered" ? "TRIGGER" : "SCARTATO"}
                    </span>
                    {item.reason || "—"}
                  </dd>
                </div>
              ))}
            </dl>
          ) : <p>In attesa del primo tick con valutazione dei setup.</p>}
          <p className="heartbeat">Valutazione <span>{formatTime(decision?.at)}</span></p>
        </article>
      </section>

      {data?.stream?.historicalError ? <details style={{ marginTop: 18, padding: "14px 16px", border: "1px solid rgba(255,255,255,.09)", borderRadius: 14, background: "rgba(255,255,255,.02)", color: "#9aa7c7" }}><summary style={{ cursor: "pointer", fontWeight: 700 }}>Storico errore worker</summary><p>{data.stream.historicalError.at ? `${formatTime(data.stream.historicalError.at)} · ` : ""}{data.stream.historicalError.message}</p></details> : null}
    </main>
  );
}

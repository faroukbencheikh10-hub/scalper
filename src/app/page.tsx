"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SystemControl } from "@/components/system-control";

type OperationalState = "LIVE" | "WAITING" | "STOP" | "OFFLINE";

type Quote = {
  bid?: number;
  ask?: number;
  mid?: number;
  spread?: number;
  quotedAt?: number | string | null;
  receivedAt?: string | null;
};

type Decision = {
  at?: string;
  direction?: string;
  setup?: string | null;
  reasoning?: string;
};

type StreamError = {
  message: string;
  at: string | null;
};

type Signal = {
  direction?: string;
  reasoning?: string;
  mt5_position_id?: string | null;
};

type ResultItem = {
  outcome?: string;
  mt5_profit?: number | string | null;
  result_r?: number | string | null;
};

type DashboardState = {
  ok: boolean;
  error?: string;
  serverTime?: string;
  systemStopped: boolean;
  operational?: {
    state?: OperationalState;
    heartbeatFresh?: boolean;
    heartbeatAgeSeconds?: number | null;
  };
  session?: {
    hoursUtc?: string;
    inside?: boolean;
    nextStartAt?: string | null;
  };
  quote?: Quote | null;
  autoExec?: boolean | null;
  lots?: number;
  stream?: {
    status?: string;
    heartbeat?: string | null;
    detail?: {
      symbol?: string;
      mode?: string;
      autoExec?: boolean;
      m1?: number;
      m5?: number;
    } | null;
    lastDecision?: Decision | null;
    currentError?: StreamError | null;
    historicalError?: StreamError | null;
  };
  results?: {
    total?: number;
    wins?: number;
    losses?: number;
    breakeven?: number;
    winRate?: number;
    profit?: number;
    resultR?: number;
    last?: ResultItem | null;
  };
  signals?: Signal[];
};

const palette: Record<OperationalState, { color: string; background: string; border: string; label: string }> = {
  LIVE: { color: "#8fffc5", background: "rgba(39,145,101,.15)", border: "rgba(96,247,170,.55)", label: "LIVE" },
  WAITING: { color: "#ffe98d", background: "rgba(151,119,21,.18)", border: "rgba(255,228,107,.56)", label: "IN ATTESA" },
  STOP: { color: "#ffc18c", background: "rgba(160,82,22,.17)", border: "rgba(255,155,74,.58)", label: "STOP" },
  OFFLINE: { color: "#ff9db1", background: "rgba(160,41,75,.14)", border: "rgba(255,95,121,.52)", label: "OFFLINE" },
};

function parseMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function parseHours(raw?: string) {
  if (!raw) return null;
  const [from, to] = raw.split("-").map((value) => value.trim());
  if (!from || !to) return null;
  const start = parseMinutes(from);
  const end = parseMinutes(to);
  if (start === null || end === null) return null;
  return { from, to, start, end };
}

function isInsideHours(nowMs: number, raw?: string) {
  const hours = parseHours(raw);
  if (!hours || hours.start === hours.end) return true;
  const now = new Date(nowMs);
  const current = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (hours.start < hours.end) return current >= hours.start && current < hours.end;
  return current >= hours.start || current < hours.end;
}

function nextStartMs(nowMs: number, raw?: string) {
  const hours = parseHours(raw);
  if (!hours || hours.start === hours.end || isInsideHours(nowMs, raw)) return null;
  const now = new Date(nowMs);
  const current = now.getUTCHours() * 60 + now.getUTCMinutes();
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCHours(Math.floor(hours.start / 60), hours.start % 60, 0, 0);
  if (hours.start < hours.end) {
    if (current >= hours.end) next.setUTCDate(next.getUTCDate() + 1);
  } else if (current >= hours.start) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime();
}

function effectiveState(data: DashboardState, nowMs: number): OperationalState {
  if (data.systemStopped) return "STOP";
  const heartbeatMs = data.stream?.heartbeat ? Date.parse(data.stream.heartbeat) : Number.NaN;
  const fresh = Number.isFinite(heartbeatMs) && Math.max(0, nowMs - heartbeatMs) < 60_000;
  if (!fresh) return "OFFLINE";
  if (!isInsideHours(nowMs, data.session?.hoursUtc)) return "WAITING";
  return "LIVE";
}

function heartbeatText(heartbeat: string | null | undefined, nowMs: number) {
  if (!heartbeat) return "mai";
  const parsed = Date.parse(heartbeat);
  if (!Number.isFinite(parsed)) return "non valido";
  const seconds = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  return `${seconds} s fa`;
}

function formatTime(value: number | string | null | undefined, timeZone = "Europe/Paris") {
  if (value === null || value === undefined) return "—";
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return "—";
  return new Intl.DateTimeFormat("it-IT", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(parsed));
}

function formatHourMinute(value: number | string | null | undefined, timeZone = "Europe/Paris") {
  if (value === null || value === undefined) return "—";
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return "—";
  return new Intl.DateTimeFormat("it-IT", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(parsed));
}

function countdown(targetMs: number | null, nowMs: number) {
  if (targetMs === null) return "—";
  const total = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function money(value: number | undefined) {
  return Number.isFinite(value) ? value!.toFixed(2) : "—";
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
    return () => {
      window.clearInterval(polling);
      window.clearInterval(clock);
    };
  }, [refreshState]);

  const status = data ? effectiveState(data, now) : "OFFLINE";
  const statusStyle = palette[status];
  const nextSessionMs = useMemo(() => data ? nextStartMs(now, data.session?.hoursUtc) : null, [data, now]);
  const last = data?.signals?.[0];
  const decision = data?.stream?.lastDecision;
  const direction = decision?.direction ?? last?.direction ?? "NO_TRADE";
  const quote = data?.quote;
  const livePrice = Number.isFinite(quote?.mid) ? Number(quote?.mid).toFixed(2) : "—";
  const results = data?.results;
  const lastResult = results?.last;
  const totalProfit = Number(results?.profit ?? 0);
  const totalR = Number(results?.resultR ?? 0);
  const lastProfit = Number(lastResult?.mt5_profit ?? 0);
  const lastR = Number(lastResult?.result_r ?? 0);
  const hours = parseHours(data?.session?.hoursUtc);
  const nextParis = nextSessionMs === null ? "—" : formatHourMinute(nextSessionMs, "Europe/Paris");

  const statusDescription = !data
    ? "Caricamento stato dal database…"
    : status === "LIVE"
      ? "Heartbeat fresco · dentro fascia operativa · MetaApi WebSocket pronto."
      : status === "WAITING"
        ? `Riparte alle ${hours?.from ?? "06:30"} UTC (${nextParis} Europe/Paris) · countdown ${countdown(nextSessionMs, now)}.`
        : status === "STOP"
          ? "STOP TUTTO è attivo: nuove analisi operative ed esecuzioni sono bloccate."
          : "Heartbeat assente o più vecchio di 60 secondi: il worker non viene considerato operativo.";

  return (
    <main>
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />

      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span>S</span></div>
          <div className="brand-copy">
            <strong>SCALPER</strong>
            <span>XAUUSD · STREAMING CONTROL CENTER</span>
          </div>
        </div>

        <div className="quote-panel">
          <span className="quote-label">{status === "LIVE" ? "● XAUUSD / LIVE" : "XAUUSD / ULTIMA QUOTE"}</span>
          <div className="price">{livePrice}<small>USD</small></div>
          <span style={{ display: "block", marginTop: 7, color: "#9aa7c7", font: "650 10px ui-monospace, monospace" }}>
            BID {money(quote?.bid)} · ASK {money(quote?.ask)} · SPR {money(quote?.spread)} · {formatTime(quote?.receivedAt ?? quote?.quotedAt)}
          </span>
        </div>
      </header>

      <section className={`status-shell ${status === "LIVE" ? "is-running" : status === "STOP" ? "is-stopped" : ""}`} style={{ borderColor: statusStyle.border }}>
        <div className="status-copy">
          <div className="status-kicker" style={{ color: statusStyle.color }}>
            <span className="status-dot" aria-hidden="true" style={{ animation: status === "LIVE" ? undefined : "none" }} />
            {status === "WAITING" ? "IN ATTESA / FUORI ORARIO" : status}
          </div>
          <h1>{status === "LIVE" ? "Scalper LIVE" : status === "WAITING" ? "Fuori fascia operativa" : status === "STOP" ? "Scalper in STOP" : "Worker offline"}</h1>
          <p>{statusDescription}</p>
          <p style={{ marginTop: 8 }}>
            Ultimo heartbeat <strong style={{ color: statusStyle.color }}>{heartbeatText(data?.stream?.heartbeat, now)}</strong>
            {decision ? <> · Ultima decisione <strong className="signal-direction" data-direction={direction}>{direction}</strong> — {decision.reasoning || "nessun dettaglio"}</> : null}
          </p>
        </div>
        <div
          className="state-badge"
          style={{ color: statusStyle.color, background: statusStyle.background, borderColor: statusStyle.border, boxShadow: `0 0 28px ${statusStyle.background}` }}
        >
          {status === "LIVE" ? "● LIVE" : statusStyle.label}
        </div>
      </section>

      {pollError ? (
        <p style={{ margin: "0 0 16px", padding: "10px 14px", border: "1px solid rgba(255,95,121,.4)", borderRadius: 12, color: "#ffb0c0", background: "rgba(120,25,49,.12)" }}>
          Aggiornamento dashboard non riuscito: {pollError}. Riprovo automaticamente ogni 5 s.
        </p>
      ) : null}

      {data ? (
        <SystemControl
          stopped={data.systemStopped}
          onChanged={(stopped) => setData((current) => current ? { ...current, systemStopped: stopped } : current)}
        />
      ) : null}

      {data?.stream?.currentError ? (
        <article className="rules-card" style={{ marginBottom: 18, borderColor: "rgba(255,95,121,.5)", background: "linear-gradient(150deg, rgba(86,20,39,.4), rgba(20,9,18,.9))" }}>
          <div className="card-heading rules-heading">
            <div><span className="card-index">!</span><h3>Errore corrente</h3></div>
            <span style={{ color: "#ff8fa9", font: "800 10px ui-monospace, monospace" }}>{formatTime(data.stream.currentError.at)}</span>
          </div>
          <p>{data.stream.currentError.message}</p>
        </article>
      ) : null}

      <section className="dashboard-head">
        <div>
          <span className="eyebrow">REAL-TIME OPERATIONS · POLLING 5S</span>
          <h2>Control center</h2>
        </div>
        <div className="micro-status">
          <span>M1 {data?.stream?.detail?.m1 ?? "—"}</span>
          <span>M5 {data?.stream?.detail?.m5 ?? "—"}</span>
          <span>{data?.session?.hoursUtc ?? "06:30-20:30"} UTC</span>
          <span>MT5 {data?.autoExec === true ? "AUTO ON" : data?.autoExec === false ? "AUTO OFF" : "—"}</span>
        </div>
      </section>

      <section className="grid" aria-label="Stato operativo">
        <article className="stream-card">
          <div className="card-heading">
            <div><span className="card-index">01</span><h3>Worker streaming</h3></div>
            <span style={{ color: statusStyle.color, font: "800 10px ui-monospace, monospace", letterSpacing: ".1em" }}>{statusStyle.label}</span>
          </div>
          <div className="dir" style={{ color: statusStyle.color }}>{data?.stream?.status ?? "not_started"}</div>
          <p>Stato operativo ricavato dall’heartbeat e dai flag live presenti in <code>scalper_settings</code>.</p>
          <p className="heartbeat">Ultimo heartbeat <span>{heartbeatText(data?.stream?.heartbeat, now)}</span></p>
        </article>

        <article className="signal-card">
          <div className="card-heading">
            <div><span className="card-index">02</span><h3>Ultima decisione</h3></div>
            <span className="signal-glyph" aria-hidden="true">↗</span>
          </div>
          <div className="dir signal-direction" data-direction={direction}>{direction}</div>
          <p>{decision?.reasoning ?? "In attesa della prima decisione del worker."}</p>
          <p className="heartbeat">Decisione <span>{formatTime(decision?.at)}</span></p>
        </article>

        <article className="execution-card">
          <div className="card-heading">
            <div><span className="card-index">03</span><h3>Esecuzione</h3></div>
            <span className="signal-glyph" aria-hidden="true">⚡</span>
          </div>
          <dl className="metrics">
            <div><dt>Auto MT5</dt><dd className={data?.autoExec === true ? "positive" : data?.autoExec === false ? "negative" : ""}>{data?.autoExec === true ? "ON" : data?.autoExec === false ? "OFF" : "—"}</dd></div>
            <div><dt>Lotti</dt><dd>{data?.lots ?? "—"}</dd></div>
            <div><dt>Spread</dt><dd>{money(quote?.spread)} $</dd></div>
            <div><dt>Posizione</dt><dd className="mt5-value">{data?.systemStopped ? "bloccata da STOP" : last?.mt5_position_id ? "aperta" : "nessuna"}</dd></div>
          </dl>
        </article>

        <article className="rules-card">
          <div className="card-heading rules-heading">
            <div><span className="card-index">04</span><h3>Risultati</h3></div>
            <span className="rainbow-label">PERFORMANCE</span>
          </div>
          <dl className="rules">
            <div><dt>Trade chiusi</dt><dd>{results?.total ?? 0}</dd></div>
            <div><dt>WIN</dt><dd className="positive">{results?.wins ?? 0}</dd></div>
            <div><dt>LOSS</dt><dd className="negative">{results?.losses ?? 0}</dd></div>
            <div><dt>Win rate</dt><dd>{Number(results?.winRate ?? 0).toFixed(1)}%</dd></div>
            <div><dt>Profitto totale</dt><dd className={totalProfit > 0 ? "positive" : totalProfit < 0 ? "negative" : ""}>{totalProfit >= 0 ? "+" : ""}{totalProfit.toFixed(2)}</dd></div>
          </dl>
          <p className="heartbeat">
            Breakeven <span>{results?.breakeven ?? 0}</span> · R totale <span>{totalR >= 0 ? "+" : ""}{totalR.toFixed(2)}R</span> · Ultimo risultato <span className={lastResult?.outcome === "WIN" ? "positive" : lastResult?.outcome === "LOSS" ? "negative" : ""}>{lastResult ? `${lastResult.outcome} · ${lastProfit >= 0 ? "+" : ""}${lastProfit.toFixed(2)} · ${lastR >= 0 ? "+" : ""}${lastR.toFixed(2)}R` : "—"}</span>
          </p>
        </article>

        <article className="rules-card">
          <div className="card-heading rules-heading">
            <div><span className="card-index">05</span><h3>Sessione e feed</h3></div>
            <span className="rainbow-label">SCALPER MODE</span>
          </div>
          <dl className="rules">
            <div><dt>Fascia UTC</dt><dd>{data?.session?.hoursUtc ?? "06:30-20:30"}</dd></div>
            <div><dt>Heartbeat max</dt><dd>60 s</dd></div>
            <div><dt>Polling UI</dt><dd>5 s</dd></div>
            <div><dt>Feed</dt><dd>MetaApi WS</dd></div>
            <div><dt>Simbolo</dt><dd>{data?.stream?.detail?.symbol ?? "XAUUSD"}</dd></div>
          </dl>
        </article>
      </section>

      {data?.stream?.historicalError ? (
        <details style={{ marginTop: 18, padding: "14px 16px", border: "1px solid rgba(255,255,255,.09)", borderRadius: 14, background: "rgba(255,255,255,.02)", color: "#9aa7c7" }}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>Storico errore worker</summary>
          <p style={{ marginBottom: 0 }}>{data.stream.historicalError.at ? `${formatTime(data.stream.historicalError.at)} · ` : ""}{data.stream.historicalError.message}</p>
        </details>
      ) : null}
    </main>
  );
}

import { SystemControl } from "@/components/system-control";

export const dynamic = "force-dynamic";

async function state() {
  try {
    const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000";
    const r = await fetch(`${base}/api/state`, { cache: "no-store" });
    return await r.json();
  } catch {
    return null;
  }
}

export default async function Home() {
  const s = await state();
  const last = s?.signals?.[0];
  const stopped = Boolean(s?.systemStopped);
  const streamOnline = Boolean(s?.stream?.online) && s?.stream?.status === "streaming";
  const direction = last?.direction ?? s?.stream?.lastDecision?.direction ?? "NO_TRADE";
  const price = stopped ? "FERMO" : s?.quote?.mid?.toFixed?.(2) ?? "—";

  return (
    <main>
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />

      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span>S</span></div>
          <div className="brand-copy">
            <strong>SCALPER</strong>
            <span>XAUUSD · ULTRA FAST ENGINE</span>
          </div>
        </div>

        <div className="quote-panel">
          <span className="quote-label">XAUUSD / LIVE</span>
          <div className="price">{price}{!stopped && <small>USD</small>}</div>
        </div>
      </header>

      <section className={`status-shell ${stopped ? "is-stopped" : "is-running"}`}>
        <div className="status-copy">
          <div className="status-kicker">
            <span className="status-dot" aria-hidden="true" />
            {stopped ? "TRADING ENGINE PAUSED" : streamOnline ? "TRADING ENGINE LIVE" : "CONNESSIONE IN VERIFICA"}
          </div>
          <h1>{stopped ? "Sistema fermo" : "Scalper operativo"}</h1>
          <p>
            {stopped
              ? "Dati, analisi e nuove esecuzioni sono bloccati."
              : streamOnline
                ? "MetaApi WebSocket attivo · analisi intrabar tick per tick · esecuzione automatica pronta."
                : "Il sistema è abilitato, ma il worker streaming non risulta online in questo momento."}
          </p>
        </div>
        <div className={`state-badge ${stopped ? "off" : streamOnline ? "on" : "off"}`}>
          {stopped ? "FERMO" : streamOnline ? "ATTIVO" : "OFFLINE"}
        </div>
      </section>

      <SystemControl stopped={stopped} />

      <section className="dashboard-head">
        <div>
          <span className="eyebrow">REAL-TIME OPERATIONS</span>
          <h2>Control center</h2>
        </div>
        <div className="micro-status">
          <span>M1</span><span>M5</span><span>WEBSOCKET</span><span>MT5</span>
        </div>
      </section>

      <section className="grid" aria-label="Stato operativo">
        <article className="stream-card">
          <div className="card-heading">
            <div><span className="card-index">01</span><h3>Streaming</h3></div>
            <span className={`mini-light ${streamOnline && !stopped ? "live" : ""}`} aria-hidden="true" />
          </div>
          <div className="dir">{stopped ? "PAUSED" : s?.stream?.status ?? "not_started"}</div>
          <p>{stopped ? "Worker in pausa tramite STOP TUTTO." : s?.stream?.online ? "Worker collegato a MetaApi in tempo reale." : "Worker non rilevato: esecuzione streaming non disponibile."}</p>
          <p className="heartbeat">Heartbeat <span>{s?.stream?.heartbeat ?? "—"}</span></p>
        </article>

        <article className="signal-card">
          <div className="card-heading">
            <div><span className="card-index">02</span><h3>Ultimo segnale</h3></div>
            <span className="signal-glyph" aria-hidden="true">↗</span>
          </div>
          <div className="dir signal-direction" data-direction={direction}>{direction}</div>
          <p>{last?.reasoning ?? s?.stream?.lastDecision?.reasoning ?? "In attesa di un setup valido."}</p>
        </article>

        <article className="execution-card">
          <div className="card-heading">
            <div><span className="card-index">03</span><h3>Esecuzione</h3></div>
            <span className="signal-glyph" aria-hidden="true">⚡</span>
          </div>
          <dl className="metrics">
            <div><dt>Auto MT5</dt><dd className={s?.autoExec ? "positive" : "negative"}>{s?.autoExec ? "ON" : "OFF"}</dd></div>
            <div><dt>Lotti</dt><dd>{s?.lots ?? "—"}</dd></div>
            <div><dt>Spread</dt><dd>{stopped ? "FERMO" : `${s?.quote?.spread?.toFixed?.(2) ?? "—"} $`}</dd></div>
            <div><dt>Posizione</dt><dd className="mt5-value">{stopped ? "automazioni bloccate" : last?.mt5_error ? `ERRORE: ${last.mt5_error}` : last?.mt5_position_id ? "aperta" : "nessuna"}</dd></div>
          </dl>
        </article>

        <article className="rules-card">
          <div className="card-heading rules-heading">
            <div><span className="card-index">04</span><h3>Parametri operativi</h3></div>
            <span className="rainbow-label">SCALPER MODE</span>
          </div>
          <dl className="rules">
            <div><dt>Posizioni</dt><dd>1 max</dd></div>
            <div><dt>Timeframe</dt><dd>M1 / M5</dd></div>
            <div><dt>R:R</dt><dd>1 : 1.45</dd></div>
            <div><dt>Controllo</dt><dd>Tick-by-tick</dd></div>
            <div><dt>Feed</dt><dd>MetaApi WS</dd></div>
          </dl>
        </article>
      </section>
    </main>
  );
}

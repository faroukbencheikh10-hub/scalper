import { SystemControl } from "@/components/system-control";
export const dynamic="force-dynamic";
async function state(){try{const base=process.env.VERCEL_URL?`https://${process.env.VERCEL_URL}`:"http://localhost:3000";const r=await fetch(`${base}/api/state`,{cache:"no-store"});return await r.json();}catch{return null;}}
export default async function Home(){
  const s=await state();const last=s?.signals?.[0];const stopped=Boolean(s?.systemStopped);const streamOnline=Boolean(s?.stream?.online)&&s?.stream?.status==="streaming";
  const direction=last?.direction??s?.stream?.lastDecision?.direction??"NO_TRADE";
  return <main>
    <header>
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">S</div>
        <div className="brand-copy"><strong>SCALPER</strong><span>XAUUSD · M1 / M5</span></div>
      </div>
      <div className="quote">
        <span className="quote-label">ORO / DOLLARO</span>
        <div className="price">{stopped?"FERMO":s?.quote?.mid?.toFixed?.(2)??"—"}{!stopped&&<small>USD</small>}</div>
      </div>
    </header>

    <SystemControl stopped={stopped} />

    <section className="hero" aria-labelledby="dashboard-title">
      <div>
        <div className="eyebrow">XAUUSD / STREAMING</div>
        <h1 id="dashboard-title">Scalper <span>streaming</span></h1>
        <p>Quote continue via WebSocket. La strategia conferma il setup sulla chiusura M1 e usa M5 solo come contesto immediato.</p>
      </div>
      <div className={stopped?"off":streamOnline?"on":"off"}>{stopped?"SISTEMA FERMO":streamOnline?"SISTEMA ATTIVO":"STREAM OFFLINE"}</div>
    </section>

    <section className="grid" aria-label="Stato operativo">
      <article className="stream-card">
        <div className="card-heading"><h2>Streaming</h2><span className="card-index" aria-hidden="true">01 /</span></div>
        <div className="dir">{s?.stream?.status??"not_started"}</div>
        <p>{s?.stream?.online?"Worker collegato a MetaApi in tempo reale.":"Worker non rilevato: nessuna esecuzione automatica streaming."}</p>
        <p className="heartbeat">Heartbeat: {s?.stream?.heartbeat??"—"}</p>
      </article>

      <article className="signal-card">
        <div className="card-heading"><h2>Ultimo segnale</h2><span className="card-index" aria-hidden="true">02 /</span></div>
        <div className="dir" data-direction={direction}>{direction}</div>
        <p>{last?.reasoning??s?.stream?.lastDecision?.reasoning??"In attesa della prima M1 chiusa."}</p>
      </article>

      <article className="execution-card">
        <div className="card-heading"><h2>Esecuzione</h2><span className="card-index" aria-hidden="true">03 /</span></div>
        <dl className="metrics">
          <div><dt>Auto MT5</dt><dd>{s?.autoExec?"ON":"OFF"}</dd></div>
          <div><dt>Lotti</dt><dd>{s?.lots??"—"}</dd></div>
          <div><dt>Spread streaming</dt><dd>{stopped?"FERMO":s?.quote?.spread?.toFixed?.(2)??"—"} $</dd></div>
          <div><dt>MT5</dt><dd className="mt5-value">{stopped?"automazioni bloccate":last?.mt5_error?`ERRORE: ${last.mt5_error}`:last?.mt5_position_id?"posizione aperta":"nessuna posizione"}</dd></div>
        </dl>
      </article>

      <article className="rules-card">
        <div className="card-heading"><h2>Regole</h2><span className="card-index" aria-hidden="true">04 /</span></div>
        <dl className="rules">
          <div><dt>Posizioni</dt><dd>1 posizione</dd></div>
          <div><dt>Time-stop</dt><dd>12 min</dd></div>
          <div><dt>Rischio / rendimento</dt><dd>1 : 1.45</dd></div>
          <div><dt>Cooldown</dt><dd>Dopo loss</dd></div>
          <div><dt>Stop dinamico</dt><dd>2–5 $</dd></div>
        </dl>
      </article>
    </section>
  </main>;
}

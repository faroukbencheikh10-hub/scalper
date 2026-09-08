import { SystemControl } from "@/components/system-control";
export const dynamic="force-dynamic";
async function state(){try{const base=process.env.VERCEL_URL?`https://${process.env.VERCEL_URL}`:"http://localhost:3000";const r=await fetch(`${base}/api/state`,{cache:"no-store"});return await r.json();}catch{return null;}}
export default async function Home(){
  const s=await state();const last=s?.signals?.[0];const stopped=Boolean(s?.systemStopped);const streamOnline=Boolean(s?.stream?.online)&&s?.stream?.status==="streaming";
  return <main>
    <header><div><strong>SCALPER</strong><span>XAUUSD · MetaApi Streaming/WebSocket · M1/M5</span></div><div className="price">{stopped?"STOP":s?.quote?.mid?.toFixed?.(2)??"—"}</div></header>
    <SystemControl stopped={stopped} />
    <section className="hero"><div><h1>Scalper streaming</h1><p>Quote continue via WebSocket. La strategia conferma il setup sulla chiusura M1 e usa M5 solo come contesto immediato.</p></div><div className={stopped?"off":streamOnline?"on":"off"}>{stopped?"STOP TUTTO":streamOnline?"STREAM ONLINE":"STREAM OFFLINE"}</div></section>
    <section className="grid">
      <article><h2>Streaming</h2><div className="dir">{s?.stream?.status??"not_started"}</div><p>{s?.stream?.online?"Worker collegato a MetaApi in tempo reale.":"Worker non rilevato: nessuna esecuzione automatica streaming."}</p><p>Heartbeat: {s?.stream?.heartbeat??"—"}</p></article>
      <article><h2>Ultimo segnale</h2><div className="dir">{last?.direction??s?.stream?.lastDecision?.direction??"NO_TRADE"}</div><p>{last?.reasoning??s?.stream?.lastDecision?.reasoning??"In attesa della prima M1 chiusa."}</p></article>
      <article><h2>Esecuzione</h2><p>Auto MT5: {s?.autoExec?"ON":"OFF"}</p><p>Lotti: {s?.lots??"—"}</p><p>Spread streaming: {stopped?"FERMO":s?.quote?.spread?.toFixed?.(2)??"—"} $</p><p>MT5: {stopped?"automazioni bloccate":last?.mt5_error?`ERRORE: ${last.mt5_error}`:last?.mt5_position_id?"posizione aperta":"nessuna posizione"}</p></article>
      <article><h2>Regole</h2><p>1 posizione · time-stop 12 min · RR 1.45 · cooldown dopo loss · stop dinamico 2–5 $.</p></article>
    </section>
  </main>;
}

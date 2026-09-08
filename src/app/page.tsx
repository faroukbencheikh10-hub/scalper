import { GenerateButton } from "@/components/generate-button";
import { SystemControl } from "@/components/system-control";
export const dynamic="force-dynamic";
async function state(){try{const base=process.env.VERCEL_URL?`https://${process.env.VERCEL_URL}`:"http://localhost:3000";const r=await fetch(`${base}/api/state`,{cache:"no-store"});return await r.json();}catch{return null;}}
export default async function Home(){
  const s=await state();const last=s?.signals?.[0];const stopped=Boolean(s?.systemStopped);
  return <main>
    <header><div><strong>SCALPER</strong><span>XAUUSD · M1/M5 · 3–15 min</span></div><div className="price">{stopped?"STOP":s?.quote?.mid?.toFixed?.(2)??"—"}</div></header>
    <SystemControl stopped={stopped} />
    <section className="hero"><div><h1>Scalper puro</h1><p>Micro-pullback e liquidity sweep su M1. M5 serve solo da contesto immediato.</p></div><div className={stopped?"off":s?.autoExec?"on":"off"}>{stopped?"STOP TUTTO":s?.autoExec?"AUTO MT5 ON":"AUTO MT5 OFF"}</div></section>
    <section className="grid">
      <article><h2>Ultimo segnale</h2><div className="dir">{last?.direction??"NO_TRADE"}</div><p>{last?.reasoning??"In attesa del primo ciclo."}</p></article>
      <article><h2>Esecuzione</h2><p>Lotti: {s?.lots??"—"}</p><p>Spread: {stopped?"FERMO":s?.quote?.spread?.toFixed?.(2)??"—"} $</p><p>MT5: {stopped?"automazioni bloccate":last?.mt5_error?`ERRORE: ${last.mt5_error}`:last?.mt5_position_id?"posizione aperta":"nessuna posizione"}</p></article>
      <article><h2>Regole</h2><p>1 posizione · time-stop 12 min · RR 1.45 · cooldown dopo loss · stop dinamico 2–5 $.</p></article>
    </section>
    <GenerateButton disabled={stopped} />
  </main>;
}

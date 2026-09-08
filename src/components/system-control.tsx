"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function SystemControl({stopped}:{stopped:boolean}){
  const router=useRouter();
  const [isStopped,setIsStopped]=useState(stopped);
  const [busy,setBusy]=useState(false);
  const [msg,setMsg]=useState<string|null>(null);

  useEffect(()=>setIsStopped(stopped),[stopped]);

  async function toggle(){
    const next=!isStopped;
    const ok=window.confirm(next
      ? "STOP TUTTO? Blocca dati, analisi e nuove esecuzioni MT5. Le posizioni gia aperte NON vengono chiuse e restano protette da SL/TP sul broker."
      : "RIATTIVARE TUTTO? Riprenderanno dati, analisi e possibili nuove esecuzioni MT5.");
    if(!ok)return;
    setBusy(true);setMsg(null);
    try{
      const r=await fetch("/api/control",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({stopped:next})});
      const d=await r.json();
      if(!d.ok) setMsg(d.error||"Errore");
      else {
        setIsStopped(typeof d.stopped==="boolean"?d.stopped:next);
        setMsg(d.note||"Fatto");
        router.refresh();
      }
    }catch{setMsg("Errore di rete");}
    finally{setBusy(false);}
  }

  const active=!isStopped;
  return <div
    className={`system-control ${isStopped?"stopped":"running"}`}
    style={{
      border: active ? "2px solid rgba(96,247,170,.75)" : "2px solid rgba(255,95,121,.78)",
      background: active
        ? "linear-gradient(135deg, rgba(13,72,51,.78), rgba(7,25,27,.92))"
        : "linear-gradient(135deg, rgba(92,20,39,.82), rgba(28,8,18,.94))",
      boxShadow: active
        ? "0 0 34px rgba(96,247,170,.18), inset 0 0 28px rgba(96,247,170,.05)"
        : "0 0 34px rgba(255,95,121,.18), inset 0 0 28px rgba(255,95,121,.05)"
    }}
  >
    <div style={{display:"flex",alignItems:"center",gap:14}}>
      <span
        aria-hidden="true"
        style={{
          width:16,height:16,borderRadius:"50%",flex:"0 0 auto",
          background:active?"#60f7aa":"#ff5f79",
          boxShadow:active?"0 0 20px #60f7aa":"0 0 20px #ff5f79"
        }}
      />
      <div>
        <strong style={{fontSize:22,letterSpacing:".08em",color:active?"#8fffc5":"#ff9db1"}}>
          {active?"ATTIVATO":"DISATTIVATO"}
        </strong>
        <span style={{color:active?"#c6ffe1":"#ffd0da"}}>
          {active?"Scalper operativo · dati, analisi e automazioni attive":"Scalper fermo · dati, analisi e nuove esecuzioni bloccate"}
        </span>
      </div>
    </div>
    <button type="button" className={isStopped?"resume-button":"stop-button"} onClick={toggle} disabled={busy}>
      {busy?"Attendi…":isStopped?"RIATTIVA TUTTO":"STOP TUTTO"}
    </button>
    {msg?<p>{msg}</p>:null}
  </div>;
}

"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function SystemControl({stopped}:{stopped:boolean}){
  const router=useRouter();
  const [busy,setBusy]=useState(false);
  const [msg,setMsg]=useState<string|null>(null);
  async function toggle(){
    const next=!stopped;
    const ok=window.confirm(next
      ? "STOP TUTTO? Blocca dati, analisi e nuove esecuzioni MT5. Le posizioni gia aperte NON vengono chiuse e restano protette da SL/TP sul broker."
      : "RIATTIVARE TUTTO? Riprenderanno dati, analisi e possibili nuove esecuzioni MT5.");
    if(!ok)return;
    setBusy(true);setMsg(null);
    try{
      const r=await fetch("/api/control",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({stopped:next})});
      const d=await r.json();
      if(!d.ok) setMsg(d.error||"Errore");
      else {setMsg(d.note||"Fatto");router.refresh();}
    }catch{setMsg("Errore di rete");}
    finally{setBusy(false);}
  }
  return <div className={`system-control ${stopped?"stopped":"running"}`}>
    <div>
      <strong>{stopped?"SISTEMA FERMO":"SISTEMA ATTIVO"}</strong>
      <span>{stopped?"Dati · analisi · esecuzioni bloccati":"Dati e automazioni abilitate secondo configurazione"}</span>
    </div>
    <button type="button" className={stopped?"resume-button":"stop-button"} onClick={toggle} disabled={busy}>
      {busy?"Attendi…":stopped?"RIATTIVA TUTTO":"STOP TUTTO"}
    </button>
    {msg?<p>{msg}</p>:null}
  </div>;
}

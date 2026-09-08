"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function GenerateButton({disabled=false}:{disabled?:boolean}){
  const router=useRouter();
  const [busy,setBusy]=useState(false);
  const [msg,setMsg]=useState<string|null>(null);
  async function run(){
    if(disabled){setMsg("Sistema fermo: riattiva tutto per analizzare.");return;}
    setBusy(true); setMsg(null);
    try{
      const r=await fetch("/api/generate",{method:"POST"});
      const d=await r.json();
      if(!d.ok) setMsg(d.error||"Errore");
      else if(d.direction==="NO_TRADE") setMsg(d.reasoning||"Nessun setup");
      else if(d.preview) setMsg(`PREVIEW ${d.direction} · ${d.setup} · Entry ${Number(d.entry).toFixed(2)} · SL ${Number(d.stopLoss).toFixed(2)} · TP ${Number(d.takeProfit).toFixed(2)}`);
      else setMsg(`${d.direction} ${d.setup} · ${d.execution?.status||"generato"}`);
      router.refresh();
    }catch{setMsg("Errore di rete");}
    finally{setBusy(false);}
  }
  return <div className="action"><button type="button" onClick={run} disabled={busy||disabled}>{busy?"Analisi M1…":disabled?"Sistema fermo":"Analizza adesso"}</button>{msg?<p>{msg}</p>:null}</div>;
}

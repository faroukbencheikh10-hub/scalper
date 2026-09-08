import { NextResponse } from "next/server";
import { ensureSchema,dbQuery,getSetting,systemStopActive } from "@/lib/server/db";
import { autoExecEnabled,lots } from "@/lib/server/executor";

export const dynamic="force-dynamic";

function parseJson(value:string|undefined){
  if(!value) return null;
  try{return JSON.parse(value);}catch{return null;}
}

export async function GET(){
  try{
    await ensureSchema();
    const stopped=await systemStopActive();
    const [signals,workerStatus,workerHeartbeat,lastQuote,lastDecision,lastError]=await Promise.all([
      dbQuery(`SELECT * FROM scalper_signals ORDER BY created_at DESC LIMIT 20`),
      getSetting("stream_worker_status"),
      getSetting("stream_worker_heartbeat"),
      getSetting("stream_last_quote"),
      getSetting("stream_last_decision"),
      getSetting("stream_last_error"),
    ]);
    const heartbeatMs=workerHeartbeat?Date.parse(workerHeartbeat):NaN;
    const workerOnline=Number.isFinite(heartbeatMs)&&Date.now()-heartbeatMs<15000;
    return NextResponse.json({
      ok:true,
      name:"scalper",
      mode:"MetaApi Streaming/WebSocket",
      systemStopped:stopped,
      systemStopChangedAt:await getSetting("system_stop_changed_at")??null,
      quote:stopped?null:parseJson(lastQuote),
      autoExec:autoExecEnabled(),
      lots:lots(),
      stream:{
        status:workerStatus??"not_started",
        heartbeat:workerHeartbeat??null,
        online:workerOnline,
        lastDecision:parseJson(lastDecision),
        lastError:lastError??null,
      },
      signals:signals.rows,
    });
  }catch(err){
    return NextResponse.json({ok:false,error:err instanceof Error?err.message:String(err)},{status:500});
  }
}

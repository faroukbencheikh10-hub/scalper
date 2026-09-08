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
    const [signals,stats,lastClosed,workerStatus,workerHeartbeat,lastQuote,lastDecision,lastError]=await Promise.all([
      dbQuery(`SELECT * FROM scalper_signals ORDER BY created_at DESC LIMIT 20`),
      dbQuery(`SELECT
        COUNT(*) FILTER (WHERE outcome IN ('WIN','LOSS','BREAKEVEN'))::int AS total,
        COUNT(*) FILTER (WHERE outcome='WIN')::int AS wins,
        COUNT(*) FILTER (WHERE outcome='LOSS')::int AS losses,
        COUNT(*) FILTER (WHERE outcome='BREAKEVEN')::int AS breakeven,
        COALESCE(SUM(mt5_profit) FILTER (WHERE outcome IN ('WIN','LOSS','BREAKEVEN')),0)::float8 AS profit,
        COALESCE(SUM(result_r) FILTER (WHERE outcome IN ('WIN','LOSS','BREAKEVEN')),0)::float8 AS result_r
      FROM scalper_signals`),
      dbQuery(`SELECT direction,setup,outcome,mt5_profit,result_r,mt5_open_price,mt5_close_price,closed_at
        FROM scalper_signals
        WHERE outcome IN ('WIN','LOSS','BREAKEVEN')
        ORDER BY closed_at DESC NULLS LAST
        LIMIT 1`),
      getSetting("stream_worker_status"),
      getSetting("stream_worker_heartbeat"),
      getSetting("stream_last_quote"),
      getSetting("stream_last_decision"),
      getSetting("stream_last_error"),
    ]);
    const heartbeatMs=workerHeartbeat?Date.parse(workerHeartbeat):NaN;
    const workerOnline=Number.isFinite(heartbeatMs)&&Date.now()-heartbeatMs<15000;
    const st=stats.rows[0]??{};
    const wins=Number(st.wins??0);
    const losses=Number(st.losses??0);
    const decided=wins+losses;
    return NextResponse.json({
      ok:true,
      name:"scalper",
      mode:"MetaApi Streaming/WebSocket",
      systemStopped:stopped,
      systemStopChangedAt:await getSetting("system_stop_changed_at")??null,
      quote:stopped?null:parseJson(lastQuote),
      autoExec:autoExecEnabled(),
      lots:lots(),
      results:{
        total:Number(st.total??0),
        wins,
        losses,
        breakeven:Number(st.breakeven??0),
        winRate:decided>0?Number(((wins/decided)*100).toFixed(1)):0,
        profit:Number(st.profit??0),
        resultR:Number(st.result_r??0),
        last:lastClosed.rows[0]??null,
      },
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

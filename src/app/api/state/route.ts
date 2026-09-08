import { NextResponse } from "next/server";
import { ensureSchema,dbQuery,getSetting,systemStopActive } from "@/lib/server/db";
import { fetchQuote } from "@/lib/server/metaApi";
import { autoExecEnabled,lots,syncExecutor } from "@/lib/server/executor";
export const dynamic="force-dynamic";
export async function GET(){
  try{
    await ensureSchema();
    const stopped=await systemStopActive();
    const signals=await dbQuery(`SELECT * FROM scalper_signals ORDER BY created_at DESC LIMIT 20`);
    if(stopped){
      return NextResponse.json({
        ok:true,name:"scalper",systemStopped:true,systemStopChangedAt:await getSetting("system_stop_changed_at")??null,
        quote:null,autoExec:autoExecEnabled(),lots:lots(),sync:{checked:0,closed:0,timedOut:0,stopped:true},signals:signals.rows
      });
    }
    const [sync,quote]=await Promise.all([syncExecutor(),fetchQuote().catch(()=>null)]);
    return NextResponse.json({ok:true,name:"scalper",systemStopped:false,systemStopChangedAt:await getSetting("system_stop_changed_at")??null,quote,autoExec:autoExecEnabled(),lots:lots(),sync,signals:signals.rows});
  }catch(err){
    return NextResponse.json({ok:false,error:err instanceof Error?err.message:String(err)},{status:500});
  }
}

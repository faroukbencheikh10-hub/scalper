import { dbQuery, ensureSchema, systemStopActive } from "./db";
import { closePosition, deals, openMarket, positions, symbol } from "./metaApi";

function envN(name: string, fallback: number, min = 0) { const v=Number(process.env[name]); return Number.isFinite(v)&&v>=min?v:fallback; }
export function autoExecEnabled(){ return process.env.AUTO_EXEC === "true"; }
export function lots(){ return envN("EXEC_LOTS",0.05,0.01); }

async function syncClosed() {
  await ensureSchema();
  const r = await dbQuery(`SELECT id,mt5_position_id,mt5_open_price,entry,stop_loss,created_at FROM scalper_signals
    WHERE outcome IS NULL AND mt5_position_id IS NOT NULL ORDER BY created_at ASC`);
  if (!r.rows.length) return { checked:0, closed:0, timedOut:0 };
  const ps = await positions();
  let closed=0, timedOut=0;
  const timeoutMin = envN("SCALPER_TIME_STOP_MIN",12,1);
  for (const s of r.rows) {
    const p = ps.find(x=>x.id===s.mt5_position_id);
    if (p) {
      const age=(Date.now()-new Date(s.created_at).getTime())/60000;
      if (age >= timeoutMin) {
        await closePosition(p.id,s.id); timedOut++;
      }
      continue;
    }
    const ds = await deals(s.mt5_position_id);
    const out = ds.filter(d=>d.entryType && d.entryType!=="DEAL_ENTRY_IN").sort((a,b)=>Date.parse(a.time??"")-Date.parse(b.time??"")).at(-1);
    const inn = ds.filter(d=>d.entryType==="DEAL_ENTRY_IN").sort((a,b)=>Date.parse(a.time??"")-Date.parse(b.time??""))[0];
    if (!out || !Number.isFinite(Number(out.price))) continue;
    const open=Number(s.mt5_open_price ?? inn?.price ?? s.entry), close=Number(out.price), profit=Number(out.profit ?? 0), risk=Math.abs(open-Number(s.stop_loss));
    const move = close>=open ? close-open : open-close;
    const signed = Number(s.entry) < Number(s.stop_loss) ? (open-close) : (close-open);
    const resultR = risk>0 ? Number((signed/risk).toFixed(2)) : 0;
    await dbQuery(`UPDATE scalper_signals SET mt5_close_price=$2,mt5_profit=$3,outcome=$4,result_r=$5,closed_at=COALESCE($6::timestamptz,now()) WHERE id=$1`,
      [s.id,close,profit,profit>0?"WIN":profit<0?"LOSS":"BREAKEVEN",resultR,out.time ?? null]);
    closed++;
  }
  return { checked:r.rows.length, closed, timedOut };
}

async function limits() {
  const start = new Date(); start.setUTCHours(0,0,0,0);
  const r=await dbQuery(`SELECT COUNT(*) FILTER (WHERE mt5_order_id IS NOT NULL) trades, COALESCE(SUM(mt5_profit),0) profit FROM scalper_signals WHERE created_at >= $1`,[start.toISOString()]);
  const trades=Number(r.rows[0]?.trades??0), profit=Number(r.rows[0]?.profit??0);
  if (trades>=envN("MAX_TRADES_PER_DAY",12,1)) return {ok:false,reason:"max_trades_per_day"};
  if (profit<=-envN("MAX_DAILY_LOSS",150,0)) return {ok:false,reason:"max_daily_loss"};
  const last=await dbQuery(`SELECT outcome,closed_at FROM scalper_signals WHERE outcome IS NOT NULL ORDER BY closed_at DESC LIMIT 3`);
  const losses=last.rows.filter((x:{ outcome?: string })=>x.outcome==="LOSS");
  if (losses.length>=3) {
    const t=Date.parse(last.rows[0].closed_at); if (Date.now()-t < envN("SCALPER_THREE_LOSS_COOLDOWN_MIN",30,1)*60000) return {ok:false,reason:"three_loss_cooldown"};
  } else if (last.rows[0]?.outcome==="LOSS") {
    const t=Date.parse(last.rows[0].closed_at); if (Date.now()-t < envN("SCALPER_LOSS_COOLDOWN_MIN",5,1)*60000) return {ok:false,reason:"loss_cooldown"};
  }
  return {ok:true,reason:null};
}

export async function syncExecutor(){
  try {
    await ensureSchema();
    if (await systemStopActive()) return {checked:0,closed:0,timedOut:0,stopped:true};
    return await syncClosed();
  } catch(err){
    return {checked:0,closed:0,timedOut:0,error:err instanceof Error?err.message:String(err)};
  }
}

export async function execute(signalId:string, direction:"BUY"|"SELL", stopLoss:number, takeProfit:number) {
  await ensureSchema();
  if (await systemStopActive()) return {status:"system_stopped" as const};
  if (!autoExecEnabled()) return {status:"disabled" as const};
  await syncClosed();
  const lim=await limits(); if(!lim.ok) return {status:"blocked" as const,reason:lim.reason};
  const ps=await positions();
  const existing=ps.find(p=>p.symbol===symbol()); if(existing) return {status:"blocked_existing_position" as const,positionId:existing.id};
  try {
    // Secondo controllo immediatamente prima dell'ordine: copre uno STOP premuto durante i pre-check.
    if (await systemStopActive()) return {status:"system_stopped" as const};
    const tr=await openMarket(signalId,direction,lots(),stopLoss,takeProfit);
    await dbQuery(`UPDATE scalper_signals SET mt5_order_id=$2 WHERE id=$1`,[signalId,tr.orderId??null]);
    for(let i=0;i<6;i++){
      const p=(await positions()).find(x=>x.symbol===symbol());
      if(p){ await dbQuery(`UPDATE scalper_signals SET mt5_position_id=$2,mt5_open_price=$3 WHERE id=$1`,[signalId,p.id,p.openPrice]); return {status:"opened" as const,orderId:tr.orderId??null,positionId:p.id,openPrice:p.openPrice}; }
      await new Promise(r=>setTimeout(r,250+i*150));
    }
    return {status:"pending_position_link" as const,orderId:tr.orderId??null};
  } catch(err){ const msg=err instanceof Error?err.message:String(err); await dbQuery(`UPDATE scalper_signals SET mt5_error=$2 WHERE id=$1`,[signalId,msg.slice(0,1000)]); return {status:"error" as const,error:msg}; }
}

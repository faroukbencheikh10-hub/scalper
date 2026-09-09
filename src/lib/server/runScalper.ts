import { ensureSchema, dbQuery, systemStopActive } from "./db";
import { fetchCandles, fetchQuote } from "./metaApi";
import { evaluateScalper } from "./scalperStrategy";
import { autoExecEnabled } from "./tradingConfig";

function envInt(name: string, fallback: number, min: number, max: number) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

// Sola analisi: l'esecuzione su MT5 avviene esclusivamente nel worker Railway.
export async function runScalper() {
  await ensureSchema();
  if (await systemStopActive()) return {ok:true,skipped:true,reason:"system_stopped",systemStopped:true};
  const active=await dbQuery(`SELECT id,direction,created_at,mt5_position_id FROM scalper_signals WHERE outcome IS NULL AND direction IN ('BUY','SELL') ORDER BY created_at DESC LIMIT 1`);
  if(active.rows[0]) return {ok:true,skipped:true,reason:"signal_active",active:active.rows[0]};

  const m1Candles = envInt("SCALPER_M1_CANDLES", 500, 50, 1000);
  const m5Candles = envInt("SCALPER_M5_CANDLES", 300, 50, 1000);
  const [quote,m1,m5]=await Promise.all([fetchQuote(),fetchCandles("1m",m1Candles),fetchCandles("5m",m5Candles)]);
  const s=evaluateScalper({quote,m1,m5});
  if(s.direction==="NO_TRADE") return {ok:true,direction:"NO_TRADE",reasoning:s.reasoning,quote};
  if(!autoExecEnabled()) return {ok:true,direction:s.direction,preview:true,setup:s.setup,entry:s.entry,stopLoss:s.stopLoss,takeProfit:s.takeProfit,riskReward:s.riskReward,reasoning:s.reasoning,execution:{status:"disabled"},quote};
  // Analisi manuale: chiusa subito come SKIPPED, cosi' il worker non la vede
  // come segnale aperto e non la esegue mai.
  const saved=await dbQuery(`INSERT INTO scalper_signals(direction,setup,entry,stop_loss,take_profit,risk_reward,reasoning,outcome,closed_at,mt5_error)
    VALUES($1,$2,$3,$4,$5,$6,$7,'SKIPPED',now(),'manual analysis: nessuna esecuzione da Vercel') RETURNING id,created_at`,
    [s.direction,`manual:${s.setup ?? "none"}`,s.entry,s.stopLoss,s.takeProfit,s.riskReward,`[manual] ${s.reasoning}`]);
  const id=saved.rows[0].id as string;
  return {ok:true,direction:s.direction,signalId:id,setup:s.setup,entry:s.entry,stopLoss:s.stopLoss,takeProfit:s.takeProfit,riskReward:s.riskReward,reasoning:s.reasoning,manual:true,execution:{status:"worker_only"},quote};
}

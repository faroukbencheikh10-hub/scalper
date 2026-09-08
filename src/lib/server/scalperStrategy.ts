import type { Candle, Quote, ScalperSignal } from "@/lib/types";
import { atr, clamp, emaClose } from "./indicators";

function envN(name: string, fallback: number) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
function no(reasoning: string): ScalperSignal {
  return { direction: "NO_TRADE", entry: null, stopLoss: null, takeProfit: null, riskReward: null, setup: null, reasoning };
}
function hoursAllowed(now = new Date()) {
  const raw = process.env.SCALPER_HOURS_UTC?.trim() || "06:30-20:30";
  const [a,b] = raw.split("-");
  const mins = (s: string) => { const [h,m] = s.split(":").map(Number); return h*60+m; };
  if (!a || !b) return true;
  const cur = now.getUTCHours()*60 + now.getUTCMinutes();
  return cur >= mins(a) && cur <= mins(b);
}
function bullish(c: Candle) { return c.close > c.open; }
function bearish(c: Candle) { return c.close < c.open; }
function timeStopLabel() {
  const seconds = envN("SCALPER_TIME_STOP_SEC", 0);
  if (seconds > 0) return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sec`;
  return `${envN("SCALPER_TIME_STOP_MIN", 12)} min`;
}

export function evaluateScalper(input: { quote: Quote; m1: Candle[]; m5: Candle[] }): ScalperSignal {
  const { quote, m1, m5 } = input;
  if (!hoursAllowed()) return no(`Fuori fascia scalper ${process.env.SCALPER_HOURS_UTC || "06:30-20:30"} UTC.`);
  if (m1.length < 35 || m5.length < 30) return no("Storico M1/M5 insufficiente.");

  const maxSpread = envN("SCALPER_MAX_SPREAD", 1.2);
  if (quote.spread > maxSpread) return no(`Spread ${quote.spread.toFixed(2)}$ sopra massimo ${maxSpread.toFixed(2)}$.`);

  const atr1 = atr(m1, 14, true);
  if (!atr1) return no("ATR M1 non disponibile.");
  const minAtr = envN("SCALPER_MIN_ATR_M1", 0.8), maxAtr = envN("SCALPER_MAX_ATR_M1", 6);
  if (atr1 < minAtr) return no(`Volatilità M1 troppo bassa: ATR ${atr1.toFixed(2)}$.`);
  if (atr1 > maxAtr) return no(`Volatilità M1 troppo alta: ATR ${atr1.toFixed(2)}$.`);

  const last = m1[m1.length-1], prev = m1[m1.length-2];
  if (last.high-last.low > Math.max(atr1*2.2, 5.5)) return no(`Candela M1 shock ${(last.high-last.low).toFixed(2)}$: niente inseguimento.`);

  const fast5 = emaClose(m5, 9), slow5 = emaClose(m5, 21);
  const fast1 = emaClose(m1, 9), slow1 = emaClose(m1, 20);
  if ([fast5,slow5,fast1,slow1].some(v=>v===null)) return no("EMA non disponibili.");
  const lastM5Close = m5[m5.length - 1].close;
  const trendUp = lastM5Close > fast5! && fast5! > slow5!;
  const trendDown = lastM5Close < fast5! && fast5! < slow5!;

  let direction: "BUY"|"SELL"|null = null;
  let setup: "micro_pullback"|"liquidity_sweep"|null = null;
  let structureStop: number | null = null;

  const pullbackBuy = trendUp && prev.low <= fast1! && last.close > fast1! && bullish(last) && last.close > prev.close;
  const pullbackSell = trendDown && prev.high >= fast1! && last.close < fast1! && bearish(last) && last.close < prev.close;
  if (pullbackBuy) { direction="BUY"; setup="micro_pullback"; structureStop=Math.min(prev.low,last.low)-0.25; }
  else if (pullbackSell) { direction="SELL"; setup="micro_pullback"; structureStop=Math.max(prev.high,last.high)+0.25; }
  else {
    let low = Infinity, high = -Infinity;
    for (let i = Math.max(0, m1.length - 10); i < Math.max(0, m1.length - 2); i++) {
      low = Math.min(low, m1[i].low);
      high = Math.max(high, m1[i].high);
    }
    const sweepBuy = prev.low < low && prev.close > low && last.close > prev.high && bullish(last) && !trendDown;
    const sweepSell = prev.high > high && prev.close < high && last.close < prev.low && bearish(last) && !trendUp;
    if (sweepBuy) { direction="BUY"; setup="liquidity_sweep"; structureStop=prev.low-0.25; }
    else if (sweepSell) { direction="SELL"; setup="liquidity_sweep"; structureStop=prev.high+0.25; }
  }
  if (!direction || !setup || structureStop==null) return no(`Nessun trigger scalper M1. Contesto M5 ${trendUp?"rialzista":trendDown?"ribassista":"neutro"}.`);

  const entry = direction === "BUY" ? quote.ask : quote.bid;
  const rawRisk = Math.abs(entry-structureStop);
  const minRisk = envN("SCALPER_MIN_RISK",2), maxRisk = envN("SCALPER_MAX_RISK",5);
  const risk = clamp(Math.max(rawRisk, atr1*0.9), minRisk, maxRisk);
  const stopLoss = direction === "BUY" ? entry-risk : entry+risk;
  const rr = envN("SCALPER_RR",1.45);
  const takeProfit = direction === "BUY" ? entry+risk*rr : entry-risk*rr;

  return {
    direction, setup,
    entry:Number(entry.toFixed(2)), stopLoss:Number(stopLoss.toFixed(2)), takeProfit:Number(takeProfit.toFixed(2)), riskReward:Number(rr.toFixed(2)),
    reasoning:`${setup === "micro_pullback" ? "Micro-pullback" : "Sweep di liquidità"} M1 ${direction}. Contesto M5 ${trendUp?"rialzista":trendDown?"ribassista":"neutro"}; ATR M1 ${atr1.toFixed(2)}$, spread ${quote.spread.toFixed(2)}$. Time-stop ${timeStopLabel()}.`
  };
}

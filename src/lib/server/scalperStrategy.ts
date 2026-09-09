import type { Candle, Quote, ScalperSetup, ScalperSignal, SetupEvaluation } from "@/lib/types";
import { setupLabel } from "@/lib/setups";
import { atr, emaCloseSeries } from "./indicators";

function envN(name: string, fallback: number) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
function envI(name: string, fallback: number, min: number, max: number) {
  const v = Number(process.env[name]);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function no(reasoning: string, evaluations: SetupEvaluation[] = []): ScalperSignal {
  return { direction: "NO_TRADE", entry: null, stopLoss: null, takeProfit: null, riskReward: null, setup: null, slPlan: null, reasoning, evaluations };
}
function blockedByFilter(reason: string): SetupEvaluation[] {
  return [{ setup: "filtri", status: "rejected", reason }];
}
function hoursAllowed(now = new Date()) {
  const raw = process.env.SCALPER_HOURS_UTC?.trim() || "06:30-20:30";
  const [a, b] = raw.split("-");
  const mins = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  if (!a || !b) return true;
  const start = mins(a), end = mins(b);
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (start === end) return true;
  return start < end ? cur >= start && cur <= end : cur >= start || cur <= end;
}
function bullish(c: Candle) { return c.close > c.open; }
function bearish(c: Candle) { return c.close < c.open; }
function candleRange(c: Candle) { return Math.max(0.01, c.high - c.low); }
function bodyRatio(c: Candle) { return Math.abs(c.close - c.open) / candleRange(c); }
function isClosed(c: Candle, minutes: number, nowMs: number) {
  const startedAt = Date.parse(c.datetime);
  return Number.isFinite(startedAt) && startedAt + minutes * 60_000 <= nowMs;
}

export function evaluateScalper(input: { quote: Quote; m1: Candle[]; m5: Candle[] }): ScalperSignal {
  const { quote, m1, m5 } = input;
  if (!hoursAllowed()) {
    const reason = `Fuori fascia scalper ${process.env.SCALPER_HOURS_UTC || "06:30-20:30"} UTC.`;
    return no(reason, blockedByFilter(reason));
  }
  if (m1.length < 35 || m5.length < 30) return no("Storico M1/M5 insufficiente.", blockedByFilter("Storico M1/M5 insufficiente."));

  const maxSpread = envN("SCALPER_MAX_SPREAD", 1.2);
  if (quote.spread > maxSpread) {
    const reason = `Spread ${quote.spread.toFixed(2)}$ sopra massimo ${maxSpread.toFixed(2)}$.`;
    return no(reason, blockedByFilter(reason));
  }

  const atr1 = atr(m1, 14, true);
  if (!atr1) return no("ATR M1 non disponibile.", blockedByFilter("ATR M1 non disponibile."));
  const minAtr = envN("SCALPER_MIN_ATR_M1", 0.8), maxAtr = envN("SCALPER_MAX_ATR_M1", 6);
  if (atr1 < minAtr) {
    const reason = `Volatilità M1 troppo bassa: ATR ${atr1.toFixed(2)}$.`;
    return no(reason, blockedByFilter(reason));
  }
  if (atr1 > maxAtr) {
    const reason = `Volatilità M1 troppo alta: ATR ${atr1.toFixed(2)}$.`;
    return no(reason, blockedByFilter(reason));
  }

  const last = m1[m1.length - 1], prev = m1[m1.length - 2];
  const shockThreshold = Math.max(atr1 * envN("SHOCK_ATR_MULT", 2.2), 5.5);
  const isShock = (candle: Candle) => candle.high - candle.low > shockThreshold;
  if (isShock(last)) {
    const reason = `Candela M1 shock ${(last.high - last.low).toFixed(2)}$: niente inseguimento, attendo il retest.`;
    return no(reason, blockedByFilter(reason));
  }

  const nowMs = quote.quotedAt ?? Date.now();
  const closedM5 = m5.filter((c) => isClosed(c, 5, nowMs));
  if (closedM5.length < 30) return no("Storico M5 chiuso insufficiente.", blockedByFilter("Storico M5 chiuso insufficiente."));

  const fast5Series = emaCloseSeries(closedM5, 9), slow5Series = emaCloseSeries(closedM5, 21);
  const fast5 = fast5Series.at(-1) ?? null, slow5 = slow5Series.at(-1) ?? null;
  const atr5 = atr(closedM5, 14, true);
  const fast1Series = emaCloseSeries(m1, 9), slow1Series = emaCloseSeries(m1, 20);
  const fast1 = fast1Series[m1.length - 1], slow1 = slow1Series[m1.length - 1];
  if ([fast5, slow5, atr5, fast1, slow1].some(v => v === null)) return no("EMA/ATR non disponibili.", blockedByFilter("EMA/ATR non disponibili."));

  const m5SlopeBars = envI("M5_SLOPE_BARS", 3, 1, 12);
  const slopeIdx = closedM5.length - 1 - m5SlopeBars;
  const fast5Past = slopeIdx >= 0 ? fast5Series[slopeIdx] : null;
  const minSepAtr = envN("M5_MIN_EMA_SEP_ATR", 0.08);
  const pullbackSlopeAtr = envN("M5_PULLBACK_SLOPE_ATR", 0.08);
  const emaSep = Math.abs(fast5! - slow5!);
  const separated = emaSep >= atr5! * minSepAtr;
  const trendUp = separated && fast5! > slow5!
    && fast5Past !== null && fast5! >= fast5Past - atr5! * pullbackSlopeAtr;
  const trendDown = separated && fast5! < slow5!
    && fast5Past !== null && fast5! <= fast5Past + atr5! * pullbackSlopeAtr;

  const alignBars = envI("M1_ALIGN_BARS", 3, 1, 20);
  const alignFast = fast1Series.slice(m1.length - alignBars);
  const alignSlow = slow1Series.slice(m1.length - alignBars);
  const alignReady = alignFast.length === alignBars && alignFast.every(v => v !== null) && alignSlow.every(v => v !== null);
  const alignedUp = alignReady && alignFast.every((v, i) => v! > alignSlow[i]!);
  const alignedDown = alignReady && alignFast.every((v, i) => v! < alignSlow[i]!);
  const priceAbove = last.close > fast1! && last.close > slow1!;
  const priceBelow = last.close < fast1! && last.close < slow1!;

  const accelBars = envI("ACCEL_BARS", 3, 2, 10);
  const accelAtrMult = envN("ACCEL_ATR_MULT", 1.2);
  const accelBodyMin = envN("ACCEL_BODY_RATIO", 0.6);
  const accelSlice = m1.slice(m1.length - accelBars);
  const accelRangeAvg = accelSlice.reduce((sum, c) => sum + (c.high - c.low), 0) / accelSlice.length;
  const accelFast = accelRangeAvg >= atr1 * accelAtrMult;
  const accelBodies = accelSlice.every(c => bodyRatio(c) >= accelBodyMin);
  const accelUp = accelFast && accelBodies && accelSlice.every(bullish);
  const accelDown = accelFast && accelBodies && accelSlice.every(bearish);

  const transitionUp = trendDown && alignedUp && priceAbove && accelUp;
  const transitionDown = trendUp && alignedDown && priceBelow && accelDown;

  const rangeLookback = envI("RANGE_LOOKBACK", 12, 4, 60);
  const rangeBars = m1.slice(Math.max(0, m1.length - rangeLookback - 1), m1.length - 1);
  const rangeHigh = Math.max(...rangeBars.map(c => c.high));
  const rangeLow = Math.min(...rangeBars.map(c => c.low));
  const rangeWidth = Math.max(0.01, rangeHigh - rangeLow);
  const rangeAtrMult = envN("RANGE_ATR_MULT", 1.5);
  const slopeBars = envI("EMA_SLOPE_BARS", 5, 2, 30);
  const flatSlopeAtr = envN("EMA_FLAT_SLOPE_ATR", 0.12);
  const slopeOf = (series: (number | null)[]) => {
    const head = series[m1.length - 1], tail = series[m1.length - 1 - slopeBars];
    return head === null || head === undefined || tail === null || tail === undefined ? null : Math.abs(head - tail);
  };
  const fastSlope = slopeOf(fast1Series), slowSlope = slopeOf(slow1Series);
  const emaFlat = fastSlope !== null && slowSlope !== null
    && fastSlope <= atr1 * flatSlopeAtr && slowSlope <= atr1 * flatSlopeAtr;
  const rangeCompressed = rangeWidth < atr1 * rangeAtrMult && emaFlat;

  let grossMove = 0;
  for (let i = 1; i < rangeBars.length; i++) grossMove += Math.abs(rangeBars[i].close - rangeBars[i - 1].close);
  const netMove = rangeBars.length >= 2 ? Math.abs(rangeBars.at(-1)!.close - rangeBars[0].close) : 0;
  const rangeEfficiency = grossMove > 0 ? netMove / grossMove : 0;
  const maxRangeEfficiency = envN("RANGE_MAX_EFFICIENCY", 0.32);
  const structuralRange = !trendUp && !trendDown && rangeBars.length >= 8 && rangeEfficiency <= maxRangeEfficiency;
  const marketRange = rangeCompressed || structuralRange;
  const rawRangePosition = (quote.mid - rangeLow) / rangeWidth;
  const rangePosition = Math.min(1, Math.max(0, rawRangePosition));
  const rangeEdge = envN("RANGE_EDGE_FRACTION", 0.32);

  const m5Label = transitionUp ? "transizione rialzista"
    : transitionDown ? "transizione ribassista"
      : marketRange ? "range"
        : trendUp ? "rialzista"
          : trendDown ? "ribassista" : "transizione/neutro";

  type GateLevel = "accelerata" | "struttura";
  const m5Gate = (direction: "BUY" | "SELL", level: GateLevel): string | null => {
    if (direction === "BUY" && trendDown && !transitionUp) return "bias M5 chiuso ribassista contrario al long";
    if (direction === "SELL" && trendUp && !transitionDown) return "bias M5 chiuso rialzista contrario allo short";
    const alignedTrend = (direction === "BUY" && trendUp) || (direction === "SELL" && trendDown);
    if (alignedTrend) return null;
    const structure = direction === "BUY" ? alignedUp && priceAbove : alignedDown && priceBelow;
    if (!structure) {
      const emaOk = direction === "BUY" ? alignedUp : alignedDown;
      return `${m5Label}: M1 non conferma ${direction} (${emaOk ? "prezzo non dal lato giusto delle EMA M1" : `EMA9/EMA20 M1 non allineate da ${alignBars} candele`})`;
    }
    if (level === "struttura") return null;
    const accel = direction === "BUY" ? accelUp : accelDown;
    if (!accel) {
      const missing = !accelFast
        ? `range medio ${accelRangeAvg.toFixed(2)}$ < ${(atr1 * accelAtrMult).toFixed(2)}$`
        : !accelBodies ? `corpi sotto il ${(accelBodyMin * 100).toFixed(0)}% del range` : "candele non tutte nella stessa direzione";
      return `${m5Label}: manca accelerazione M1 ${direction} (${missing})`;
    }
    return null;
  };

  const gateForSetup = (direction: "BUY" | "SELL", setup: ScalperSetup): string | null => {
    if (marketRange) {
      const atEdge = direction === "BUY" ? rangePosition <= rangeEdge : rangePosition >= 1 - rangeEdge;
      if (setup === "liquidity_sweep" && atEdge) return null;
      const where = `${(rangePosition * 100).toFixed(0)}% del range ${rangeLow.toFixed(2)}$-${rangeHigh.toFixed(2)}$`;
      return setup === "liquidity_sweep"
        ? `regime RANGE: sweep ${direction} fuori dal bordo utile (${where})`
        : `regime RANGE: ${setup} bloccato (${where}), attendo bordo o breakout+retest`;
    }
    const level: GateLevel = setup === "momentum_breakout" || setup === "micro_pullback" ? "accelerata" : "struttura";
    return m5Gate(direction, level);
  };

  type Candidate = { setup: ScalperSetup; direction: "BUY" | "SELL"; structureStop: number; score: number };
  const evaluations: SetupEvaluation[] = [];
  const candidates: Candidate[] = [];
  const record = (setup: ScalperSetup, status: "triggered" | "rejected", reason: string, direction?: "BUY" | "SELL") => {
    evaluations.push(direction ? { setup, status, direction, reason } : { setup, status, reason });
  };
  const scoreCandidate = (setup: ScalperSetup, direction: "BUY" | "SELL") => {
    const base = setup === "breakout_retest" ? 78 : setup === "micro_pullback" ? 76 : setup === "liquidity_sweep" ? 74 : 72;
    const alignedTrend = (direction === "BUY" && trendUp) || (direction === "SELL" && trendDown);
    const structure = direction === "BUY" ? alignedUp && priceAbove : alignedDown && priceBelow;
    const liveAligned = direction === "BUY" ? bullish(last) : bearish(last);
    let score = base + (alignedTrend ? 16 : 0) + (structure ? 8 : 0) + (liveAligned ? 5 : 0);
    if (marketRange && setup === "liquidity_sweep") score += 14;
    if ((transitionUp && direction === "BUY") || (transitionDown && direction === "SELL")) score += 8;
    return score;
  };
  const addCandidate = (setup: ScalperSetup, direction: "BUY" | "SELL", structureStop: number) => {
    candidates.push({ setup, direction, structureStop, score: scoreCandidate(setup, direction) });
  };

  const breakoutLookback = envI("BREAKOUT_LOOKBACK", 12, 5, 60);
  const breakoutBody = bodyRatio(prev);

  {
    let low = Infinity, high = -Infinity;
    for (let i = Math.max(0, m1.length - 10); i < Math.max(0, m1.length - 2); i++) {
      low = Math.min(low, m1[i].low);
      high = Math.max(high, m1[i].high);
    }
    const buy = prev.low < low && prev.close > low && last.close > prev.high && bullish(last);
    const sell = prev.high > high && prev.close < high && last.close < prev.low && bearish(last);
    if (!buy && !sell) {
      record("liquidity_sweep", "rejected", `nessuno sweep dei minimi ${low.toFixed(2)}$ / massimi ${high.toFixed(2)}$ con rientro`);
    } else {
      const direction = buy ? "BUY" : "SELL";
      const blocked = gateForSetup(direction, "liquidity_sweep");
      if (blocked) record("liquidity_sweep", "rejected", blocked, direction);
      else {
        const structureStop = direction === "BUY" ? prev.low - 0.25 : prev.high + 0.25;
        addCandidate("liquidity_sweep", direction, structureStop);
        record("liquidity_sweep", "triggered", `sweep ${direction === "BUY" ? "dei minimi" : "dei massimi"} con rientro (regime ${m5Label})`, direction);
      }
    }
  }

  {
    const bodyMin = envN("BREAKOUT_BODY_RATIO", 0.6);
    const closeMult = envN("BREAKOUT_CLOSE_ATR_MULT", 0.15);
    const maxExtMult = envN("BREAKOUT_MAX_EXT_ATR", 1.5);
    const maxRetraceAtr = envN("BREAKOUT_MAX_RETRACE_ATR", 0.35);
    const breakIdx = m1.length - 2;
    const windowStart = breakIdx - breakoutLookback;
    if (windowStart < 0) {
      record("momentum_breakout", "rejected", `storico M1 insufficiente (servono ${breakoutLookback + 2} candele)`);
    } else {
      const window = m1.slice(windowStart, breakIdx);
      const high = Math.max(...window.map(c => c.high));
      const low = Math.min(...window.map(c => c.low));
      const buffer = atr1 * closeMult;
      const brokeUp = bullish(prev) && prev.close >= high + buffer;
      const brokeDown = bearish(prev) && prev.close <= low - buffer;
      if (!brokeUp && !brokeDown) {
        record("momentum_breakout", "rejected",
          `chiusura ${prev.close.toFixed(2)}$ dentro il canale ${breakoutLookback} candele ${low.toFixed(2)}$-${high.toFixed(2)}$ (serve oltre ${buffer.toFixed(2)}$)`);
      } else {
        const direction = brokeUp ? "BUY" : "SELL";
        const emaAt = fast1Series[breakIdx], emaSlowAt = slow1Series[breakIdx];
        const emaOk = emaAt !== null && emaSlowAt !== null && (direction === "BUY" ? emaAt > emaSlowAt : emaAt < emaSlowAt);
        const frozenLevel = direction === "BUY" ? high : low;
        const livePrice = direction === "BUY" ? quote.bid : quote.ask;
        const holds = direction === "BUY" ? livePrice > frozenLevel : livePrice < frozenLevel;
        const extensionAtBreak = direction === "BUY" ? prev.close - frozenLevel : frozenLevel - prev.close;
        const liveExtension = direction === "BUY" ? quote.ask - frozenLevel : frozenLevel - quote.bid;
        const maxExtension = atr1 * maxExtMult;
        const currentAligned = direction === "BUY"
          ? bullish(last) && last.close >= prev.close - atr1 * 0.10
          : bearish(last) && last.close <= prev.close + atr1 * 0.10;
        const rejection = direction === "BUY" ? last.high - quote.bid : quote.ask - last.low;
        const missing: string[] = [];
        if (extensionAtBreak > maxExtension) missing.push(`breakout già esteso: ${extensionAtBreak.toFixed(2)}$ oltre il livello, massimo ${maxExtension.toFixed(2)}$`);
        if (liveExtension > maxExtension) missing.push(`prezzo live troppo lontano dal livello congelato ${frozenLevel.toFixed(2)}$: ${liveExtension.toFixed(2)}$ > ${maxExtension.toFixed(2)}$`);
        if (breakoutBody < bodyMin) missing.push(`corpo ${(breakoutBody * 100).toFixed(0)}% sotto il ${(bodyMin * 100).toFixed(0)}% del range`);
        if (!emaOk) missing.push(`EMA9/EMA20 M1 non allineate ${direction}`);
        if (!holds) missing.push(`prezzo live rientrato oltre il livello congelato ${frozenLevel.toFixed(2)}$`);
        if (!currentAligned) missing.push(`candela M1 live non sta piu' spingendo ${direction}`);
        if (rejection > atr1 * maxRetraceAtr) missing.push(`rigetto dall'estremo ${rejection.toFixed(2)}$ > ${(atr1 * maxRetraceAtr).toFixed(2)}$`);
        const blocked = gateForSetup(direction, "momentum_breakout");
        if (blocked) missing.push(blocked);
        if (missing.length > 0) record("momentum_breakout", "rejected", missing.join("; "), direction);
        else {
          const structureStop = direction === "BUY" ? prev.low - 0.25 : prev.high + 0.25;
          addCandidate("momentum_breakout", direction, structureStop);
          record("momentum_breakout", "triggered",
            `rottura ${direction === "BUY" ? "del massimo" : "del minimo"} congelato ${frozenLevel.toFixed(2)}$ con conferma live (regime ${m5Label})`, direction);
        }
      }
    }
  }

  {
    const retestMaxBars = envI("RETEST_MAX_BARS", 4, 2, 12);
    const retestZoneAtr = envN("RETEST_ZONE_ATR", 0.5);
    const entryIdx = m1.length - 1;
    let shockIdx = -1;
    for (let offset = 2; offset <= retestMaxBars; offset++) {
      const index = entryIdx - offset;
      if (index < 1) break;
      if (isShock(m1[index])) { shockIdx = index; break; }
    }
    if (shockIdx < 0) {
      record("breakout_retest", "rejected", `nessuna candela shock (> ${shockThreshold.toFixed(2)}$) nelle ultime ${retestMaxBars} candele M1`);
    } else {
      const shock = m1[shockIdx];
      const direction: "BUY" | "SELL" | null = bullish(shock) ? "BUY" : bearish(shock) ? "SELL" : null;
      const windowStart = Math.max(0, shockIdx - breakoutLookback);
      const window = m1.slice(windowStart, shockIdx);
      const retest = m1.slice(shockIdx + 1, entryIdx);
      if (!direction || window.length < 3 || retest.length < 1) {
        record("breakout_retest", "rejected", "candela shock senza direzione o storico di retest insufficiente");
      } else {
        const level = direction === "BUY" ? Math.max(...window.map(c => c.high)) : Math.min(...window.map(c => c.low));
        const ema9 = fast1Series[entryIdx - 1] ?? fast1!;
        const anchor = direction === "BUY" ? Math.max(level, ema9) : Math.min(level, ema9);
        const zone = atr1 * retestZoneAtr;
        const retestLow = Math.min(...retest.map(c => c.low));
        const retestHigh = Math.max(...retest.map(c => c.high));
        const broke = direction === "BUY" ? shock.close > level : shock.close < level;
        const pulled = direction === "BUY" ? retestLow <= anchor + zone : retestHigh >= anchor - zone;
        const heldLevel = direction === "BUY"
          ? retest.every(c => c.close > level) && last.close > level
          : retest.every(c => c.close < level) && last.close < level;
        const restartBody = envN("RETEST_BODY_RATIO", 0.5);
        const restart = bodyRatio(last) >= restartBody && (direction === "BUY"
          ? bullish(last) && last.close > prev.close && last.close > ema9
          : bearish(last) && last.close < prev.close && last.close < ema9);
        const missing: string[] = [];
        if (!broke) missing.push(`la shock non ha rotto il livello ${level.toFixed(2)}$`);
        if (!pulled) missing.push(`nessun ritracciamento verso ${anchor.toFixed(2)}$ (min/max retest ${(direction === "BUY" ? retestLow : retestHigh).toFixed(2)}$)`);
        if (!heldLevel) missing.push(`livello ${level.toFixed(2)}$ chiuso dall'altra parte durante il retest`);
        if (!restart) missing.push(`nessun riavvio ${direction} oltre ${prev.close.toFixed(2)}$ con corpo pieno dal lato giusto dell'EMA9`);
        const blocked = gateForSetup(direction, "breakout_retest");
        if (blocked) missing.push(blocked);
        if (missing.length > 0) record("breakout_retest", "rejected", missing.join("; "), direction);
        else {
          const structureStop = direction === "BUY"
            ? Math.min(retestLow, last.low) - 0.25
            : Math.max(retestHigh, last.high) + 0.25;
          addCandidate("breakout_retest", direction, structureStop);
          record("breakout_retest", "triggered",
            `retest del livello ${level.toFixed(2)}$ dopo shock ${(shock.high - shock.low).toFixed(2)}$ e riavvio ${direction} (regime ${m5Label})`, direction);
        }
      }
    }
  }

  {
    const buy = prev.low <= fast1! && last.close > fast1! && bullish(last) && last.close > prev.close;
    const sell = prev.high >= fast1! && last.close < fast1! && bearish(last) && last.close < prev.close;
    if (!buy && !sell) {
      record("micro_pullback", "rejected", `nessun rientro su EMA9 M1 ${fast1!.toFixed(2)}$ con candela di ripartenza`);
    } else {
      const direction = buy ? "BUY" : "SELL";
      const blocked = gateForSetup(direction, "micro_pullback");
      if (blocked) record("micro_pullback", "rejected", blocked, direction);
      else {
        const structureStop = direction === "BUY" ? Math.min(prev.low, last.low) - 0.25 : Math.max(prev.high, last.high) + 0.25;
        addCandidate("micro_pullback", direction, structureStop);
        record("micro_pullback", "triggered", `rientro su EMA9 M1 e ripartenza ${direction} (regime ${m5Label})`, direction);
      }
    }
  }

  const chosen = [...candidates].sort((a, b) => b.score - a.score)[0];
  if (!chosen) {
    return no(
      `Nessun trigger scalper M1. Regime ${m5Label}; ATR M1 ${atr1.toFixed(2)}$; efficienza range ${(rangeEfficiency * 100).toFixed(0)}%. `
      + evaluations.map(e => `${e.setup}${e.direction ? ` ${e.direction}` : ""}: ${e.reason}`).join(" | "),
      evaluations,
    );
  }

  const { direction, setup, structureStop } = chosen;
  const entry = direction === "BUY" ? quote.ask : quote.bid;
  const structuralRisk = Math.abs(entry - structureStop);
  const slAtrMult = envN("SL_ATR_MULT", 1.3);
  const slMinUsd = envN("SL_MIN_USD", 3);
  const slMaxUsd = envN("SL_MAX_USD", 8);
  const atrRisk = atr1 * slAtrMult;
  const risk = Math.max(structuralRisk, atrRisk, slMinUsd);
  const rr = envN("TP_RR", 1.5);
  if (risk > slMaxUsd) {
    const detail = `SL troppo ampio: servono ${risk.toFixed(2)}$ (struttura ${structuralRisk.toFixed(2)}$, ATR ${atrRisk.toFixed(2)}$, minimo ${slMinUsd.toFixed(2)}$)`
      + ` sopra il massimo ${slMaxUsd.toFixed(2)}$`;
    const chosenIndex = evaluations.findIndex((item) => item.setup === setup && item.status === "triggered" && item.direction === direction);
    if (chosenIndex >= 0) {
      evaluations[chosenIndex] = { ...evaluations[chosenIndex], status: "rejected", reason: `${evaluations[chosenIndex].reason} — ${detail}` };
    }
    return no(`${detail}. Setup ${setup} ${direction} scartato.`, evaluations);
  }
  const stopLoss = direction === "BUY" ? entry - risk : entry + risk;
  const takeProfit = direction === "BUY" ? entry + risk * rr : entry - risk * rr;
  const slPlan = {
    structural: Number(structuralRisk.toFixed(2)),
    atr: Number(atrRisk.toFixed(2)),
    applied: Number(risk.toFixed(2)),
    minUsd: slMinUsd,
    maxUsd: slMaxUsd,
    rr,
  };

  const alignedTrend = (direction === "BUY" && trendUp) || (direction === "SELL" && trendDown);
  const trendScore = alignedTrend ? 20 : marketRange && setup === "liquidity_sweep" ? 18 : 12;
  const lastBody = bodyRatio(last);
  const moveAtr = Math.abs(last.close - prev.close) / atr1;
  const triggerScore = setup === "liquidity_sweep"
    ? Math.min(25, 20 + Math.round(Math.min(1, lastBody) * 5))
    : setup === "momentum_breakout"
      ? Math.min(25, 18 + Math.round(Math.min(1, breakoutBody) * 7))
      : setup === "breakout_retest"
        ? Math.min(25, 18 + Math.round(Math.min(1, lastBody) * 7))
        : Math.min(25, 15 + Math.round(Math.min(0.5, moveAtr) * 20));
  const accumulationScore = marketRange && setup !== "liquidity_sweep" ? 5 : marketRange ? 14 : 15;
  const atrScore = atr1 >= 1.2 && atr1 <= 3.5 ? 10 : atr1 >= 1.0 && atr1 <= 4.5 ? 8 : 5;
  const spreadRatio = maxSpread > 0 ? quote.spread / maxSpread : 1;
  const spreadScore = spreadRatio <= 0.35 ? 10 : spreadRatio <= 0.6 ? 8 : spreadRatio <= 0.8 ? 6 : 4;
  const structureScore = structuralRisk >= atrRisk ? 10 : structuralRisk >= atrRisk * 0.6 ? 8 : 5;
  const candleScore = lastBody >= 0.65 ? 10 : lastBody >= 0.45 ? 8 : lastBody >= 0.3 ? 6 : 4;
  const qualityScore = Math.min(100, Math.max(0,
    trendScore + triggerScore + accumulationScore + atrScore + spreadScore + structureScore + candleScore,
  ));
  const scoreBreakdown = `regime ${trendScore}, trigger ${triggerScore}, range ${accumulationScore}, ATR ${atrScore}, spread ${spreadScore}, SL ${structureScore}, candela ${candleScore}`;

  return {
    direction, setup, slPlan,
    entry: Number(entry.toFixed(2)), stopLoss: Number(stopLoss.toFixed(2)), takeProfit: Number(takeProfit.toFixed(2)), riskReward: Number(rr.toFixed(2)),
    evaluations,
    reasoning: `${setupLabel(setup)} M1 ${direction}. Regime ${m5Label} da M5 chiuse; candidate score ${chosen.score}. ATR M1 ${atr1.toFixed(2)}$, spread ${quote.spread.toFixed(2)}$.`
      + ` SL ${risk.toFixed(2)}$ (struttura ${structuralRisk.toFixed(2)}$, ATR x${slAtrMult} ${atrRisk.toFixed(2)}$), TP ${(risk * rr).toFixed(2)}$ a ${rr}R.`
      + ` Shadow score ${qualityScore}/100 (${scoreBreakdown}). [shadow-score:${qualityScore}]`
  };
}

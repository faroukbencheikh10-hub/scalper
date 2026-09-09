import type { Candle, Quote, ScalperSignal, SetupEvaluation } from "../types";
import { atr, emaCloseSeries } from "./indicators";
import { aggregateM15, closedBars, MINUTE, swingLevels } from "./marketStructure";
import { getSessionStatus, parseSessionHours, sessionConfigFromEnv } from "../session";

export const STRATEGY_VERSION = "mtf-continuation-v1";

function env(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name]?.trim(), value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}
function reject(reason: string, evaluations?: SetupEvaluation[]): ScalperSignal {
  return { direction: "NO_TRADE", setup: null, setupKey: null, entry: null, stopLoss: null,
    takeProfit: null, riskReward: null, slPlan: null, reasoning: reason,
    evaluations: evaluations ?? [{ setup: "filtri", status: "rejected", reason }] };
}
function range(c: Candle) { return Math.max(0.001, c.high - c.low); }
function body(c: Candle) { return Math.abs(c.close - c.open) / range(c); }
function maxHigh(bars: Candle[]) { return Math.max(...bars.map(c => c.high)); }
function minLow(bars: Candle[]) { return Math.min(...bars.map(c => c.low)); }
function signed(direction: "BUY" | "SELL", value: number) { return direction === "BUY" ? value : -value; }

function expectedXauClosureGap(previousStartMs: number, nextStartMs: number, sizeMs: number) {
  const missingFrom = previousStartMs + sizeMs;
  if (missingFrom >= nextStartMs) return false;
  const from = new Date(missingFrom);
  const dayStart = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const closureStart = dayStart + 21 * 60 * MINUTE;
  const reopen = from.getUTCDay() === 5
    ? dayStart + (2 * 24 + 22) * 60 * MINUTE
    : dayStart + 22 * 60 * MINUTE;
  if (from.getUTCDay() !== 5 && (from.getUTCDay() < 1 || from.getUTCDay() > 4)) return false;
  // Around a reopen, the broker may omit the boundary bucket itself. Permit at most
  // one timeframe of alignment slack on each side, but only when the gap spans the
  // known XAUUSD closure. Arbitrary intraday gaps still fail continuity.
  return missingFrom >= closureStart - sizeMs
    && missingFrom <= closureStart
    && nextStartMs >= reopen
    && nextStartMs <= reopen + sizeMs;
}

function latestBarFresh(bars: Candle[], minutes: number, nowMs: number, maxAgeMs: number) {
  const last = bars.at(-1);
  if (!last) return false;
  const lastCloseAt = Date.parse(last.datetime) + minutes * MINUTE;
  return Number.isFinite(lastCloseAt) && nowMs - lastCloseAt >= 0 && nowMs - lastCloseAt <= maxAgeMs;
}

function recentBarsReadyWithMarketClosures(bars: Candle[], minutes: number, count: number) {
  const recent = bars.slice(-count), size = minutes * MINUTE;
  if (recent.length < count) return false;
  return recent.every((bar, i) => {
    if (i === 0) return true;
    const previous = Date.parse(recent[i - 1].datetime), current = Date.parse(bar.datetime);
    const gap = current - previous;
    return gap === size || (gap > size && gap % size === 0 && expectedXauClosureGap(previous, current, size));
  });
}

/** Validate the already planned SL/TP at the quote used immediately before sending. */
export function plannedEntryValid(signal: ScalperSignal, quote: Quote) {
  if (signal.direction === "NO_TRADE" || signal.stopLoss === null || signal.takeProfit === null || !signal.slPlan) return false;
  const entry = signal.direction === "BUY" ? quote.ask : quote.bid;
  const risk = signed(signal.direction, entry - signal.stopLoss);
  const reward = signed(signal.direction, signal.takeProfit - entry);
  const cost = signal.slPlan.estimatedCostPrice ?? 0;
  return risk > 0 && risk <= signal.slPlan.maxUsd + 0.011
    && (reward - cost) / (risk + cost) >= (signal.slPlan.minNetR ?? 1.5);
}

/** Pure evaluation: a preview or failed preflight never consumes a setup. */
export function evaluateScalper(input: { quote: Quote; m1: Candle[]; m5: Candle[]; nowMs?: number }): ScalperSignal {
  const { quote } = input;
  const nowMs = input.nowMs ?? Date.now();
  const quoteMaxAge = env("SCALPER_FINAL_QUOTE_MAX_AGE_MS", 2000, 250, 10_000);
  if (!Number.isFinite(nowMs) || quote.quotedAt === null || !Number.isFinite(quote.quotedAt)
    || nowMs - quote.quotedAt > quoteMaxAge || quote.quotedAt > nowMs + 500
    || ![quote.bid, quote.ask, quote.mid, quote.spread].every(Number.isFinite)
    || quote.bid <= 0 || quote.ask < quote.bid || quote.spread < 0) return reject("Quote assente, vecchia o non valida.");
  const spread = quote.ask - quote.bid;
  if (spread > env("SCALPER_MAX_SPREAD", 1.2, 0.01, 10)) return reject("Spread troppo alto: " + spread.toFixed(2) + "$.");

  const sessionConfig = sessionConfigFromEnv();
  if (!parseSessionHours(sessionConfig.hoursUtc)) return reject("Configurazione oraria non valida.");
  const session = getSessionStatus(new Date(nowMs), sessionConfig);
  if (!session.inside || session.inFlattenWindow) return reject(session.blockReason ?? "Fuori sessione.");
  const m1 = closedBars(input.m1, 1, nowMs), m5 = closedBars(input.m5, 5, nowMs);
  if (!m1 || !m5) return reject("Candele non valide, duplicate o fuori ordine.");
  const m15 = aggregateM15(m5);
  if (m1.length < 35 || m5.length < 35 || m15.length < 30) return reject("Storico insufficiente: servono M1/M5 e almeno 30 M15 complete.");
  if (!latestBarFresh(m1, 1, nowMs, 3 * MINUTE)
    || !recentBarsReadyWithMarketClosures(m5, 5, 10)
    || !recentBarsReadyWithMarketClosures(m15, 15, 8)) return reject("Storico recente M1/M5/M15 incompleto o non aggiornato: attendo continuità dei dati.");
  const warmup = env("SCALPER_SESSION_WARMUP_MIN", 5, 0, 30) * MINUTE;
  if (session.sessionStartAt && nowMs < Date.parse(session.sessionStartAt) + warmup) return reject("Warm-up nuova sessione: attendo la prima M5 chiusa.");

  const atr1 = atr(m1, 14, true)!, atr5 = atr(m5, 14, true)!, atr15 = atr(m15, 14, true)!;
  if (!(atr1 > 0 && atr5 > 0 && atr15 > 0)) return reject("ATR non disponibile.");
  if (atr1 < env("SCALPER_MIN_ATR_M1", 0.8, 0.01, 20)
    || atr1 > env("SCALPER_MAX_ATR_M1", 6, 0.1, 100)) return reject("Volatilità M1 fuori limiti: ATR " + atr1.toFixed(2) + "$.");

  const fast15 = emaCloseSeries(m15, 9), slow15 = emaCloseSeries(m15, 21);
  const fast = fast15.at(-1)!, slow = slow15.at(-1)!;
  const slope = fast! - fast15.at(-4)!;
  const older = m15.slice(-6, -3), newer = m15.slice(-3), structureBuffer = atr15 * 0.05;
  const rising = maxHigh(newer) > maxHigh(older) + structureBuffer && minLow(newer) > minLow(older) + structureBuffer;
  const falling = maxHigh(newer) < maxHigh(older) - structureBuffer && minLow(newer) < minLow(older) - structureBuffer;
  const window15 = m15.slice(-8);
  let travel = 0;
  for (let i = 1; i < window15.length; i++) travel += Math.abs(window15[i].close - window15[i - 1].close);
  const efficiency = travel > 0 ? Math.abs(window15.at(-1)!.close - window15[0].close) / travel : 0;
  const sep = Math.abs(fast! - slow!) / atr15, last15 = m15.at(-1)!;
  let direction: "BUY" | "SELL" | null = null;
  if (sep >= env("MTF_M15_MIN_SEP_ATR", 0.08, 0, 2) && efficiency >= env("MTF_M15_MIN_EFFICIENCY", 0.35, 0, 1)) {
    if (rising && fast! > slow! && slope > atr15 * 0.05 && last15.close > slow!) direction = "BUY";
    if (falling && fast! < slow! && slope < -atr15 * 0.05 && last15.close < slow!) direction = "SELL";
  }
  if (!direction) return reject("M15 in range o transizione: manca un trend strutturale confermato.");
  const d = direction;
  const fast5 = emaCloseSeries(m5, 9), slow5 = emaCloseSeries(m5, 21);
  if (signed(d, fast5.at(-1)! - slow5.at(-1)!) <= 0
    || signed(d, m5.at(-1)!.close - slow5.at(-1)!) < -atr5 * 0.25) return reject("M15 " + d + ", ma M5 contrario o struttura del pullback rotta.");

  const trigger = m1.at(-1)!, forming = input.m1.at(-1)!;
  const shock = env("SHOCK_ATR_MULT", 2.2, 1, 10) * atr1;
  if (range(trigger) > shock || (Date.parse(forming.datetime) + MINUTE > nowMs && range(forming) > shock)) return reject("Candela M1 shock: attendo un nuovo setup, nessun inseguimento.");
  const preceding = m1.slice(-3, -1);
  const triggerLevel = d === "BUY" ? maxHigh(preceding) : minLow(preceding);
  if (signed(d, trigger.close - trigger.open) <= 0 || body(trigger) < env("MTF_M1_BODY_MIN", 0.45, 0.1, 0.95)
    || signed(d, trigger.close - triggerLevel) < atr1 * 0.03) return reject("M15 " + d + ": attendo chiusura M1 di ripartenza oltre la microstruttura.");
  const entry = d === "BUY" ? quote.ask : quote.bid;
  const exitQuote = d === "BUY" ? quote.bid : quote.ask;
  const drift = signed(d, entry - trigger.close);
  if (drift > atr1 * env("MTF_MAX_CHASE_ATR", 0.45, 0.05, 2)
    || signed(d, exitQuote - triggerLevel) < -atr1 * 0.1) return reject("Conferma M1 persa o ingresso già troppo esteso.");

  // A directional M5 impulse followed by an actual retracement defines one persistent setup.
  const lookback = Math.floor(env("MTF_M5_SETUP_BARS", 6, 2, 12));
  const evaluations: SetupEvaluation[] = [];
  for (let i = m5.length - 2; i >= Math.max(21, m5.length - 1 - lookback); i--) {
    const impulse = m5[i], tail = m5.slice(i + 1);
    if (signed(d, impulse.close - impulse.open) <= 0 || body(impulse) < 0.5 || range(impulse) < atr5 * 0.8) continue;
    const breakoutLevel = d === "BUY" ? maxHigh(m5.slice(i - 4, i)) : minLow(m5.slice(i - 4, i));
    const brokeLevel = signed(d, impulse.close - breakoutLevel) > atr5 * 0.05;
    if (!brokeLevel && signed(d, impulse.close - fast5[i]!) < atr5 * 0.4) continue;
    const pbOffset = tail.findIndex((bar, index) => signed(d, bar.close - bar.open) < 0
      && signed(d, bar.close - (index ? tail[index - 1].close : impulse.close)) < 0);
    if (pbOffset < 0) continue;
    const pullback = tail.slice(pbOffset), firstPullback = pullback[0];
    if (Date.parse(trigger.datetime) < Date.parse(firstPullback.datetime) + 5 * MINUTE) continue;
    const extreme = d === "BUY" ? impulse.high : impulse.low;
    const invalidation = d === "BUY" ? impulse.low : impulse.high;
    if (pullback.some(bar => signed(d, bar.close - invalidation) < -atr5 * 0.1
      || signed(d, bar.close - extreme) > atr5 * 0.1)) continue;
    const zone = atr5 * env("MTF_M5_ZONE_ATR", 0.3, 0.05, 1);
    const touches = (bar: Candle, level: number) => bar.low <= level + zone && bar.high >= level - zone;
    const retest = brokeLevel && pullback.some(bar => touches(bar, breakoutLevel));
    const emaTouch = pullback.some((bar, j) => touches(bar, fast5[i + 1 + pbOffset + j]!));
    if (!retest && !emaTouch) continue;
    const setup = retest ? "breakout_retest" : "micro_pullback";
    const key = [STRATEGY_VERSION, d, impulse.datetime, firstPullback.datetime].join(":");
    const stopBuffer = Math.max(spread, atr1 * 0.15);
    const structureStop = d === "BUY" ? Math.min(minLow(pullback), minLow(m1.slice(-3))) - stopBuffer
      : Math.max(maxHigh(pullback), maxHigh(m1.slice(-3))) + stopBuffer;
    const structural = signed(d, entry - structureStop);
    const minUsd = env("SL_MIN_USD", 3, 0.1, 50), maxUsd = env("SL_MAX_USD", 8, 0.1, 100);
    const atrRisk = atr1 * env("SL_ATR_MULT", 1.3, 0.5, 5);
    const risk = Math.max(structural, atrRisk, minUsd);
    if (structural <= 0 || risk > maxUsd || spread / risk > env("MTF_MAX_SPREAD_RISK", 0.2, 0.01, 0.5)) {
      evaluations.push({ setup, direction: d, status: "rejected", reason: "SL o costi eccessivi: rischio " + risk.toFixed(2) + "$, spread " + spread.toFixed(2) + "$." });
      continue;
    }
    // Spread is in the bid/ask entry already. These are additional estimated costs, in price units.
    const cost = env("MTF_ROUNDTRIP_COMMISSION_PER_LOT_USD", 7, 0, 100) / 100
      + atr1 * env("MTF_SLIPPAGE_ATR", 0.05, 0, 1);
    const minNetR = env("MTF_MIN_NET_RR", 1.5, 1, 5), targetR = env("MTF_TARGET_RR", 2, 1.5, 5);
    const levels = [extreme, ...swingLevels(m5.slice(-60), d), ...swingLevels(m15.slice(-60), d)];
    const distances = levels.map(level => signed(d, level - entry)).filter(distance => distance > 0);
    const available = distances.length ? Math.min(...distances) - Math.max(spread, atr1 * 0.1) : Infinity;
    const reward = Math.min(risk * targetR, available);
    const sl = d === "BUY" ? Math.floor((entry - risk) * 100) / 100 : Math.ceil((entry + risk) * 100) / 100;
    const tp = d === "BUY" ? Math.floor((entry + reward) * 100) / 100 : Math.ceil((entry - reward) * 100) / 100;
    const appliedRisk = Math.abs(entry - sl), appliedReward = signed(d, tp - entry);
    const netR = (appliedReward - cost) / (appliedRisk + cost);
    if (!Number.isFinite(netR) || appliedRisk > maxUsd + 0.011 || netR < minNetR) {
      evaluations.push({ setup, direction: d, status: "rejected", reason: "Ostacolo M5/M15 troppo vicino: R netto stimato " + netR.toFixed(2) + " < " + minNetR + "." });
      continue;
    }
    const rr = appliedReward / appliedRisk, score = Math.min(95, Math.round(65 + efficiency * 15 + body(trigger) * 10));
    evaluations.push({ setup, direction: d, status: "triggered", reason: "M15 " + d + " → M5 " + setup + " → conferma M1 chiusa." });
    return { direction: d, setup, setupKey: key, entry, stopLoss: sl, takeProfit: tp,
      riskReward: Number(rr.toFixed(2)), slPlan: { structural: Number(structural.toFixed(2)), atr: Number(atrRisk.toFixed(2)),
        applied: Number(appliedRisk.toFixed(2)), minUsd, maxUsd, rr: Number(rr.toFixed(2)), estimatedCostPrice: cost, minNetR }, evaluations,
      reasoning: STRATEGY_VERSION + ": M15 " + d + " con struttura e EMA9/21 coerenti; M5 " + setup + "; conferma M1 " + trigger.datetime + "."
        + " SL strutturale " + appliedRisk.toFixed(2) + "$, TP " + appliedReward.toFixed(2) + "$ (" + rr.toFixed(2) + "R), netto stimato " + netR.toFixed(2) + "R."
        + " Setup " + key + ". [shadow-score:" + score + "]" };
  }
  return reject("M15 " + d + ": attendo un pullback/retest M5 valido con spazio fino al prossimo ostacolo.", evaluations.length ? evaluations : undefined);
}

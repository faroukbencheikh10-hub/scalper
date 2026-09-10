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
  if (!(risk > 0 && reward > 0 && risk <= signal.slPlan.maxUsd + 0.011)) return false;
  if (signal.slPlan.tpMaxUsd !== undefined && reward > signal.slPlan.tpMaxUsd + 0.011) return false;
  // Setup con TP fisso e indipendente dallo SL (m1_short): nessun vincolo di R:R netto.
  if (signal.slPlan.minNetR === undefined) return true;
  return (reward - cost) / (risk + cost) >= signal.slPlan.minNetR;
}

type EvaluateInput = { quote: Quote; m1: Candle[]; m5: Candle[]; nowMs?: number };

/** Pure evaluation: a preview or failed preflight never consumes a setup. */
function evaluateMtfContinuation(input: EvaluateInput): ScalperSignal {
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
  let gateNote = direction
    ? "M15 trend " + direction + " confermato: sep " + sep.toFixed(2) + " ATR15, efficienza " + efficiency.toFixed(2) + "."
    : "";

  // M15_TREND_MODE=soft (default): il contesto M15 non confermato non blocca da solo. Blocca solo il
  // range vero, cioe' una banda di 12 candele che vale pochi ATR con il prezzo dentro; in transizione
  // la direzione la decide il bias M5 (struttura HH/HL o LL/LH piu' lato della EMA20 M5).
  // Con M15_TREND_MODE=strict resta il comportamento precedente.
  if (!direction && (process.env.M15_TREND_MODE?.trim().toLowerCase() ?? "soft") !== "strict") {
    const band = m15.slice(-12), bandHigh = maxHigh(band), bandLow = minLow(band);
    const width = bandHigh - bandLow, widthAtr = width / atr15, price = m5.at(-1)!.close;
    const maxWidthAtr = env("M15_RANGE_BAND_ATR", 3, 0.5, 20);
    const edge = width * env("M15_RANGE_EDGE", 0.15, 0, 0.45);
    const inside = price > bandLow + edge && price < bandHigh - edge;
    const bandDetail = "banda 12 M15 " + width.toFixed(2) + "$ = " + widthAtr.toFixed(2) + " ATR15 (max "
      + maxWidthAtr.toFixed(2) + "), ATR15 " + atr15.toFixed(2) + "$, prezzo " + price.toFixed(2)
      + " in " + bandLow.toFixed(2) + "-" + bandHigh.toFixed(2);
    if (widthAtr <= maxWidthAtr && inside) {
      return reject("M15 in range vero: " + bandDetail + ". Nessun movimento da seguire.");
    }
    const bars = Math.floor(env("M15_BIAS_M5_BARS", 20, 6, 60)), half = Math.floor(bars / 2);
    const previous5 = m5.slice(-bars, -half), recent5 = m5.slice(-half);
    const ema20 = emaCloseSeries(m5, 20).at(-1)!;
    const recentHigh = maxHigh(recent5), previousHigh = maxHigh(previous5);
    const recentLow = minLow(recent5), previousLow = minLow(previous5);
    const bias = recentHigh > previousHigh && recentLow > previousLow && price > ema20 ? "BUY"
      : recentHigh < previousHigh && recentLow < previousLow && price < ema20 ? "SELL" : null;
    const biasDetail = "M5 " + bars + " candele: max " + recentHigh.toFixed(2) + " vs " + previousHigh.toFixed(2)
      + ", min " + recentLow.toFixed(2) + " vs " + previousLow.toFixed(2)
      + ", prezzo " + price.toFixed(2) + " vs EMA20 M5 " + ema20.toFixed(2);
    if (!bias) return reject("M15 transizione, ma bias M5 non direzionale: " + biasDetail + " (" + bandDetail + ").");
    direction = bias;
    gateNote = "M15 transizione, M5 bias " + bias + " ok: " + biasDetail + " (" + bandDetail + ").";
  }
  if (!direction) return reject("M15 in range o transizione: manca un trend strutturale confermato.");
  const d = direction;
  // Il contesto che ha aperto il tick resta visibile anche quando il blocco arriva piu' avanti.
  const gateEval: SetupEvaluation = { setup: "m15_gate", status: "triggered", direction: d, reason: gateNote };
  const rejectAfterGate = (reason: string) => reject(reason, [gateEval, { setup: "filtri", status: "rejected", reason }]);
  const fast5 = emaCloseSeries(m5, 9), slow5 = emaCloseSeries(m5, 21);
  if (signed(d, fast5.at(-1)! - slow5.at(-1)!) <= 0
    || signed(d, m5.at(-1)!.close - slow5.at(-1)!) < -atr5 * 0.25) return rejectAfterGate("M15 " + d + ", ma M5 contrario o struttura del pullback rotta.");

  const trigger = m1.at(-1)!, forming = input.m1.at(-1)!;
  const shock = env("SHOCK_ATR_MULT", 2.2, 1, 10) * atr1;
  if (range(trigger) > shock || (Date.parse(forming.datetime) + MINUTE > nowMs && range(forming) > shock)) return rejectAfterGate("Candela M1 shock: attendo un nuovo setup, nessun inseguimento.");
  // Ingresso su tick: il livello e' l'estremo dell'ultima M1 CHIUSA e conta appena il prezzo live
  // lo supera di ENTRY_BUFFER_USD nella direzione del setup. La candela in formazione non entra in
  // nessun calcolo: range, EMA e ATR usano solo candele chiuse, del tick serve solo il prezzo.
  const buffer = entryBuffer();
  const triggerLevel = d === "BUY" ? trigger.high : trigger.low;
  const entry = d === "BUY" ? quote.ask : quote.bid;
  const exitQuote = d === "BUY" ? quote.bid : quote.ask;
  if (signed(d, exitQuote - triggerLevel) < buffer) {
    return rejectAfterGate("M15 " + d + ": prezzo " + exitQuote.toFixed(2) + " non oltre il livello M1 "
      + triggerLevel.toFixed(2) + " con buffer " + buffer.toFixed(2) + "$.");
  }
  if (signed(d, entry - triggerLevel) > atr1 * env("MTF_MAX_CHASE_ATR", 0.45, 0.05, 2)) {
    return rejectAfterGate("Ingresso " + entry.toFixed(2) + " già troppo esteso oltre il livello M1 " + triggerLevel.toFixed(2) + ".");
  }

  // A directional M5 impulse followed by an actual retracement defines one persistent setup.
  const lookback = Math.floor(env("MTF_M5_SETUP_BARS", 6, 2, 12));
  const evaluations: SetupEvaluation[] = [gateEval];
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
    // level_used: livello e candela chiusa che lo definisce entrano nella chiave, quindi dopo un
    // ingresso lo stesso livello non riarma nulla finche' non chiude una nuova M1.
    const key = [STRATEGY_VERSION, d, impulse.datetime, firstPullback.datetime, triggerLevel.toFixed(2), trigger.datetime].join(":");
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
      reasoning: STRATEGY_VERSION + ": " + gateNote + " M5 " + setup + "; trigger su tick oltre "
        + triggerLevel.toFixed(2) + " (M1 chiusa " + trigger.datetime + ", buffer " + buffer.toFixed(2) + "$)."
        + " SL strutturale " + appliedRisk.toFixed(2) + "$, TP " + appliedReward.toFixed(2) + "$ (" + rr.toFixed(2) + "R), netto stimato " + netR.toFixed(2) + "R."
        + " Setup " + key + ". [shadow-score:" + score + "]" };
  }
  return reject("M15 " + d + ": attendo un pullback/retest M5 valido con spazio fino al prossimo ostacolo.", evaluations.length ? evaluations : undefined);
}

export const SHORT_STRATEGY_VERSION = "m1-short-v1";

/** Margine oltre il livello che il prezzo live deve superare perche' il trigger sia valido. */
function entryBuffer() {
  return env("ENTRY_BUFFER_USD", 0.1, 0, 5);
}

function shortEnabled() {
  const raw = process.env.SHORT_ENABLED?.trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
}

/** Blocchi comuni ai due setup: senza questi non si valuta niente, ne' mtf ne' m1_short. */
function commonPreflight(input: EvaluateInput, nowMs: number): ScalperSignal | null {
  const { quote } = input;
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
  if (!closedBars(input.m1, 1, nowMs) || !closedBars(input.m5, 5, nowMs)) return reject("Candele non valide, duplicate o fuori ordine.");
  return null;
}

function rejectShort(reason: string, direction?: "BUY" | "SELL"): ScalperSignal {
  const evaluation: SetupEvaluation = direction
    ? { setup: "m1_gate", status: "rejected", direction, reason }
    : { setup: "m1_gate", status: "rejected", reason };
  return { direction: "NO_TRADE", setup: null, setupKey: null, entry: null, stopLoss: null,
    takeProfit: null, riskReward: null, slPlan: null, reasoning: reason, evaluations: [evaluation] };
}

/**
 * Secondo setup, valutato solo quando la mtf non produce un ordine.
 * Rottura del range delle ultime SHORT_RANGE_BARS candele M1 nella direzione dell'EMA20 M1,
 * SL dimensionato sull'ATR e TP fisso indipendente dallo SL. Nessun breakeven, nessun quick profit.
 */
function evaluateM1Short(input: EvaluateInput, nowMs: number): ScalperSignal {
  const { quote } = input;
  const m1 = closedBars(input.m1, 1, nowMs);
  if (!m1) return rejectShort("m1_short: candele M1 non valide.");
  const bars = Math.floor(env("SHORT_RANGE_BARS", 8, 3, 40));
  if (m1.length < bars + 25) return rejectShort("m1_short: storico M1 insufficiente, servono " + (bars + 25) + " candele chiuse.");
  if (!latestBarFresh(m1, 1, nowMs, 3 * MINUTE)) return rejectShort("m1_short: ultima M1 chiusa non aggiornata.");

  const atr1 = atr(m1, 14, true);
  if (!atr1 || !(atr1 > 0)) return rejectShort("m1_short: ATR M1 non disponibile.");
  if (atr1 < env("SCALPER_MIN_ATR_M1", 0.8, 0.01, 20)
    || atr1 > env("SCALPER_MAX_ATR_M1", 6, 0.1, 100)) return rejectShort("m1_short: volatilità M1 fuori limiti, ATR " + atr1.toFixed(2) + "$.");

  const trigger = m1.at(-1)!, forming = input.m1.at(-1)!;
  const shock = env("SHOCK_ATR_MULT", 2.2, 1, 10) * atr1;
  if (range(trigger) > shock || (Date.parse(forming.datetime) + MINUTE > nowMs && range(forming) > shock)) {
    return rejectShort("m1_short: candela M1 shock, nessun inseguimento.");
  }

  // Range, EMA e ATR solo su candele chiuse: la candela in formazione non entra mai nel calcolo.
  const window = m1.slice(-bars);
  const high = maxHigh(window), low = minLow(window);
  const ema20 = emaCloseSeries(m1, 20).at(-1)!;
  const buffer = entryBuffer();
  const slAtr = atr1 * env("SHORT_SL_ATR", 2, 0.2, 10);
  const slMin = env("SHORT_SL_MIN_USD", 3, 0.1, 50), slMax = env("SHORT_SL_MAX_USD", 8, 0.1, 100);
  const tpAtr = atr1 * env("SHORT_TP_ATR", 0.6, 0.05, 10);
  const tpMin = env("SHORT_TP_MIN_USD", 1.5, 0.1, 50), tpMax = env("SHORT_TP_MAX_USD", 3, 0.1, 100);
  const plannedRisk = Math.max(slAtr, slMin), plannedReward = Math.min(Math.max(tpAtr, tpMin), tpMax);
  const detail = "range " + bars + " M1 chiuse " + low.toFixed(2) + "-" + high.toFixed(2)
    + ", prezzo " + quote.bid.toFixed(2) + "/" + quote.ask.toFixed(2) + ", buffer " + buffer.toFixed(2) + "$"
    + ", EMA20 M1 " + ema20.toFixed(2)
    + ", ATR M1 " + atr1.toFixed(2) + "$, SL " + plannedRisk.toFixed(2) + "$, TP " + plannedReward.toFixed(2) + "$";

  // Trigger su tick: il prezzo live deve superare il range di ENTRY_BUFFER_USD, non serve la chiusura.
  const brokeUp = quote.bid >= high + buffer, brokeDown = quote.ask <= low - buffer;
  if (!brokeUp && !brokeDown) return rejectShort("m1_short: prezzo dentro il range delle ultime " + bars + " M1 chiuse (" + detail + ").");
  const direction: "BUY" | "SELL" = brokeUp ? "BUY" : "SELL";
  const reference = direction === "BUY" ? quote.bid : quote.ask;
  if (direction === "BUY" ? reference <= ema20 : reference >= ema20) {
    return rejectShort("m1_short: rottura " + direction + " contro l'EMA20 M1 (" + detail + ").", direction);
  }
  if (slAtr > slMax) {
    return rejectShort("m1_short: SL richiesto " + slAtr.toFixed(2) + "$ oltre il massimo " + slMax.toFixed(2) + "$ (" + detail + ").", direction);
  }

  const entry = direction === "BUY" ? quote.ask : quote.bid;
  const sl = direction === "BUY" ? Math.floor((entry - plannedRisk) * 100) / 100 : Math.ceil((entry + plannedRisk) * 100) / 100;
  const tp = direction === "BUY" ? Math.floor((entry + plannedReward) * 100) / 100 : Math.ceil((entry - plannedReward) * 100) / 100;
  const risk = Math.abs(entry - sl), reward = signed(direction, tp - entry);
  if (!(risk > 0 && reward > 0) || risk > slMax + 0.011) {
    return rejectShort("m1_short: SL/TP non validi al prezzo corrente (" + detail + ").", direction);
  }
  const rr = reward / risk;
  const level = direction === "BUY" ? high : low;
  const score = Math.min(95, Math.round(55 + body(trigger) * 20 + Math.min(1, Math.abs(reference - level) / atr1) * 15));
  const reason = "m1_short " + direction + ": prezzo oltre " + level.toFixed(2) + " (" + detail + ").";
  return {
    direction, setup: "m1_short",
    // level_used: livello e ultima M1 chiusa nella chiave, un solo tentativo finche' non chiude una nuova M1.
    setupKey: [SHORT_STRATEGY_VERSION, direction, level.toFixed(2), trigger.datetime].join(":"),
    entry, stopLoss: sl, takeProfit: tp, riskReward: Number(rr.toFixed(2)),
    slPlan: { structural: Number(slAtr.toFixed(2)), atr: Number(slAtr.toFixed(2)), applied: Number(risk.toFixed(2)),
      minUsd: slMin, maxUsd: slMax, rr: Number(rr.toFixed(2)), tpMinUsd: tpMin, tpMaxUsd: tpMax },
    evaluations: [{ setup: "m1_gate", status: "triggered", direction, reason }],
    reasoning: SHORT_STRATEGY_VERSION + ": " + reason + " M1 chiusa " + trigger.datetime
      + ". SL " + risk.toFixed(2) + "$, TP " + reward.toFixed(2)
      + "$ (" + rr.toFixed(2) + "R), TP indipendente dallo SL. [shadow-score:" + score + "]",
  };
}

/**
 * Priorità: mtf-continuation-v1 e, solo se non produce un ordine, m1_short.
 * Le valutazioni dei due contesti viaggiano insieme in stream_last_decision.
 */
export function evaluateScalper(input: EvaluateInput): ScalperSignal {
  const nowMs = input.nowMs ?? Date.now();
  const blocked = commonPreflight(input, nowMs);
  if (blocked) return blocked;
  const mtf = evaluateMtfContinuation(input);
  if (mtf.direction !== "NO_TRADE" || !shortEnabled()) return mtf;
  const short = evaluateM1Short(input, nowMs);
  const evaluations = [...mtf.evaluations, ...short.evaluations];
  return short.direction === "NO_TRADE" ? { ...mtf, evaluations } : { ...short, evaluations };
}

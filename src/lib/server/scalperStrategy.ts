import type { Candle, M15Regime, MarketContext, Quote, ScalperSignal, SetupEvaluation } from "../types";
import { atr, emaCloseSeries } from "./indicators";
import { aggregateM15, closedBars, MINUTE, swingLevels } from "./marketStructure";
import { getSessionStatus, parseSessionHours, sessionConfigFromEnv } from "../session";
import { safetyTakeProfit } from "./positionManager";

/**
 * TP di sicurezza dei setup a uscita gestita: non e' l'obiettivo del trade (quello resta target1,
 * gestito dal worker) ma la rete che chiude la posizione se worker o MetaApi smettono di rispondere.
 * Va tenuto lontano abbastanza da non interferire con breakeven e trailing.
 */
function brokerSafetyTp(direction: "BUY" | "SELL", entry: number, target1: number, atrM1: number) {
  return safetyTakeProfit(direction, entry, target1, atrM1,
    env("SAFETY_TP_ATR", 4, 0.5, 50), env("SAFETY_TP_MIN_R", 3, 1, 20));
}

export const STRATEGY_VERSION = "mtf-continuation-v1";

function env(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name]?.trim(), value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/**
 * Gate M15 a 4 stati. Default "off": nessun cambio di comportamento rispetto a main, m15State
 * resta a 3 valori e "range" blocca sempre m1_short. "live" sblocca la zona grigia: m1_short passa
 * anche con M15 in transizione, purche' M5 sia direzionale e M15 non sia un range vero ne' un
 * trend opposto. Qualsiasi valore diverso da "live" (incluso assente o non riconosciuto) e' "off".
 */
export function m15GateMode(): "off" | "live" {
  return (process.env.M15_GATE_MODE?.trim().toLowerCase() ?? "off") === "live" ? "live" : "off";
}

/**
 * Classificazione pura dello stato M15 a 4 valori. Il range compresso ha SEMPRE priorita': anche
 * se gli swing dell'ultima banda sembrano direzionali, un M15 compresso resta true_range e non
 * diventa mai transition ne' trend. "transition" e' tutto cio' che non e' ne' un range vero ne'
 * un trend con struttura confermata (HH/HL o LL/LH).
 */
export function classifyM15Regime(input: { compressed: boolean; structureUp: boolean; structureDown: boolean }): M15Regime {
  if (input.compressed) return "true_range";
  if (input.structureUp) return "trend_up";
  if (input.structureDown) return "trend_down";
  return "transition";
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

type EvaluateInput = {
  quote: Quote; m1: Candle[]; m5: Candle[]; nowMs?: number;
  /**
   * Esclusione esterna dalla valutazione (es. marketLiquidity.ts in liquidita' LOW), oltre a
   * SHORT_ENABLED/RANGE_ENABLED: nessuna modifica ai criteri d'ingresso dei setup, solo un gate
   * aggiuntivo su SE vengono valutati, esattamente allo stesso punto dei due toggle esistenti.
   */
  disableShort?: boolean;
  disableRange?: boolean;
};

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
  if (session.weekendClosed || session.inFlattenWindow) return reject(session.blockReason ?? "Fuori sessione.");
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
  // Stato M15 a 4 valori loggato sempre (anche con M15_GATE_MODE=off): non cambia nessuna delle
  // due condizioni di direzione della mtf qui sopra o sotto, e' solo l'etichetta nel reasoning.
  let gateNote = direction
    ? "M15 trend " + direction + " confermato: sep " + sep.toFixed(2) + " ATR15, efficienza " + efficiency.toFixed(2)
      + ". m15_regime=" + (direction === "BUY" ? "trend_up" : "trend_down") + " (gate=" + m15GateMode() + ")."
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
      + " in " + bandLow.toFixed(2) + "-" + bandHigh.toFixed(2)
      + ". m15_regime=" + (widthAtr <= maxWidthAtr && inside ? "true_range" : "transition") + " (gate=" + m15GateMode() + ")";
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

// --- Contesto M5/M15 condiviso da m1_short e m1_range -----------------------------------------
// La mtf non lo usa e non e' stata toccata: qui il contesto viene ricostruito con gli stessi
// helper (maxHigh/minLow/atr/emaCloseSeries) e la stessa env M15_RANGE_BAND_ATR del suo gate M15,
// cosi' la misura del range e' identica senza modificare una riga di evaluateMtfContinuation.

const CONTEXT_M5_EMA = 20;
/** Pendenza EMA20 M5: valore attuale contro quello di cinque candele M5 prima. */
const CONTEXT_EMA_LOOKBACK = 5;
const CONTEXT_M15_BARS = 12;
/** Una rottura M15 e' "recente" finche' non sono passati cinque minuti dalla chiusura della candela. */
const CONTEXT_BREAKOUT_MAX_AGE = 5 * MINUTE;

/**
 * Swing con conferma a una candela per lato: il massimo (minimo) deve battere sia la candela
 * precedente sia la successiva. La candela in formazione non arriva mai qui: si lavora su chiuse.
 */
export function swingPoints(bars: Candle[], kind: "high" | "low"): Candle[] {
  const out: Candle[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    if (kind === "high" && bars[i].high > bars[i - 1].high && bars[i].high > bars[i + 1].high) out.push(bars[i]);
    if (kind === "low" && bars[i].low < bars[i - 1].low && bars[i].low < bars[i + 1].low) out.push(bars[i]);
  }
  return out;
}

/**
 * Contesto letto a ogni tick prima di m1_short e m1_range, solo da candele CHIUSE.
 * Restituisce null quando lo storico M5/M15 non basta: in quel caso i due setup non entrano.
 */
export function contextM5M15(m5: Candle[], nowMs: number): MarketContext | null {
  if (m5.length < CONTEXT_M5_EMA + CONTEXT_EMA_LOOKBACK) return null;
  const emaSeries = emaCloseSeries(m5, CONTEXT_M5_EMA);
  const ema20M5 = emaSeries.at(-1), ema20M5Before = emaSeries.at(-1 - CONTEXT_EMA_LOOKBACK);
  if (ema20M5 == null || ema20M5Before == null) return null;
  const closeM5 = m5.at(-1)!.close;
  const biasM5: MarketContext["biasM5"] = closeM5 > ema20M5 && ema20M5 > ema20M5Before ? "up"
    : closeM5 < ema20M5 && ema20M5 < ema20M5Before ? "down" : "flat";

  const m15 = aggregateM15(m5);
  if (m15.length < CONTEXT_M15_BARS + 1) return null;
  const atr15 = atr(m15, 14, true);
  if (!atr15 || !(atr15 > 0)) return null;

  // Range M15: stessa misura del gate M15 della mtf, banda delle ultime 12 M15 in ATR15.
  const band = m15.slice(-CONTEXT_M15_BARS);
  const m15BandWidth = maxHigh(band) - minLow(band);
  const m15BandAtr = m15BandWidth / atr15;
  const maxBandAtr = env("M15_RANGE_BAND_ATR", 3, 0.5, 20);
  const highs = swingPoints(band, "high"), lows = swingPoints(band, "low");
  const higherHighs = highs.length >= 2 && highs.at(-1)!.high > highs.at(-2)!.high;
  const higherLows = lows.length >= 2 && lows.at(-1)!.low > lows.at(-2)!.low;
  const lowerLows = lows.length >= 2 && lows.at(-1)!.low < lows.at(-2)!.low;
  const lowerHighs = highs.length >= 2 && highs.at(-1)!.high < highs.at(-2)!.high;
  const compressed = m15BandAtr <= maxBandAtr;
  // Stato a 4 valori, sempre calcolato e sempre in log: il range compresso ha sempre priorita',
  // "transition" e' la banda larga senza struttura HH/HL o LL/LH confermata. Non influenza la
  // decisione finche' M15_GATE_MODE resta "off": m15State a 3 valori sotto e' invariato.
  const m15Regime = classifyM15Regime({ compressed, structureUp: higherHighs && higherLows, structureDown: lowerLows && lowerHighs });
  // Senza struttura chiara in nessuna delle due direzioni il contesto resta range. Invariato bit
  // per bit rispetto a prima: dipende solo da compressed/higherHighs&&higherLows/lowerLows&&lowerHighs.
  const m15State: MarketContext["m15State"] = compressed ? "range"
    : m15Regime === "trend_up" ? "trend_up"
      : m15Regime === "trend_down" ? "trend_down" : "range";

  const last15 = m15.at(-1)!, previous15 = m15.slice(-1 - CONTEXT_M15_BARS, -1);
  const brokeUp = last15.close > maxHigh(previous15), brokeDown = last15.close < minLow(previous15);
  const closedAgo = nowMs - (Date.parse(last15.datetime) + 15 * MINUTE);
  const m15BreakoutRecent = (brokeUp || brokeDown) && closedAgo >= 0 && closedAgo < CONTEXT_BREAKOUT_MAX_AGE;

  const detail = "bias_m5=" + biasM5 + " (M5 " + closeM5.toFixed(2) + " vs EMA20 M5 " + ema20M5.toFixed(2)
    + ", EMA20 " + CONTEXT_EMA_LOOKBACK + " candele prima " + ema20M5Before.toFixed(2) + ")"
    + ", m15_state=" + m15State + " (banda " + CONTEXT_M15_BARS + " M15 " + m15BandWidth.toFixed(2) + "$ = "
    + m15BandAtr.toFixed(2) + " ATR15, range sotto " + maxBandAtr.toFixed(2) + ", ATR15 " + atr15.toFixed(2) + "$)"
    + ", m15_regime=" + m15Regime + " (gate=" + m15GateMode() + ")"
    + ", m15_breakout_recent=" + m15BreakoutRecent
    + " (ultima M15 " + last15.datetime + " chiusa " + last15.close.toFixed(2)
    + " vs " + minLow(previous15).toFixed(2) + "-" + maxHigh(previous15).toFixed(2)
    + ", chiusa da " + Math.round(closedAgo / 1000) + " s)";

  return { biasM5, m15State, m15Regime, m15BreakoutRecent, ema20M5, ema20M5Before, closeM5,
    m15BandWidth: Number(m15BandWidth.toFixed(2)), m15BandAtr: Number(m15BandAtr.toFixed(2)),
    atr15: Number(atr15.toFixed(2)), detail };
}

function rejectContext(reason: string, direction?: "BUY" | "SELL"): ScalperSignal {
  const evaluation: SetupEvaluation = direction
    ? { setup: "context_gate", status: "rejected", direction, reason }
    : { setup: "context_gate", status: "rejected", reason };
  return { direction: "NO_TRADE", setup: null, setupKey: null, entry: null, stopLoss: null,
    takeProfit: null, riskReward: null, slPlan: null, reasoning: reason, evaluations: [evaluation] };
}

/**
 * Contesto obbligatorio per m1_short: si opera solo nella direzione del bias M5, con l'M15 dalla
 * stessa parte, mai in range e mai subito dopo una rottura M15.
 *
 * M15_GATE_MODE=off (default): comportamento invariato bit per bit, sul m15State a 3 valori.
 * M15_GATE_MODE=live: gate a 4 stati sul m15Regime. true_range e trend opposto bloccano sempre
 * come prima; la differenza e' che "transition" (M15 non ancora confermato ma non un range vero)
 * non blocca piu' da sola: il bias M5 puo' portare il trade, la zona grigia si sblocca.
 */
export function shortContextGate(label: string, context: MarketContext | null) {
  if (!context) return { allowed: null, blocked: rejectContext(label + ": contesto M5/M15 non disponibile, storico M5/M15 insufficiente.") };
  const allowed: "BUY" | "SELL" | null = context.biasM5 === "up" ? "BUY" : context.biasM5 === "down" ? "SELL" : null;
  const detail = " (" + context.detail + ")";
  if (!allowed) return { allowed: null, blocked: rejectContext(label + ": bias_m5=flat" + detail + ".") };

  if (m15GateMode() === "live") {
    if (context.m15Regime === "true_range") {
      return { allowed: null, blocked: rejectContext(label + " " + allowed + ": m15_regime=true_range" + detail + ".", allowed) };
    }
    const contraryRegime: M15Regime = allowed === "BUY" ? "trend_down" : "trend_up";
    if (context.m15Regime === contraryRegime) {
      return { allowed: null, blocked: rejectContext(label + " " + allowed + ": m15_regime=" + contraryRegime + " contrario al bias M5" + detail + ".", allowed) };
    }
    if (context.m15BreakoutRecent) {
      return { allowed: null, blocked: rejectContext(label + " " + allowed + ": m15_breakout_recent=true" + detail + ".", allowed) };
    }
    // trend_<stessa direzione> o transition: il bias M5 porta il trade.
    return { allowed, blocked: null };
  }

  const contrary = allowed === "BUY" ? "trend_down" : "trend_up";
  if (context.m15State === contrary) {
    return { allowed: null, blocked: rejectContext(label + " " + allowed + ": m15_state=" + contrary + " contrario al bias M5" + detail + ".", allowed) };
  }
  if (context.m15State === "range") {
    return { allowed: null, blocked: rejectContext(label + " " + allowed + ": m15_state=range" + detail + ".", allowed) };
  }
  if (context.m15BreakoutRecent) {
    return { allowed: null, blocked: rejectContext(label + " " + allowed + ": m15_breakout_recent=true" + detail + ".", allowed) };
  }
  return { allowed, blocked: null };
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
  if (session.weekendClosed || session.inFlattenWindow) return reject(session.blockReason ?? "Fuori sessione.");
  if (!closedBars(input.m1, 1, nowMs) || !closedBars(input.m5, 5, nowMs)) return reject("Candele non valide, duplicate o fuori ordine.");
  return null;
}

function rejectShortGate(reason: string, direction?: "BUY" | "SELL"): ScalperSignal {
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
function evaluateM1Short(input: EvaluateInput, nowMs: number, context: MarketContext | null): ScalperSignal {
  const { quote } = input;
  // Contesto prima di tutto: si opera solo con il bias M5 e l'M15 dalla stessa parte.
  const gate = shortContextGate("m1_short", context);
  if (gate.blocked) return gate.blocked;
  const allowed = gate.allowed!, ctx = context!;
  const contextEval: SetupEvaluation = { setup: "context_gate", status: "triggered", direction: allowed,
    reason: "m1_short: contesto ok, solo " + allowed + " (" + ctx.detail + ")." };
  const rejectShort = (reason: string, direction?: "BUY" | "SELL"): ScalperSignal => {
    const signal = rejectShortGate(reason, direction);
    return { ...signal, evaluations: [contextEval, ...signal.evaluations] };
  };
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
  if (direction !== allowed) {
    return rejectContext("m1_short " + direction + ": bias_m5=" + ctx.biasM5 + " ammette solo " + allowed
      + " (" + ctx.detail + ").", direction);
  }
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
    entry, stopLoss: sl, takeProfit: tp, tpBroker: brokerSafetyTp(direction, entry, tp, atr1),
    riskReward: Number(rr.toFixed(2)),
    slPlan: { structural: Number(slAtr.toFixed(2)), atr: Number(slAtr.toFixed(2)), applied: Number(risk.toFixed(2)),
      minUsd: slMin, maxUsd: slMax, rr: Number(rr.toFixed(2)), tpMinUsd: tpMin, tpMaxUsd: tpMax },
    evaluations: [contextEval, { setup: "m1_gate", status: "triggered", direction, reason }],
    reasoning: SHORT_STRATEGY_VERSION + ": " + reason + " M1 chiusa " + trigger.datetime
      + ". SL " + risk.toFixed(2) + "$, TP " + reward.toFixed(2)
      + "$ (" + rr.toFixed(2) + "R), TP indipendente dallo SL. [shadow-score:" + score + "]",
  };
}

export const RANGE_STRATEGY_VERSION = "m1-range-v1";

/** Candele M5 chiuse che devono contenere il range M1 perche' il laterale sia credibile. */
const RANGE_M5_CONTAINER_BARS = 6;

function rangeEnabled() {
  const raw = process.env.RANGE_ENABLED?.trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
}

function rejectRangeGate(reason: string, direction?: "BUY" | "SELL"): ScalperSignal {
  const evaluation: SetupEvaluation = direction
    ? { setup: "range_gate", status: "rejected", direction, reason }
    : { setup: "range_gate", status: "rejected", reason };
  return { direction: "NO_TRADE", setup: null, setupKey: null, entry: null, stopLoss: null,
    takeProfit: null, riskReward: null, slPlan: null, reasoning: reason, evaluations: [evaluation] };
}

/**
 * Rientro dal bordo di un range M1 largo: si compra vicino al minimo e si vende vicino al massimo
 * delle ultime RANGE_BARS candele chiuse. Ingresso su tick, SL appena oltre il bordo e TP sul lato
 * opposto del range. L'anti-accumulo non si applica: qui il range e' il setup, non un ostacolo.
 */
function evaluateM1Range(input: EvaluateInput, nowMs: number, context: MarketContext | null): ScalperSignal {
  const { quote } = input;
  // Il rientro dal bordo vive solo nel mercato laterale: bias M5 fermo, nessuna rottura M15 fresca
  // e il range M1 tutto dentro l'escursione delle ultime M5.
  if (!context) return rejectContext("m1_range: contesto M5/M15 non disponibile, storico M5/M15 insufficiente.");
  const ctx = context, ctxDetail = " (" + ctx.detail + ")";
  // La rottura M15 fresca si valuta per prima: porta sempre con se' un bias direzionale, quindi
  // controllandola dopo il bias resterebbe invisibile nei log anche quando e' lei a fermare il trade.
  if (ctx.m15BreakoutRecent) return rejectContext("m1_range: m15_breakout_recent=true" + ctxDetail + ".");
  if (ctx.biasM5 !== "flat") return rejectContext("m1_range: bias_m5=" + ctx.biasM5 + ", il mercato non e' laterale" + ctxDetail + ".");
  const contextEval: SetupEvaluation = { setup: "context_gate", status: "triggered",
    reason: "m1_range: contesto ok" + ctxDetail + "." };
  const rejectRange = (reason: string, direction?: "BUY" | "SELL"): ScalperSignal => {
    const signal = rejectRangeGate(reason, direction);
    return { ...signal, evaluations: [contextEval, ...signal.evaluations] };
  };
  const m5 = closedBars(input.m5, 5, nowMs);
  if (!m5 || m5.length < RANGE_M5_CONTAINER_BARS) return rejectRange("m1_range: storico M5 insufficiente, servono " + RANGE_M5_CONTAINER_BARS + " candele chiuse.");
  const m1 = closedBars(input.m1, 1, nowMs);
  if (!m1) return rejectRange("m1_range: candele M1 non valide.");
  const bars = Math.floor(env("RANGE_BARS", 8, 3, 40));
  if (m1.length < bars + 25) return rejectRange("m1_range: storico M1 insufficiente, servono " + (bars + 25) + " candele chiuse.");
  if (!latestBarFresh(m1, 1, nowMs, 3 * MINUTE)) return rejectRange("m1_range: ultima M1 chiusa non aggiornata.");

  const atr1 = atr(m1, 14, true);
  if (!atr1 || !(atr1 > 0)) return rejectRange("m1_range: ATR M1 non disponibile.");
  if (atr1 < env("SCALPER_MIN_ATR_M1", 0.8, 0.01, 20)
    || atr1 > env("SCALPER_MAX_ATR_M1", 6, 0.1, 100)) return rejectRange("m1_range: volatilità M1 fuori limiti, ATR " + atr1.toFixed(2) + "$.");

  const trigger = m1.at(-1)!, forming = input.m1.at(-1)!;
  const shock = env("SHOCK_ATR_MULT", 2.2, 1, 10) * atr1;
  if (range(trigger) > shock || (Date.parse(forming.datetime) + MINUTE > nowMs && range(forming) > shock)) {
    return rejectRange("m1_range: candela M1 shock, nessun ingresso sul bordo.");
  }

  // Range e ATR solo da candele chiuse: del tick serve soltanto il prezzo.
  const window = m1.slice(-bars);
  const high = maxHigh(window), low = minLow(window), width = high - low;
  const minAtr = env("RANGE_MIN_ATR", 1.5, 0.1, 10), minUsd = env("RANGE_MIN_USD", 3, 0.1, 100);
  const edgePct = env("RANGE_EDGE_PCT", 20, 1, 50) / 100;
  const slBuffer = env("SL_BUFFER_USD", 0.3, 0, 5), tpBuffer = env("TP_BUFFER_USD", 0.3, 0, 5);
  const slAtrMult = env("RANGE_SL_ATR", 2, 0.1, 10), slMinUsd = env("RANGE_SL_MIN_USD", 2, 0.1, 50);
  const slMaxUsd = env("RANGE_SL_MAX_USD", 8, 0.1, 100), slMaxPct = env("RANGE_SL_MAX_PCT", 50, 5, 100) / 100;
  const tpMinUsd = env("RANGE_TP_MIN_USD", 1.5, 0.1, 50);
  const container = m5.slice(-RANGE_M5_CONTAINER_BARS);
  const containerHigh = maxHigh(container), containerLow = minLow(container);
  const base = "range " + bars + " M1 chiuse " + low.toFixed(2) + "-" + high.toFixed(2)
    + " (" + width.toFixed(2) + "$ = " + (width / atr1).toFixed(2) + " ATR), ATR M1 " + atr1.toFixed(2) + "$";
  // Se il range M1 sborda dall'escursione delle ultime M5 non e' un laterale: e' l'inizio di un movimento.
  if (high > containerHigh || low < containerLow) {
    return rejectContext("m1_range: range M1 " + low.toFixed(2) + "-" + high.toFixed(2) + " fuori dalle ultime "
      + RANGE_M5_CONTAINER_BARS + " M5 " + containerLow.toFixed(2) + "-" + containerHigh.toFixed(2) + ctxDetail + ".");
  }
  if (width < atr1 * minAtr || width < minUsd) {
    return rejectRange("m1_range: range troppo stretto, servono " + Math.max(atr1 * minAtr, minUsd).toFixed(2) + "$ (" + base + ").");
  }

  const green = trigger.close > trigger.open, red = trigger.close < trigger.open;
  const buyEntry = quote.ask, sellEntry = quote.bid;
  const edge = width * edgePct;
  const nearLow = buyEntry >= low && buyEntry <= low + edge;
  const nearHigh = sellEntry <= high && sellEntry >= high - edge;
  const direction: "BUY" | "SELL" | null = nearLow && green ? "BUY" : nearHigh && red ? "SELL" : null;
  if (!direction) {
    const distance = "distanza dal bordo: low " + (buyEntry - low).toFixed(2) + "$, high " + (high - sellEntry).toFixed(2)
      + "$, soglia " + edge.toFixed(2) + "$ (" + edgePct * 100 + "%), ultima M1 " + (green ? "verde" : red ? "rossa" : "neutra");
    return rejectRange("m1_range: nessun rientro dal bordo, " + distance + " (" + base + ").");
  }

  const entry = direction === "BUY" ? buyEntry : sellEntry;
  const edgeLevel = direction === "BUY" ? low : high;
  const oppositeLevel = direction === "BUY" ? high : low;
  // Lo stop sta oltre il bordo, ma non piu' stretto di RANGE_SL_ATR * ATR M1 ne' di RANGE_SL_MIN_USD.
  const structural = signed(direction, entry - edgeLevel) + slBuffer;
  const risk = Math.max(structural, atr1 * slAtrMult, slMinUsd);
  const detail = base + ", distanza dal bordo " + Math.abs(entry - edgeLevel).toFixed(2)
    + "$, SL " + risk.toFixed(2) + "$ (struttura " + structural.toFixed(2) + "$, ATR x" + slAtrMult + " "
    + (atr1 * slAtrMult).toFixed(2) + "$, minimo " + slMinUsd.toFixed(2) + "$)"
    + ", TP " + (Math.abs(oppositeLevel - entry) - tpBuffer).toFixed(2) + "$";
  if (risk > slMaxUsd) {
    return rejectRange("m1_range: SL " + risk.toFixed(2) + "$ oltre il massimo " + slMaxUsd.toFixed(2) + "$ (" + detail + ").", direction);
  }
  // Uno stop che vale mezzo range non e' un rientro dal bordo: il trade non ha spazio per lavorare.
  const maxRiskFromRange = width * slMaxPct;
  if (risk > maxRiskFromRange) {
    return rejectRange("m1_range: SL troppo grande per il range: SL " + risk.toFixed(2) + "$ oltre il "
      + (slMaxPct * 100).toFixed(0) + "% dell'ampiezza " + width.toFixed(2) + "$ (max " + maxRiskFromRange.toFixed(2) + "$) ("
      + detail + ").", direction);
  }
  const reward = signed(direction, oppositeLevel - entry) - tpBuffer;
  if (reward < tpMinUsd) {
    return rejectRange("m1_range: TP disponibile " + reward.toFixed(2) + "$ sotto il minimo " + tpMinUsd.toFixed(2) + "$ (" + detail + ").", direction);
  }

  const sl = direction === "BUY" ? Math.floor((entry - risk) * 100) / 100 : Math.ceil((entry + risk) * 100) / 100;
  const tp = direction === "BUY" ? Math.floor((entry + reward) * 100) / 100 : Math.ceil((entry - reward) * 100) / 100;
  const appliedRisk = Math.abs(entry - sl), appliedReward = signed(direction, tp - entry);
  if (!(appliedRisk > 0 && appliedReward > 0) || appliedRisk > slMaxUsd + 0.011) {
    return rejectRange("m1_range: SL/TP non validi al prezzo corrente (" + detail + ").", direction);
  }
  const rr = appliedReward / appliedRisk;
  const score = Math.min(95, Math.round(55 + Math.min(1, width / atr1 / 3) * 25 + (1 - Math.min(1, Math.abs(entry - edgeLevel) / Math.max(0.01, edge))) * 15));
  const reason = "m1_range " + direction + ": rientro dal bordo " + edgeLevel.toFixed(2) + " verso " + oppositeLevel.toFixed(2) + " (" + detail + ").";
  return {
    direction, setup: "m1_range",
    // level_used: bordo e ultima M1 chiusa nella chiave, un tentativo per bordo finche' non nasce un nuovo range.
    setupKey: [RANGE_STRATEGY_VERSION, direction, edgeLevel.toFixed(2), trigger.datetime].join(":"),
    entry, stopLoss: sl, takeProfit: tp, tpBroker: brokerSafetyTp(direction, entry, tp, atr1),
    riskReward: Number(rr.toFixed(2)),
    slPlan: { structural: Number(structural.toFixed(2)), atr: Number((atr1 * slAtrMult).toFixed(2)), applied: Number(appliedRisk.toFixed(2)),
      minUsd: slMinUsd, maxUsd: slMaxUsd, rr: Number(rr.toFixed(2)), tpMinUsd },
    evaluations: [contextEval, { setup: "range_gate", status: "triggered", direction, reason }],
    reasoning: RANGE_STRATEGY_VERSION + ": " + reason + " M1 chiusa " + trigger.datetime
      + ". SL " + appliedRisk.toFixed(2) + "$, TP " + appliedReward.toFixed(2) + "$ (" + rr.toFixed(2) + "R). [shadow-score:" + score + "]",
  };
}

/**
 * Priorità: mtf-continuation-v1, poi m1_short e infine m1_range; il primo che produce un ordine vince.
 * Le valutazioni dei contesti attraversati viaggiano insieme in stream_last_decision.
 */
export function evaluateScalper(input: EvaluateInput): ScalperSignal {
  const nowMs = input.nowMs ?? Date.now();
  const blocked = commonPreflight(input, nowMs);
  if (blocked) return blocked;
  const mtf = evaluateMtfContinuation(input);
  if (mtf.direction !== "NO_TRADE") return mtf;
  let evaluations = [...mtf.evaluations];
  const shortActive = shortEnabled() && !input.disableShort;
  const rangeActive = rangeEnabled() && !input.disableRange;
  // Contesto M5/M15 letto una volta sola e condiviso dai due setup che lo usano.
  const context = shortActive || rangeActive
    ? contextM5M15(closedBars(input.m5, 5, nowMs) ?? [], nowMs)
    : null;
  if (shortActive) {
    const short = evaluateM1Short(input, nowMs, context);
    evaluations = [...evaluations, ...short.evaluations];
    if (short.direction !== "NO_TRADE") return { ...short, evaluations };
  }
  if (rangeActive) {
    const ranged = evaluateM1Range(input, nowMs, context);
    evaluations = [...evaluations, ...ranged.evaluations];
    if (ranged.direction !== "NO_TRADE") return { ...ranged, evaluations };
  }
  return { ...mtf, evaluations };
}

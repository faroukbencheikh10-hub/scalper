import type { Candle } from "../types";
import { improvesStop, lastSwing } from "./positionManager";

export type TradeDirection = "BUY" | "SELL";

/**
 * SL/TP calcolati da struttura M1 + ATR M1 + spread, al posto dei livelli fissi/assenti di
 * default (SLTP_MODE=off). Modulo puro: nessuna chiamata a MetaApi o al database, nessuna
 * costante di modulo per gli env — letti con parseFloat a ogni chiamata cosi' un cambio dalla
 * dashboard Railway si applica dal tick successivo senza riavviare il worker.
 *
 * Basato sull'idea di scripts/dynamic-protection-scenarios.ts (branch dynamic-sl-tp-only): stessa
 * tecnica di arrotondamento al tick e di rate-limit adattivo, adattata ai nomi env reali richiesti
 * qui (SL_MAX/TP_MAX senza suffisso _USD, che non esistevano prima in nessun branch) e estesa con
 * il TP trailing della modalita' "trailing" (SLTP_MODE=fixed non lo prevede: il TP resta fisso).
 */

export type SltpMode = "off" | "fixed" | "trailing";

export function sltpMode(): SltpMode {
  const raw = process.env.SLTP_MODE?.trim().toLowerCase();
  return raw === "fixed" || raw === "trailing" ? raw : "off";
}

function envUsd(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  const value = raw !== undefined && raw.trim() !== "" ? parseFloat(raw) : NaN;
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/** Cap rigido sulla distanza SL dal prezzo di apertura. Nome esatto richiesto: senza suffisso _USD. */
export function slMaxUsd() { return envUsd("SL_MAX", 15, 0.1, 500); }
/** Cap rigido sul TP iniziale. Nome esatto richiesto: senza suffisso _USD. */
export function tpMaxUsd() { return envUsd("TP_MAX", 10, 0.1, 500); }
export function sltpUpdateMinIntervalMs() { return envUsd("SLTP_UPDATE_MIN_INTERVAL_SEC", 5, 0, 3600) * 1000; }
export function tpExtendTriggerUsd() { return envUsd("TP_EXTEND_TRIGGER_USD", 1, 0, 500); }
export function tpTrailPullbackUsd() { return envUsd("TP_TRAIL_PULLBACK_USD", 2, 0.01, 500); }
export function tpTrailMinStepUsd() { return envUsd("TP_TRAIL_MIN_STEP_USD", 0.3, 0, 500); }
/** Deve restare sempre >= TP_MAX: se l'env la mette sotto, si alza al minimo valido. */
export function tpMaxTotalUsd() { return Math.max(envUsd("TP_MAX_TOTAL_USD", 12, 0.1, 1000), tpMaxUsd()); }

// Coefficienti interni (non env): la struttura M1 e l'ATR M1 bastano come input, questi sono solo
// il margine oltre il livello grezzo. Non fanno parte della lista di env nuove della specifica.
const SL_STRUCTURE_MARGIN_ATR_MULT = 0.5;
const SL_SPREAD_MULT = 1.5;
const SL_FALLBACK_ATR_MULT = 1.2;
const TP_ATR_MULT = 1;
const TP_SPREAD_MULT = 1.5;
const MIN_DISTANCE_USD = 0.05;

function validPositive(value: number) { return Number.isFinite(value) && value > 0; }
function validNonNegative(value: number) { return Number.isFinite(value) && value >= 0; }

function decimalPlaces(step: number) {
  const text = step.toString().toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1] ?? 0);
  return (text.split(".")[1] ?? "").length;
}
function normalizeFloat(value: number, tickSizeUsd: number) {
  return Number(value.toFixed(Math.min(12, Math.max(0, decimalPlaces(tickSizeUsd) + 2))));
}

/**
 * Arrotondamento al tick, sempre nella direzione che allontana il livello dal prezzo corrente
 * (mai lo stringe): SL BUY verso il basso, SL SELL verso l'alto, TP BUY verso il basso (piu'
 * vicino, mai oltre il cap), TP SELL verso l'alto. Cosi' l'arrotondamento non puo' mai rendere
 * un trade piu' rischioso di quanto calcolato.
 */
export function normalizeLevelToTick(input: {
  direction: TradeDirection;
  kind: "stopLoss" | "takeProfit";
  value: number;
  tickSizeUsd: number;
}) {
  if (!validPositive(input.value) || !validPositive(input.tickSizeUsd)) return null;
  const scaled = input.value / input.tickSizeUsd;
  const roundUp = (input.direction === "SELL" && input.kind === "stopLoss")
    || (input.direction === "SELL" && input.kind === "takeProfit");
  const ticks = roundUp ? Math.ceil(scaled - 1e-9) : Math.floor(scaled + 1e-9);
  return normalizeFloat(ticks * input.tickSizeUsd, input.tickSizeUsd);
}

/** Minimo miglioramento adattivo prima di reinviare un livello al broker: mai piu' fine del tick. */
export function adaptiveMinImprovementUsd(input: { spreadUsd: number; tickSizeUsd: number; floorUsd?: number }) {
  const floorUsd = input.floorUsd ?? 0.05;
  if (!validNonNegative(input.spreadUsd) || !validPositive(input.tickSizeUsd) || !validNonNegative(floorUsd)) return null;
  return Math.max(input.tickSizeUsd, input.spreadUsd * 0.25, floorUsd);
}

/**
 * Ultimo swing M1 rilevante nella direzione contraria al trade (supporto per un BUY, resistenza
 * per uno SHORT). Riusa la stessa conferma a una candela per lato gia' usata dal trailing M5
 * esistente (positionManager.lastSwing), qui applicata a candele M1.
 */
export function nearestM1Swing(m1: Candle[], direction: TradeDirection) {
  return lastSwing(m1, direction === "BUY" ? "low" : "high");
}

/**
 * Livello SL grezzo (prima del tick-rounding e del cap): swing M1 piu' vicino meno/piu' un
 * margine di ATR M1 e spread. Senza uno swing M1 disponibile, ripiega su un multiplo di ATR dal
 * prezzo di riferimento passato (l'entry all'apertura, il prezzo corrente nel trailing).
 */
export function structuralStopLevel(input: {
  direction: TradeDirection;
  referencePrice: number;
  m1: Candle[];
  atrM1: number;
  spreadUsd: number;
}) {
  const margin = Math.max(input.atrM1 * SL_STRUCTURE_MARGIN_ATR_MULT, input.spreadUsd * SL_SPREAD_MULT, MIN_DISTANCE_USD);
  const swing = nearestM1Swing(input.m1, input.direction);
  if (swing) {
    return input.direction === "BUY" ? swing.low - margin : swing.high + margin;
  }
  const fallbackDistance = Math.max(input.atrM1 * SL_FALLBACK_ATR_MULT, input.spreadUsd * SL_SPREAD_MULT, MIN_DISTANCE_USD);
  return input.direction === "BUY" ? input.referencePrice - fallbackDistance : input.referencePrice + fallbackDistance;
}

export type InitialLevelsRejectReason = "invalid_market_data";

export type InitialLevels = {
  valid: boolean;
  rejectReason: InitialLevelsRejectReason | null;
  stopLoss: number | null;
  takeProfit: number | null;
  slDistanceUsd: number | null;
  tpDistanceUsd: number | null;
  /** true se la distanza strutturale richiesta superava SL_MAX/TP_MAX ed e' stata clampata al cap. */
  slClamped: boolean;
  tpClamped: boolean;
};

/**
 * Livelli iniziali SLTP_MODE=fixed|trailing. Il TP e' sempre quello iniziale qui: la modalita'
 * "trailing" lo fa muovere solo dopo l'apertura (vedi updateTrailingTakeProfit).
 * I cap SL_MAX/TP_MAX sono rigidi ma non bloccano il trade: la distanza viene clampata al cap,
 * cosi' il rischio resta comunque limitato invece di scartare un setup altrimenti valido.
 */
export function initialLevels(input: {
  direction: TradeDirection;
  entry: number;
  m1: Candle[];
  atrM1: number;
  spreadUsd: number;
  brokerMinDistanceUsd?: number;
  tickSizeUsd?: number;
}): InitialLevels {
  const empty = (rejectReason: InitialLevelsRejectReason): InitialLevels => ({
    valid: false, rejectReason, stopLoss: null, takeProfit: null,
    slDistanceUsd: null, tpDistanceUsd: null, slClamped: false, tpClamped: false,
  });
  if (!validPositive(input.entry) || !validPositive(input.atrM1) || !validNonNegative(input.spreadUsd)) {
    return empty("invalid_market_data");
  }
  const brokerMinRaw = input.brokerMinDistanceUsd ?? 0;
  const tickSizeUsd = input.tickSizeUsd ?? 0.01;
  if (!validNonNegative(brokerMinRaw) || !validPositive(tickSizeUsd)) return empty("invalid_market_data");

  const structuralLevel = structuralStopLevel({ direction: input.direction, referencePrice: input.entry, m1: input.m1, atrM1: input.atrM1, spreadUsd: input.spreadUsd });
  const rawSlDistance = input.direction === "BUY" ? input.entry - structuralLevel : structuralLevel - input.entry;
  const requiredSlDistance = Math.max(rawSlDistance, brokerMinRaw, MIN_DISTANCE_USD);
  const slCap = slMaxUsd();
  const slClamped = requiredSlDistance > slCap;
  const slDistanceTarget = Math.min(requiredSlDistance, slCap);

  const rawTpDistance = Math.max(input.atrM1 * TP_ATR_MULT, input.spreadUsd * TP_SPREAD_MULT, brokerMinRaw, MIN_DISTANCE_USD);
  const tpCap = tpMaxUsd();
  const tpClamped = rawTpDistance > tpCap;
  const tpDistanceTarget = Math.min(rawTpDistance, tpCap);

  const rawStopLoss = input.direction === "BUY" ? input.entry - slDistanceTarget : input.entry + slDistanceTarget;
  const rawTakeProfit = input.direction === "BUY" ? input.entry + tpDistanceTarget : input.entry - tpDistanceTarget;
  const stopLoss = normalizeLevelToTick({ direction: input.direction, kind: "stopLoss", value: rawStopLoss, tickSizeUsd });
  const takeProfit = normalizeLevelToTick({ direction: input.direction, kind: "takeProfit", value: rawTakeProfit, tickSizeUsd });
  if (stopLoss === null || takeProfit === null) return empty("invalid_market_data");

  const slDistanceUsd = input.direction === "BUY" ? input.entry - stopLoss : stopLoss - input.entry;
  const tpDistanceUsd = input.direction === "BUY" ? takeProfit - input.entry : input.entry - takeProfit;
  return { valid: true, rejectReason: null, stopLoss, takeProfit, slDistanceUsd, tpDistanceUsd, slClamped, tpClamped };
}

export type SlUpdateDecision =
  | { kind: "update"; stopLoss: number }
  | { kind: "hold"; reason: "not_improved" | "rate_limited" | "invalid_market_data" };

/**
 * SL ricalcolato ad ogni tick sulla struttura M1 corrente: si muove SOLO se il nuovo livello
 * migliora (si stringe verso il prezzo a favore) quello attuale, mai altrimenti. Stesso
 * arrotondamento al tick, stesso miglioramento minimo adattivo e stesso rate-limit del TP.
 */
export function recalcTighterStop(input: {
  direction: TradeDirection;
  currentPrice: number;
  currentStopLoss: number;
  m1: Candle[];
  atrM1: number;
  spreadUsd: number;
  tickSizeUsd?: number;
  minImprovementUsd?: number;
  minImprovementFloorUsd?: number;
  nowMs?: number;
  lastUpdateAtMs?: number | null;
  minUpdateIntervalMs?: number;
}): SlUpdateDecision {
  if (![input.currentPrice, input.currentStopLoss].every(validPositive) || !validPositive(input.atrM1) || !validNonNegative(input.spreadUsd)) {
    return { kind: "hold", reason: "invalid_market_data" };
  }
  const tickSizeUsd = input.tickSizeUsd ?? 0.01;
  const intervalMs = input.minUpdateIntervalMs ?? sltpUpdateMinIntervalMs();
  if (!validPositive(tickSizeUsd) || !validNonNegative(intervalMs)) return { kind: "hold", reason: "invalid_market_data" };

  if (input.lastUpdateAtMs !== undefined && input.lastUpdateAtMs !== null) {
    const nowMs = input.nowMs ?? Date.now();
    if (!Number.isFinite(nowMs) || nowMs < input.lastUpdateAtMs) return { kind: "hold", reason: "invalid_market_data" };
    if (nowMs - input.lastUpdateAtMs < intervalMs) return { kind: "hold", reason: "rate_limited" };
  }

  const rawCandidate = structuralStopLevel({ direction: input.direction, referencePrice: input.currentPrice, m1: input.m1, atrM1: input.atrM1, spreadUsd: input.spreadUsd });
  const candidate = normalizeLevelToTick({ direction: input.direction, kind: "stopLoss", value: rawCandidate, tickSizeUsd });
  if (candidate === null) return { kind: "hold", reason: "invalid_market_data" };
  if (!improvesStop(input.direction, input.currentStopLoss, candidate)) return { kind: "hold", reason: "not_improved" };

  const minImprovementUsd = input.minImprovementUsd
    ?? adaptiveMinImprovementUsd({ spreadUsd: input.spreadUsd, tickSizeUsd, floorUsd: input.minImprovementFloorUsd ?? 0.05 });
  if (minImprovementUsd === null || !validNonNegative(minImprovementUsd)) return { kind: "hold", reason: "invalid_market_data" };
  const improvement = input.direction === "BUY" ? candidate - input.currentStopLoss : input.currentStopLoss - candidate;
  if (improvement + 1e-9 < minImprovementUsd) return { kind: "hold", reason: "not_improved" };

  return { kind: "update", stopLoss: candidate };
}

// --- SLTP_MODE=trailing: TP che si allontana finche' il prezzo fa nuovi massimi/minimi ----------

export type TrailingTpState = {
  /** Massimo (BUY) o minimo (SELL) raggiunto dal prezzo dall'apertura: non torna mai indietro. */
  peak: number;
  /** true dal momento in cui il prezzo ha superato il TP iniziale di TP_EXTEND_TRIGGER_USD. */
  triggered: boolean;
  /** Livello TP attivo: quello iniziale finche' triggered e' false, altrimenti il livello trailing. */
  currentTp: number;
};

export function initTrailingTp(entry: number, initialTp: number): TrailingTpState {
  return { peak: entry, triggered: false, currentTp: initialTp };
}

/**
 * Ricalcola picco e TP trailing per il tick corrente. Il TP resta quello iniziale finche' il
 * prezzo non lo supera di TP_EXTEND_TRIGGER_USD; superata la soglia il TP diventa
 * picco -/+ TP_TRAIL_PULLBACK_USD, mai oltre TP_MAX_TOTAL_USD di distanza dall'apertura.
 */
export function updateTrailingTp(state: TrailingTpState, input: {
  direction: TradeDirection;
  currentPrice: number;
  initialTp: number;
  entry: number;
}): TrailingTpState {
  if (!validPositive(input.currentPrice)) return state;
  const favorable = input.direction === "BUY" ? Math.max(state.peak, input.currentPrice) : Math.min(state.peak, input.currentPrice);
  const advancedPastInitial = input.direction === "BUY" ? favorable - input.initialTp : input.initialTp - favorable;
  const trigger = tpExtendTriggerUsd();

  if (advancedPastInitial < trigger) {
    return { peak: favorable, triggered: false, currentTp: input.initialTp };
  }

  const pullback = tpTrailPullbackUsd();
  const rawTrail = input.direction === "BUY" ? favorable - pullback : favorable + pullback;
  const maxTotal = tpMaxTotalUsd();
  const cappedTrail = input.direction === "BUY"
    ? Math.min(rawTrail, input.entry + maxTotal)
    : Math.max(rawTrail, input.entry - maxTotal);
  return { peak: favorable, triggered: true, currentTp: cappedTrail };
}

export type TpUpdateDecision =
  | { kind: "update"; takeProfit: number }
  | { kind: "hold"; reason: "not_improved" | "rate_limited" | "invalid_market_data" };

/**
 * Decide se il nuovo TP trailing merita un aggiornamento al broker: solo se migliora il
 * precedente di almeno TP_TRAIL_MIN_STEP_USD, con lo stesso rate-limit e arrotondamento al tick
 * usati per lo SL.
 */
export function decideTpBrokerUpdate(input: {
  direction: TradeDirection;
  candidateTp: number;
  currentBrokerTp: number;
  tickSizeUsd?: number;
  minStepUsd?: number;
  nowMs?: number;
  lastUpdateAtMs?: number | null;
  minUpdateIntervalMs?: number;
}): TpUpdateDecision {
  const tickSizeUsd = input.tickSizeUsd ?? 0.01;
  const intervalMs = input.minUpdateIntervalMs ?? sltpUpdateMinIntervalMs();
  if (!validPositive(tickSizeUsd) || !validNonNegative(intervalMs) || !validPositive(input.candidateTp) || !validPositive(input.currentBrokerTp)) {
    return { kind: "hold", reason: "invalid_market_data" };
  }
  if (input.lastUpdateAtMs !== undefined && input.lastUpdateAtMs !== null) {
    const nowMs = input.nowMs ?? Date.now();
    if (!Number.isFinite(nowMs) || nowMs < input.lastUpdateAtMs) return { kind: "hold", reason: "invalid_market_data" };
    if (nowMs - input.lastUpdateAtMs < intervalMs) return { kind: "hold", reason: "rate_limited" };
  }
  const normalized = normalizeLevelToTick({ direction: input.direction, kind: "takeProfit", value: input.candidateTp, tickSizeUsd });
  if (normalized === null) return { kind: "hold", reason: "invalid_market_data" };
  const improvement = input.direction === "BUY" ? normalized - input.currentBrokerTp : input.currentBrokerTp - normalized;
  const minStep = input.minStepUsd ?? tpTrailMinStepUsd();
  if (improvement + 1e-9 < minStep) return { kind: "hold", reason: "not_improved" };
  return { kind: "update", takeProfit: normalized };
}

/**
 * Tocco del TP corrente: prezzo di riferimento BID per un long, ASK per uno short (come lo SL,
 * vedi positionManager.referencePrice). Prima del trigger e' un TP classico: tocca quando il
 * prezzo raggiunge il livello nella direzione del trade (BUY: price >= tp). Dopo il trigger il
 * livello trailing si comporta come uno stop che segue il prezzo: tocca quando il prezzo
 * RETROCEDE fino al livello, mai quando lo supera ancora nella direzione del trade (altrimenti un
 * nuovo massimo chiuderebbe subito il trade invece di allontanare il TP).
 */
export function takeProfitTouched(input: {
  direction: TradeDirection;
  triggered: boolean;
  referencePriceUsd: number;
  tpLevel: number;
}) {
  if (input.triggered) {
    return input.direction === "BUY" ? input.referencePriceUsd <= input.tpLevel : input.referencePriceUsd >= input.tpLevel;
  }
  return input.direction === "BUY" ? input.referencePriceUsd >= input.tpLevel : input.referencePriceUsd <= input.tpLevel;
}

/** close_reason da assegnare quando il TP scatta: tp_trailing solo se il trigger era gia' superato. */
export function tpCloseReason(triggered: boolean): "tp_fixed" | "tp_trailing" {
  return triggered ? "tp_trailing" : "tp_fixed";
}

/**
 * Distanza minima imposta dal broker in valuta, da stopsLevel (in punti) e dalla dimensione del
 * punto del simbolo. Un valore mancante o non finito e' 0 (nessun minimo aggiuntivo noto): mai un
 * blocco silenzioso per un dato che il broker non ha fornito.
 */
export function stopsLevelMinDistanceUsd(stopsLevelPoints: number | undefined, pointSizeUsd: number | undefined) {
  const points = Number(stopsLevelPoints), point = Number(pointSizeUsd);
  if (!Number.isFinite(points) || !Number.isFinite(point) || points < 0 || point <= 0) return 0;
  return points * point;
}

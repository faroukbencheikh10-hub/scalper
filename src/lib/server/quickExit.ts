import type { Quote } from "../types";

/**
 * Modalita' "super scalper" (EXIT_MODE=quick, default): uscita rapida a profitto minimo.
 *
 * - Al broker va solo un takeProfit a TP_QUICK_USD dall'ingresso, NESSUNO stop loss.
 * - Lo stop di emergenza vive solo nel codice: il worker chiude a mercato quando la distanza
 *   contraria dal fill reale supera EMERGENCY_SL_USD.
 * - Nessuna modifica di SL/TP dopo l'apertura, niente breakeven, niente trailing.
 *
 * Tutte le soglie sono DISTANZE DI PREZZO in dollari dal fill reale, non profitti in euro.
 * Con EXIT_MODE=trailing resta la gestione target1 -> breakeven -> trailing di positionManager.
 *
 * Funzioni pure: niente MetaApi, niente database. Il worker le usa per decidere, gli scenari
 * offline per verificarle.
 */

export type ExitMode = "quick" | "trailing";

function envNumber(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name]?.trim(), value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function exitMode(): ExitMode {
  const raw = process.env.EXIT_MODE?.trim().toLowerCase();
  return raw === "trailing" ? "trailing" : "quick";
}

export function quickExitEnabled() {
  return exitMode() === "quick";
}

/** Distanza a favore, in dollari dal fill, a cui si chiude (e TP inviato al broker). */
export function quickTpUsd() {
  return envNumber("TP_QUICK_USD", 1.5, 0.1, 100);
}

/** Distanza contraria, in dollari dal fill, oltre cui il worker chiude a mercato. */
export function emergencySlUsd() {
  return envNumber("EMERGENCY_SL_USD", 15, 0.5, 500);
}

/** Pausa dopo qualsiasi chiusura, in modalita' quick. In trailing resta SCALPER_MIN_REENTRY_SEC. */
export function quickReEntrySec() {
  return envNumber("RE_ENTRY_SEC", 30, 0, 3600);
}

export type QuickCloseReason = "tp_quick" | "emergency";

/** Motivi di chiusura possibili in modalita' quick, oltre a quelli forzati (flatten, stop, watchdog). */
export type QuickExitCloseReason = QuickCloseReason | "manual" | "flatten" | "stop" | "watchdog";

export type QuickExitState = {
  positionId: string;
  signalId: string | null;
  setup: string;
  direction: "BUY" | "SELL";
  /** Fill reale (mt5_open_price). Finche' fillPending e' true e' l'entry teorica. */
  openPrice: number;
  /** TP inviato al broker, null se il broker lo ha rifiutato (tp_rejected). */
  tpBroker: number | null;
  tpRejected: boolean;
  fillPending: boolean;
  /** Chiusura a mercato in corso: motivo e tentativi fatti. */
  closing: { reason: QuickCloseReason; attempts: number; startedAt: string } | null;
};

export function openQuickExit(input: {
  positionId: string;
  signalId: string | null;
  setup: string;
  direction: "BUY" | "SELL";
  openPrice: number;
  tpBroker: number | null;
  tpRejected?: boolean;
  fillPending?: boolean;
}): QuickExitState {
  return {
    positionId: input.positionId,
    signalId: input.signalId,
    setup: input.setup,
    direction: input.direction,
    openPrice: input.openPrice,
    tpBroker: input.tpBroker,
    tpRejected: input.tpRejected ?? false,
    fillPending: input.fillPending ?? false,
    closing: null,
  };
}

/** TP quick da inviare al broker: entry +/- TP_QUICK_USD, arrotondato al tick verso l'interno. */
export function quickTakeProfit(direction: "BUY" | "SELL", entry: number, tpUsd: number) {
  const raw = direction === "BUY" ? entry + tpUsd : entry - tpUsd;
  return direction === "BUY" ? Math.floor(raw * 100) / 100 : Math.ceil(raw * 100) / 100;
}

/** Prezzo di riferimento sul tick: BID per un long, ASK per uno short. */
export function quickReferencePrice(direction: "BUY" | "SELL", quote: Quote) {
  return direction === "BUY" ? quote.bid : quote.ask;
}

/** Distanza a favore (positiva) o contraria (negativa) dal fill, in dollari. */
export function favourableDistance(direction: "BUY" | "SELL", openPrice: number, price: number) {
  return direction === "BUY" ? price - openPrice : openPrice - price;
}

/**
 * Decisione a ogni tick. Ordine: prima il profitto, poi l'emergenza; nessun'altra chiusura
 * automatica e nessun limite di durata.
 */
export function quickTickDecision(
  state: Pick<QuickExitState, "direction" | "openPrice">,
  quote: Quote,
  tpUsd: number,
  emergencyUsd: number,
): QuickCloseReason | null {
  const distance = favourableDistance(state.direction, state.openPrice, quickReferencePrice(state.direction, quote));
  if (distance >= tpUsd) return "tp_quick";
  if (distance <= -emergencyUsd) return "emergency";
  return null;
}

/** Fill reale arrivato in ritardo: le soglie si misurano da li'. Il TP al broker non si tocca. */
export function quickRetargetOnFill(state: QuickExitState, fillPrice: number): QuickExitState {
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) return state;
  return { ...state, openPrice: fillPrice, fillPending: false };
}

/** Tentativi massimi e intervallo della chiusura a mercato su errore/timeout MetaApi. */
export const QUICK_CLOSE_MAX_ATTEMPTS = 5;
export const QUICK_CLOSE_RETRY_MS = 500;

export function startClosing(state: QuickExitState, reason: QuickCloseReason, nowMs: number): QuickExitState {
  if (state.closing) return state;
  return { ...state, closing: { reason, attempts: 0, startedAt: new Date(nowMs).toISOString() } };
}

export function recordCloseAttempt(state: QuickExitState): QuickExitState {
  if (!state.closing) return state;
  return { ...state, closing: { ...state.closing, attempts: state.closing.attempts + 1 } };
}

export function closeAttemptsExhausted(state: QuickExitState) {
  return state.closing !== null && state.closing.attempts >= QUICK_CLOSE_MAX_ATTEMPTS;
}

/**
 * Motivo letto dal prezzo di chiusura reale quando NON e' stato il worker a chiudere (TP colpito
 * dal broker, chiusura manuale): tp_quick se la distanza a favore ha raggiunto la soglia, al netto
 * di una piccola tolleranza per lo slittamento; emergency se ha raggiunto quella contraria;
 * altrimenti manual.
 */
export const QUICK_LEVEL_TOLERANCE_USD = 0.1;

export function quickCloseReasonFromPrice(
  direction: "BUY" | "SELL",
  openPrice: number,
  closePrice: number,
  tpUsd: number,
  emergencyUsd: number,
): QuickExitCloseReason {
  if (!Number.isFinite(openPrice) || !Number.isFinite(closePrice)) return "manual";
  const distance = favourableDistance(direction, openPrice, closePrice);
  if (distance >= tpUsd - QUICK_LEVEL_TOLERANCE_USD) return "tp_quick";
  if (distance <= -(emergencyUsd - QUICK_LEVEL_TOLERANCE_USD)) return "emergency";
  return "manual";
}

/** In modalita' quick conta come perdita SOLO la chiusura di emergenza. */
export function quickCountsAsLoss(closeReason: string | null | undefined) {
  return closeReason === "emergency";
}

/** Pausa re-entry: bloccata finche' non sono passati reEntrySec dall'ultima chiusura. */
export function reEntryBlocked(lastCloseAtMs: number, nowMs: number, reEntrySec: number) {
  if (!(lastCloseAtMs > 0)) return false;
  return nowMs - lastCloseAtMs < reEntrySec * 1000;
}

/**
 * Rifiuto del broker per stop non validi (TRADE_RETCODE_INVALID_STOPS = 10016): il TP quick e'
 * troppo vicino per il simbolo. In quel caso si apre senza TP e chiude il worker.
 */
export function isInvalidStopsError(error: unknown) {
  const record = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  const numeric = Number(record.numericCode);
  const text = [record.stringCode, record.message, record.description, error instanceof Error ? error.message : ""]
    .map((value) => String(value ?? "")).join(" ").toUpperCase();
  return numeric === 10016 || text.includes("INVALID_STOPS") || text.includes("INVALID STOPS");
}

/** Stops da inviare col market order in modalita' quick: nessuno SL, TP quick (o niente se rifiutato). */
export function quickOrderStops(direction: "BUY" | "SELL", entry: number, tpUsd: number, withoutTp = false) {
  return {
    stopLoss: undefined as number | undefined,
    takeProfit: withoutTp ? undefined : quickTakeProfit(direction, entry, tpUsd),
  };
}

import type { Candle, Quote } from "../types";

/**
 * Uscita gestita dal worker per m1_short e m1_range: nessun take profit inviato al broker e
 * nessun limite di durata. L'ordine parte con il solo SL iniziale, il target1 sposta lo stop a
 * breakeven e da li' in poi lo stop segue la struttura M5. Lo stop non torna mai indietro.
 *
 * Qui dentro non si parla con MetaApi ne' con il database: sono funzioni pure, il worker le usa
 * per decidere e gli scenari offline per verificarle.
 */

/** Distanza fissa dallo swing M5 usata dal trailing. */
export const TRAILING_BUFFER_USD = 0.2;

export type ManagedCloseReason = "sl_initial" | "sl_breakeven" | "sl_trailing" | "flatten" | "stop" | "watchdog";

/** I due setup a uscita gestita. La mtf mantiene il TP al broker e non passa mai di qui. */
export function isManagedSetup(setup: string | null | undefined) {
  return setup === "m1_short" || setup === "m1_range";
}

export type ManagedExitState = {
  positionId: string;
  signalId: string | null;
  setup: string;
  direction: "BUY" | "SELL";
  openPrice: number;
  initialStop: number;
  /** Il livello che il codice calcolava come TP: resta un obiettivo interno, non va al broker. */
  target1: number;
  stopLoss: number;
  target1Hit: boolean;
  breakevenPrice: number | null;
  breakevenAt: string | null;
  trailingUpdates: number;
};

export type ManagedAction =
  | { kind: "breakeven"; stopLoss: number; at: string }
  | { kind: "trailing"; from: number; to: number; swingAt: string };

export function openManagedExit(input: {
  positionId: string;
  signalId: string | null;
  setup: string;
  direction: "BUY" | "SELL";
  openPrice: number;
  initialStop: number;
  target1: number;
}): ManagedExitState {
  return {
    ...input,
    stopLoss: input.initialStop,
    target1Hit: false,
    breakevenPrice: null,
    breakevenAt: null,
    trailingUpdates: 0,
  };
}

/** Prezzo di riferimento sul tick: BID per un long, ASK per uno short. */
export function referencePrice(direction: "BUY" | "SELL", quote: Quote) {
  return direction === "BUY" ? quote.bid : quote.ask;
}

export function target1Reached(state: ManagedExitState, quote: Quote) {
  const price = referencePrice(state.direction, quote);
  return state.direction === "BUY" ? price >= state.target1 : price <= state.target1;
}

/** Lo stop lo esegue il broker: questa e' la stessa lettura, usata da log e scenari. */
export function stopHit(state: ManagedExitState, quote: Quote) {
  const price = referencePrice(state.direction, quote);
  return state.direction === "BUY" ? price <= state.stopLoss : price >= state.stopLoss;
}

/** Breakeven: prezzo di apertura piu' il buffer per un long, meno il buffer per uno short. */
export function breakevenStop(direction: "BUY" | "SELL", openPrice: number, buffer: number) {
  const raw = direction === "BUY" ? openPrice + buffer : openPrice - buffer;
  return Math.round(raw * 100) / 100;
}

/**
 * Ultimo swing M5 confermato, con una candela per lato: la candela in formazione non arriva qui,
 * l'array contiene solo M5 chiuse.
 */
export function lastSwing(m5: Candle[], kind: "high" | "low"): Candle | null {
  for (let i = m5.length - 2; i >= 1; i--) {
    if (kind === "high" && m5[i].high > m5[i - 1].high && m5[i].high > m5[i + 1].high) return m5[i];
    if (kind === "low" && m5[i].low < m5[i - 1].low && m5[i].low < m5[i + 1].low) return m5[i];
  }
  return null;
}

export function trailingStop(direction: "BUY" | "SELL", m5: Candle[]) {
  const swing = lastSwing(m5, direction === "BUY" ? "low" : "high");
  if (!swing) return null;
  const level = direction === "BUY"
    ? Math.floor((swing.low - TRAILING_BUFFER_USD) * 100) / 100
    : Math.ceil((swing.high + TRAILING_BUFFER_USD) * 100) / 100;
  return { level, bar: swing };
}

/** Lo stop si muove solo a favore: piu' alto sui long, piu' basso sugli short. */
export function improvesStop(direction: "BUY" | "SELL", current: number, candidate: number) {
  return direction === "BUY" ? candidate > current : candidate < current;
}

/** Primo tick che tocca target1: lo stop va a breakeven, una volta sola. */
export function tickAction(state: ManagedExitState, quote: Quote, nowMs: number, buffer: number): ManagedAction | null {
  if (state.target1Hit || !target1Reached(state, quote)) return null;
  return { kind: "breakeven", stopLoss: breakevenStop(state.direction, state.openPrice, buffer), at: new Date(nowMs).toISOString() };
}

/** Trailing sulla struttura M5: solo dopo il breakeven e solo alla chiusura di una M5. */
export function m5CloseAction(state: ManagedExitState, m5: Candle[]): ManagedAction | null {
  if (!state.target1Hit || state.breakevenPrice === null) return null;
  const trail = trailingStop(state.direction, m5);
  if (!trail || !improvesStop(state.direction, state.stopLoss, trail.level)) return null;
  return { kind: "trailing", from: state.stopLoss, to: trail.level, swingAt: trail.bar.datetime };
}

export function applyAction(state: ManagedExitState, action: ManagedAction): ManagedExitState {
  if (action.kind === "breakeven") {
    return { ...state, target1Hit: true, stopLoss: action.stopLoss, breakevenPrice: action.stopLoss, breakevenAt: action.at };
  }
  return { ...state, stopLoss: action.to, trailingUpdates: state.trailingUpdates + 1 };
}

/**
 * Motivo di chiusura quando e' scattato lo stop: solo sl_initial e' una perdita vera, gli altri
 * sono uscite gestite e non contano per il loss lock.
 */
export function closeReasonFromState(state: Pick<ManagedExitState, "trailingUpdates" | "breakevenAt">): ManagedCloseReason {
  if (state.trailingUpdates > 0) return "sl_trailing";
  if (state.breakevenAt) return "sl_breakeven";
  return "sl_initial";
}

/** Con una posizione aperta nessun setup viene valutato per l'ingresso. */
export function entryBlockedByOpenPositions(openPositions: number, maxOpenPositions: number) {
  return openPositions >= maxOpenPositions;
}

/**
 * Un segnale nella direzione opposta a una posizione aperta non chiude e non inverte:
 * resta solo a log come ignored_opposite_signal.
 */
export function oppositeSignalIgnored(openDirections: Array<"BUY" | "SELL">, signalDirection: string) {
  return (signalDirection === "BUY" || signalDirection === "SELL")
    && openDirections.length > 0
    && !openDirections.includes(signalDirection);
}

/** Solo lo stop iniziale conta come perdita per loss lock e pausa perdite consecutive. */
export function countsAsLoss(outcome: string | null | undefined, closeReason: string | null | undefined) {
  return outcome === "LOSS" && (closeReason ?? "sl_initial") === "sl_initial";
}

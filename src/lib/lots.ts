// Formule e costanti sui lotti condivise fra worker, API e dashboard.
// Nessuna lettura di process.env qui: questo modulo viene importato anche dal client. La specifica
// di contratto dello strumento arriva sempre da fuori (server/symbolConfig.ts).
import type { ContractSpec } from "./symbols";

/**
 * Chiave storica, quando esisteva un solo strumento: resta come fallback dei lotti di XAUUSD.
 * I lotti correnti stanno in exec_lots_<simbolo> (vedi execLotsSettingKey in symbols.ts).
 */
export const EXEC_LOTS_SETTING_KEY = "exec_lots";

/** Valori proposti dal selettore della dashboard. */
export const LOT_CHOICES = [0.01, 0.02, 0.03, 0.05, 0.07, 0.1];

/** Distanza di stop usata quando non esiste ancora un segnale da cui leggerla. */
export const DEFAULT_STOP_DISTANCE = 2;

export function roundLots(value: number) {
  return Math.round(value * 100) / 100;
}

export function clampLotsWithin(value: number, min: number, max: number) {
  const floor = roundLots(min);
  const ceiling = Math.max(floor, roundLots(max));
  return Math.min(ceiling, Math.max(floor, roundLots(value)));
}

/**
 * Margine richiesto ≈ lotti * contract size * prezzo / leva. Contract size e leva dipendono dallo
 * strumento (100 once per lotto sull'oro, 1 unita' di indice su NAS100): vanno passati sempre, mai
 * dati per scontati, altrimenti su NAS100 il margine risulterebbe ~100 volte quello vero e il
 * preflight bloccherebbe ogni ordine in silenzio.
 */
export function requiredMargin(lots: number, price: number, spec: ContractSpec) {
  return (lots * spec.contractSize * price) / spec.leverage;
}

/** Perdita allo stop ≈ lotti * contract size * |entry - SL|, nella valuta del conto. */
export function lossAtStop(lots: number, stopDistance: number, contractSize: number) {
  return lots * contractSize * Math.abs(stopDistance);
}

/** Distanza entry/SL dell'ultimo segnale, con fallback a DEFAULT_STOP_DISTANCE. */
export function stopDistanceFrom(entry: unknown, stopLoss: unknown) {
  const a = Number(entry);
  const b = Number(stopLoss);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return DEFAULT_STOP_DISTANCE;
  const distance = Math.abs(a - b);
  return distance > 0 ? distance : DEFAULT_STOP_DISTANCE;
}

/**
 * Cambio USD/EUR approssimativo, solo per mostrare in dashboard un equivalente in € delle
 * distanze SL/TP in $ (SLTP_MODE=fixed|trailing): a 0.01 lotti 1$ di distanza ≈ 0.85€ di P&L.
 * Mai usato per rischio, ordini o log del worker: quelli restano sempre e solo in $ di distanza.
 */
export const USD_TO_EUR_RATE_APPROX = 0.85;

/** Equivalente approssimativo in € di una distanza di prezzo ai lotti correnti dello strumento. */
export function usdDistanceToEurApprox(distanceUsd: number, lots: number, contractSize: number) {
  if (![distanceUsd, lots, contractSize].every(Number.isFinite)) return null;
  return distanceUsd * contractSize * lots * USD_TO_EUR_RATE_APPROX;
}

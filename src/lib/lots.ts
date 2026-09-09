// Formule e costanti sui lotti condivise fra worker, API e dashboard.
// Nessuna lettura di process.env qui: questo modulo viene importato anche dal client.

export const EXEC_LOTS_SETTING_KEY = "exec_lots";

/** Valori proposti dal selettore della dashboard. */
export const LOT_CHOICES = [0.01, 0.02, 0.03, 0.05, 0.07, 0.1];

/** Once di XAUUSD per lotto standard. */
export const CONTRACT_SIZE = 100;

/** Leva usata per la stima del margine richiesto. */
export const MARGIN_LEVERAGE = 500;

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

/** Margine richiesto ≈ lotti * 100 * prezzo / 500. */
export function requiredMargin(lots: number, price: number) {
  return (lots * CONTRACT_SIZE * price) / MARGIN_LEVERAGE;
}

/** Perdita allo stop ≈ lotti * 100 * |entry - SL|. */
export function lossAtStop(lots: number, stopDistance: number) {
  return lots * CONTRACT_SIZE * Math.abs(stopDistance);
}

/** Distanza entry/SL dell'ultimo segnale, con fallback a DEFAULT_STOP_DISTANCE. */
export function stopDistanceFrom(entry: unknown, stopLoss: unknown) {
  const a = Number(entry);
  const b = Number(stopLoss);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return DEFAULT_STOP_DISTANCE;
  const distance = Math.abs(a - b);
  return distance > 0 ? distance : DEFAULT_STOP_DISTANCE;
}

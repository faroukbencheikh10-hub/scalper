// Modalita' di uscita per le NUOVE posizioni, scelta dalla dashboard e letta dal worker al
// momento dell'apertura (mai durante la vita della posizione: una volta aperta resta con la
// modalita' con cui e' nata). Nessuna lettura di process.env qui: modulo puro condiviso da
// dashboard, API e worker, come lots.ts.

export const EXIT_MODE_SETTING_KEY = "exit_mode";
export const FAST_TP_USD_SETTING_KEY = "fast_tp_usd";

export type ExitMode = "normal" | "fast";

export const DEFAULT_EXIT_MODE: ExitMode = "normal";
/**
 * Default e minimo del TP fisso, in unita' di prezzo: questi restano i valori di XAUUSD. Su un
 * altro strumento le stesse distanze non hanno lo stesso significato, quindi chi conosce il simbolo
 * attivo (server/symbolConfig.ts) passa i propri limiti alle funzioni qui sotto.
 */
export const DEFAULT_FAST_TP_USD = 2.5;
export const MIN_FAST_TP_USD = 0.5;

/** Limiti del TP fisso per lo strumento attivo; senza, restano quelli storici di XAUUSD. */
export type FastTpBounds = { minUsd: number; defaultUsd: number };
const XAUUSD_FAST_TP_BOUNDS: FastTpBounds = { minUsd: MIN_FAST_TP_USD, defaultUsd: DEFAULT_FAST_TP_USD };
export const FAST_TP_STEP_USD = 0.5;

/**
 * "normal" (oggi): nessun TP al broker sui setup gestiti, breakeven a target1 poi trailing M5.
 * "fast": TP fisso a fast_tp_usd dall'entry mandato direttamente al broker, chiusura immediata,
 * nessun breakeven ne' trailing. Qualsiasi valore non riconosciuto ricade su "normal".
 */
export function resolveExitMode(raw: string | undefined | null): ExitMode {
  return raw === "fast" ? "fast" : "normal";
}

/** Non scende mai sotto il minimo dello strumento; nessun massimo, e' l'utente a sceglierlo in dashboard. */
export function clampFastTpUsd(value: number, bounds: FastTpBounds = XAUUSD_FAST_TP_BOUNDS): number {
  if (!Number.isFinite(value)) return bounds.defaultUsd;
  return Number(Math.max(bounds.minUsd, value).toFixed(2));
}

export function resolveFastTpUsd(raw: string | undefined | null, bounds: FastTpBounds = XAUUSD_FAST_TP_BOUNDS): number {
  const value = Number(raw);
  return Number.isFinite(value) ? clampFastTpUsd(value, bounds) : bounds.defaultUsd;
}

/**
 * Prezzo target della modalita' fast: entry + distanza per un long, entry - distanza per uno
 * short, arrotondato al centesimo verso l'entry (mai oltre) cosi' il TP scatta al massimo alla
 * distanza richiesta, mai piu' in la'.
 */
export function fastTargetPrice(direction: "BUY" | "SELL", entry: number, fastTpUsd: number, bounds: FastTpBounds = XAUUSD_FAST_TP_BOUNDS): number {
  const distance = clampFastTpUsd(fastTpUsd, bounds);
  const raw = direction === "BUY" ? entry + distance : entry - distance;
  return direction === "BUY" ? Math.floor(raw * 100) / 100 : Math.ceil(raw * 100) / 100;
}

/**
 * Cooldown da margine insufficiente: blocco aggiuntivo e indipendente da LOSS_LOCK, CONSEC_LOSS e
 * dalla pausa re-entry, per singola combinazione symbol+setup+direzione. Nasce solo dal fallimento
 * specifico del margine e non tocca i criteri d'ingresso di nessun setup.
 *
 * Qui dentro non si parla con MetaApi ne' con il database: funzioni pure, il worker le usa per
 * decidere e gli scenari offline per verificarle.
 */

/** MT5 TRADE_RETCODE_NO_MONEY: fondi insufficienti. E' gia' fra i codici di definitelyRejected. */
export const MARGIN_NO_MONEY_CODE = 10019;

/** Esito di executeStreaming letto in sola lettura: interessano status, testo errore e retcode. */
export type MarginFailureLike = {
  status?: string;
  error?: unknown;
  reason?: unknown;
  numericCode?: unknown;
};

/** Scadenza del blocco per chiave symbol|setup|direzione. Vive in memoria come lossLockUntil. */
export type MarginCooldownState = Map<string, number>;

export function marginCooldownKey(symbol: string, setup: string | null | undefined, direction: "BUY" | "SELL") {
  return [symbol, setup ?? "-", direction].join("|");
}

/**
 * Le due sole firme reali del fallimento per margine nel codice, verificate su executeStreaming:
 * - status "insufficient_margin": il preflight sul free margin, l'ordine non parte nemmeno;
 * - retcode 10019 (TRADE_RETCODE_NO_MONEY) rifiutato dal broker, che arriva come status "error" con
 *   numericCode propagato — o, se il codice non c'e', dentro il messaggio dell'errore, che porta
 *   il JSON della risposta MetaApi ("Esito ordine non confermato: {...}").
 * Qualsiasi altro errore d'ordine NON arma il cooldown: resta gestito com'e' sempre stato.
 */
export function isInsufficientMarginFailure(execution: MarginFailureLike): boolean {
  if (execution.status === "insufficient_margin") return true;
  if (execution.status !== "error") return false;
  if (Number(execution.numericCode) === MARGIN_NO_MONEY_CODE) return true;
  const text = typeof execution.error === "string" ? execution.error : "";
  return new RegExp(`"numericCode"\\s*:\\s*${MARGIN_NO_MONEY_CODE}\\b`).test(text)
    || /TRADE_RETCODE_NO_MONEY/i.test(text);
}

/** Scadenza ancora attiva, o null. Le chiavi scadute si puliscono da sole alla prima lettura. */
export function marginCooldownActive(state: MarginCooldownState, key: string, nowMs: number): number | null {
  const until = state.get(key);
  if (until === undefined) return null;
  if (until <= nowMs) {
    state.delete(key);
    return null;
  }
  return until;
}

/**
 * Arma il blocco. `armed` e' true solo quando NON era gia' attivo: il worker logga l'attivazione
 * una volta sola, mai un log per ogni tick bloccato.
 *
 * Un secondo fallimento dentro la finestra non la allunga: puo' arrivare solo da un ordine gia'
 * partito prima del blocco, cioe' dalla stessa condizione di margine, non da una nuova. Allungare
 * riaprirebbe la porta a una finestra che non scade mai.
 */
export function armMarginCooldown(
  state: MarginCooldownState,
  key: string,
  nowMs: number,
  cooldownMs: number,
): { armed: boolean; until: number } {
  const active = marginCooldownActive(state, key, nowMs);
  if (active !== null) return { armed: false, until: active };
  const until = nowMs + Math.max(0, cooldownMs);
  // cooldownMs = 0 (MARGIN_FAIL_COOLDOWN_SEC=0) significa blocco spento: non si registra nulla.
  if (until <= nowMs) return { armed: false, until };
  state.set(key, until);
  return { armed: true, until };
}

/** Motivo mostrato in stream_last_decision e nella card Setup valutati della dashboard. */
export function marginCooldownReason(
  setup: string | null | undefined,
  direction: "BUY" | "SELL",
  until: number,
  nowMs: number,
) {
  const secondsLeft = Math.max(0, Math.ceil((until - nowMs) / 1000));
  return `Margine insufficiente su ${setup ?? "-"} ${direction}: cooldown attivo fino alle `
    + `${new Date(until).toISOString().slice(11, 19)} UTC (altri ${secondsLeft} s).`;
}

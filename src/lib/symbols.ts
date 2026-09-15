// Strumento tradato: chiavi logiche, impostazioni per simbolo e specifica di contratto.
// Nessuna lettura di process.env qui: questo modulo viene importato anche dal client, come lots.ts.
// La risoluzione delle env con prefisso vive in server/symbolConfig.ts.

/** Chiave logica dello strumento, indipendente dal nome che il broker usa per il simbolo. */
export type TradedSymbol = "XAUUSD" | "NAS100";

export const TRADED_SYMBOLS: TradedSymbol[] = ["XAUUSD", "NAS100"];

export const ACTIVE_SYMBOL_SETTING_KEY = "active_symbol";
export const DEFAULT_TRADED_SYMBOL: TradedSymbol = "XAUUSD";

/** Qualsiasi valore non riconosciuto ricade su XAUUSD: lo strumento storico non cambia per una svista. */
export function resolveTradedSymbol(raw: string | null | undefined): TradedSymbol {
  const value = String(raw ?? "").trim().toUpperCase();
  return (TRADED_SYMBOLS as string[]).includes(value) ? value as TradedSymbol : DEFAULT_TRADED_SYMBOL;
}

/** Lotti separati per strumento: exec_lots_xauusd / exec_lots_nas100. */
export function execLotsSettingKey(symbol: TradedSymbol) {
  return `exec_lots_${symbol.toLowerCase()}`;
}

/** TP fisso di exit_mode=fast separato per strumento: fast_tp_usd_xauusd / fast_tp_usd_nas100. */
export function fastTpSettingKey(symbol: TradedSymbol) {
  return `fast_tp_usd_${symbol.toLowerCase()}`;
}

/**
 * Specifica di contratto del broker, per margine e P/L: dipende dallo strumento, non dal prezzo.
 * XAUUSD: 100 once per lotto standard. NAS100 cash: 1 unita' di indice per lotto.
 * Sono dati del broker (Fusion Markets): i default qui sotto vanno confermati su MT5 e, se diversi,
 * sovrascritti con XAUUSD_CONTRACT_SIZE/NAS100_CONTRACT_SIZE e *_MARGIN_LEVERAGE.
 */
export type ContractSpec = { contractSize: number; leverage: number };

export const CONTRACT_SPEC_DEFAULTS: Record<TradedSymbol, ContractSpec> = {
  XAUUSD: { contractSize: 100, leverage: 500 },
  NAS100: { contractSize: 1, leverage: 200 },
};

/**
 * Valore di un'impostazione per strumento: vince la chiave nuova (exec_lots_xauusd...), e solo per
 * XAUUSD si ripiega su quella storica senza simbolo, cosi' il valore gia' scelto in dashboard non
 * si perde al primo deploy. Su NAS100 non esiste storico da ereditare.
 */
export function pickSymbolSetting(
  symbol: TradedSymbol,
  perSymbol: string | null | undefined,
  legacy: string | null | undefined,
): string | undefined {
  if (perSymbol !== null && perSymbol !== undefined && String(perSymbol).trim() !== "") return perSymbol;
  if (symbol !== DEFAULT_TRADED_SYMBOL) return undefined;
  return legacy !== null && legacy !== undefined && String(legacy).trim() !== "" ? legacy : undefined;
}

/**
 * Si puo' passare da uno strumento all'altro? Regola unica, usata sia dall'API di controllo sia dal
 * worker: con una posizione aperta su QUALUNQUE strumento il cambio e' vietato (il limite di una
 * posizione e' di conto, non per simbolo), e un ciclo d'ordine in volo lo rimanda.
 */
export type SymbolSwitchDecision = { allowed: boolean; reason: string | null };

export function symbolSwitchDecision(input: {
  current: TradedSymbol;
  requested: TradedSymbol;
  openPositionSymbol: TradedSymbol | null;
  busy?: boolean;
}): SymbolSwitchDecision {
  if (input.requested === input.current) {
    return { allowed: false, reason: `Strumento gia' su ${input.current}.` };
  }
  if (input.openPositionSymbol) {
    return {
      allowed: false,
      reason: `Posizione aperta su ${input.openPositionSymbol}: chiudila prima di passare a ${input.requested}.`,
    };
  }
  if (input.busy) {
    return {
      allowed: false,
      reason: `Ordine o chiusura in corso su ${input.current}: cambio a ${input.requested} rimandato al prossimo controllo.`,
    };
  }
  return { allowed: true, reason: null };
}

/** Etichetta leggibile dello strumento per dashboard, log e Telegram. */
export function tradedSymbolLabel(symbol: TradedSymbol) {
  return symbol === "NAS100" ? "NAS100 (US Tech 100)" : "XAUUSD (oro)";
}

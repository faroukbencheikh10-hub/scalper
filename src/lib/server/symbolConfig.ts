// Parametri per strumento: gli stessi setup, con i numeri dello strumento attivo.
//
// Tutto cio' che e' espresso in unita' di prezzo ($ sull'oro, punti indice su NAS100) vive qui.
// I moltiplicatori ATR e i conteggi di candele restano condivisi e continuano a leggersi con la
// env semplice dentro la strategia: sono adimensionali, si adattano da soli alla volatilita'.
//
// Ordine di risoluzione di ogni parametro:
//   1. env con prefisso dello strumento (NAS100_SL_MIN_USD, XAUUSD_SL_MIN_USD);
//   2. SOLO per XAUUSD, la env storica senza prefisso (SL_MIN_USD), cosi' il deploy dell'oro gia'
//      in produzione non cambia di un centesimo quando questo modulo entra in gioco;
//   3. il default per strumento della tabella qui sotto.
// Un valore fuori dai limiti min/max viene ignorato e si passa al livello successivo, esattamente
// come fa gia' env() nella strategia.

import {
  CONTRACT_SPEC_DEFAULTS, DEFAULT_TRADED_SYMBOL, type ContractSpec, type TradedSymbol,
} from "../symbols";
import type { FastTpBounds } from "../exitMode";

/**
 * Default per strumento. La colonna XAUUSD e' identica ai valori storici: nessun cambio di
 * comportamento sull'oro. La colonna NAS100 NON e' una copia: e' scalata sulla volatilita' tipica
 * dello strumento, non sul prezzo. Ordine di grandezza usato (media giornaliera, non un fermo
 * immagine): XAUUSD ~3.500$ con ATR M1 di ~1-3$ ed escursione giornaliera ~50$ (~1,5%); NAS100
 * ~22.000 punti con ATR M1 di ~5-15 punti ed escursione giornaliera ~300 punti (~1,3%). A parita'
 * di frazione di volatilita' una distanza su NAS100 vale circa 5 volte la stessa distanza sull'oro,
 * ed e' il fattore applicato qui sotto e poi arrotondato a valori operativi.
 *
 * Restano numeri di partenza: vanno ritarati sui primi giorni di dati reali di NAS100, come e'
 * stato fatto per l'oro.
 */
export const PRICE_PARAM_DEFAULTS = {
  XAUUSD: {
    // Filtri comuni
    SCALPER_MAX_SPREAD: 1.2,
    SCALPER_MIN_ATR_M1: 0.8,
    SCALPER_MAX_ATR_M1: 6,
    ENTRY_BUFFER_USD: 0.1,
    // mtf
    SL_MIN_USD: 3,
    SL_MAX_USD: 8,
    MTF_ROUNDTRIP_COMMISSION_PER_LOT_USD: 7,
    // m1_short
    SHORT_SL_MIN_USD: 3,
    SHORT_SL_MAX_USD: 8,
    SHORT_TP_MIN_USD: 1.5,
    SHORT_TP_MAX_USD: 3,
    // m1_range
    RANGE_MIN_USD: 3,
    RANGE_SL_MIN_USD: 2,
    RANGE_SL_MAX_USD: 8,
    RANGE_TP_MIN_USD: 1.5,
    SL_BUFFER_USD: 0.3,
    TP_BUFFER_USD: 0.3,
    // quick_tick
    QUICK_TICK_BREAKOUT_BUFFER_USD: 0.15,
    QUICK_TICK_MAX_SPREAD: 0.2,
    QUICK_TICK_TP_MIN_USD: 2,
    QUICK_TICK_TP_MAX_USD: 4,
    QUICK_TICK_SL_MIN_USD: 2.5,
    QUICK_TICK_SL_MAX_USD: 6,
    // Uscita gestita e SLTP_MODE
    TRAILING_BUFFER_USD: 0.2,
    SL_MAX: 15,
    TP_MAX: 10,
    TP_EXTEND_TRIGGER_USD: 1,
    TP_TRAIL_PULLBACK_USD: 2,
    TP_TRAIL_MIN_STEP_USD: 0.3,
    TP_MAX_TOTAL_USD: 12,
    // exit_mode=fast
    MIN_FAST_TP_USD: 0.5,
    DEFAULT_FAST_TP_USD: 2.5,
  },
  NAS100: {
    SCALPER_MAX_SPREAD: 6,
    SCALPER_MIN_ATR_M1: 4,
    SCALPER_MAX_ATR_M1: 30,
    ENTRY_BUFFER_USD: 0.5,
    SL_MIN_USD: 15,
    SL_MAX_USD: 40,
    // Commissione round trip per lotto: sugli indici Fusion e' molto piu' bassa che sui metalli,
    // ma il costo in punti si ottiene dividendo per la contract size (1 su NAS100, 100 sull'oro).
    MTF_ROUNDTRIP_COMMISSION_PER_LOT_USD: 2,
    SHORT_SL_MIN_USD: 15,
    SHORT_SL_MAX_USD: 40,
    SHORT_TP_MIN_USD: 8,
    SHORT_TP_MAX_USD: 15,
    RANGE_MIN_USD: 15,
    RANGE_SL_MIN_USD: 10,
    RANGE_SL_MAX_USD: 40,
    RANGE_TP_MIN_USD: 8,
    SL_BUFFER_USD: 1.5,
    TP_BUFFER_USD: 1.5,
    QUICK_TICK_BREAKOUT_BUFFER_USD: 0.75,
    QUICK_TICK_MAX_SPREAD: 1,
    QUICK_TICK_TP_MIN_USD: 10,
    QUICK_TICK_TP_MAX_USD: 20,
    QUICK_TICK_SL_MIN_USD: 12,
    QUICK_TICK_SL_MAX_USD: 30,
    TRAILING_BUFFER_USD: 1,
    SL_MAX: 75,
    TP_MAX: 50,
    TP_EXTEND_TRIGGER_USD: 5,
    TP_TRAIL_PULLBACK_USD: 10,
    TP_TRAIL_MIN_STEP_USD: 1.5,
    TP_MAX_TOTAL_USD: 60,
    MIN_FAST_TP_USD: 2.5,
    DEFAULT_FAST_TP_USD: 12,
  },
} as const satisfies Record<TradedSymbol, Record<string, number>>;

/** Nome di un parametro in unita' di prezzo: un refuso non compila. */
export type PriceParamName = keyof typeof PRICE_PARAM_DEFAULTS["XAUUSD"];

function envNumberInRange(name: string, min: number, max: number): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/** Parametro in unita' di prezzo dello strumento, con la catena di risoluzione descritta sopra. */
export function symbolPriceParam(symbol: TradedSymbol, name: PriceParamName, min: number, max: number): number {
  const prefixed = envNumberInRange(`${symbol}_${name}`, min, max);
  if (prefixed !== null) return prefixed;
  // La env storica vale solo per l'oro: applicare un SL in dollari a NAS100 sarebbe un errore muto.
  if (symbol === DEFAULT_TRADED_SYMBOL) {
    const legacy = envNumberInRange(name, min, max);
    if (legacy !== null) return legacy;
  }
  return PRICE_PARAM_DEFAULTS[symbol][name];
}

/**
 * Nome del simbolo sul broker, che non coincide con la chiave logica: su molti broker NAS100 si
 * chiama US100, USTEC o NAS100.cash. Si configura con METAAPI_SYMBOL_XAUUSD/METAAPI_SYMBOL_NAS100.
 */
export function brokerSymbol(symbol: TradedSymbol): string {
  const raw = process.env[`METAAPI_SYMBOL_${symbol}`]?.trim();
  return raw || symbol;
}

/** Minimo e default del TP fisso di exit_mode=fast per lo strumento, in unita' di prezzo. */
export function fastTpBounds(symbol: TradedSymbol): FastTpBounds {
  return {
    minUsd: symbolPriceParam(symbol, "MIN_FAST_TP_USD", 0.01, 500),
    defaultUsd: symbolPriceParam(symbol, "DEFAULT_FAST_TP_USD", 0.01, 500),
  };
}

/** Contract size e leva per il margine, sovrascrivibili per strumento quando il broker differisce. */
export function contractSpec(symbol: TradedSymbol): ContractSpec {
  const defaults = CONTRACT_SPEC_DEFAULTS[symbol];
  return {
    contractSize: envNumberInRange(`${symbol}_CONTRACT_SIZE`, 0.001, 100_000) ?? defaults.contractSize,
    leverage: envNumberInRange(`${symbol}_MARGIN_LEVERAGE`, 1, 5000) ?? defaults.leverage,
  };
}

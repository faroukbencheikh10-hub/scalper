/**
 * Liquidita' del momento stimata da segnali di mercato reali (spread, frequenza dei tick, ATR
 * M1/M15), non dall'ora dell'orologio: sostituisce il precedente approccio a fasce orarie fisse
 * (sessions Sydney/Tokyo/Londra/New York), che non si accorgeva di una liquidita' anormalmente
 * bassa o alta dentro il suo stesso orario "normale" (news, giorni festivi locali, chiusure
 * anticipate). Dentro la fascia SCALPER_HOURS_UTC esistente (non toccata, ne' il flatten di fine
 * fascia): sceglie solo quali setup valutare e quanti lotti usare, mai se il worker e' dentro o
 * fuori sessione.
 *
 * updateLiquidityState muta lo stato accumulato tick per tick (spread e frequenza), ma NON calcola
 * l'ATR: quello arriva gia' calcolato dal chiamante (worker/streaming.ts), che riusa la stessa
 * funzione atr() di indicators.ts gia' usata ovunque nella strategia — nessun ricalcolo qui.
 */

export type LiquidityLevel = "LOW" | "MEDIUM" | "HIGH";

export type LiquidityState = {
  spreadHistory: { ts: number; spread: number }[];
  tickTimestamps: number[];
  atrM1: number; // aggiornato dal chiamante con la stessa atr() di scalperStrategy.ts/indicators.ts
  atrM15: number; // idem
  workerStartTs: number;
};

export type LiquiditySnapshot = {
  level: LiquidityLevel;
  spreadRatio: number;
  tickRatePct: number;
  atrRatio: number;
  warmup: boolean;
};

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  const value = raw !== undefined && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

// Lette ad ogni chiamata (mai in costanti di modulo): un cambio dalla dashboard Railway si applica
// dal tick successivo senza riavviare il worker, come per le altre env della strategia.
function spreadMaWindowMin() { return envNumber("SPREAD_MA_WINDOW_MIN", 30); }
function tickRateWindowSec() { return envNumber("TICK_RATE_WINDOW_SEC", 60); }
function tickRateBaselineMin() { return envNumber("TICK_RATE_BASELINE_MIN", 60); }
function warmupMin() { return envNumber("WARMUP_MIN", 15); }
function spreadRatioLow() { return envNumber("SPREAD_RATIO_LOW", 2.0); }
function spreadRatioHigh() { return envNumber("SPREAD_RATIO_HIGH", 1.3); }
function tickRateLowPct() { return envNumber("TICK_RATE_LOW_PCT", 0.4); }
function atrRatioHighNoise() { return envNumber("ATR_RATIO_HIGH_NOISE", 1.8); }
function lotMultLow() { return envNumber("LOT_MULT_LOW", 0.5); }
function lotMultMedium() { return envNumber("LOT_MULT_MEDIUM", 0.7); }

const LOT_STEP = 0.01;

/** Nuovo LiquidityState vuoto, da creare una sola volta all'avvio del worker. */
export function createLiquidityState(nowMs: number): LiquidityState {
  return { spreadHistory: [], tickTimestamps: [], atrM1: 0, atrM15: 0, workerStartTs: nowMs };
}

/**
 * Registra un tick (spread e timestamp) nello stato accumulato, potando la storia oltre le
 * finestre configurate. Non tocca atrM1/atrM15: quelli li aggiorna il chiamante a parte, ad ogni
 * candela chiusa, riusando l'ATR gia' calcolato dalla strategia.
 */
export function updateLiquidityState(
  state: LiquidityState,
  tick: { ts: number; bid: number; ask: number },
): void {
  const spread = tick.ask - tick.bid;
  state.spreadHistory.push({ ts: tick.ts, spread });
  state.tickTimestamps.push(tick.ts);

  const cutoffSpread = tick.ts - spreadMaWindowMin() * 60_000;
  state.spreadHistory = state.spreadHistory.filter((s) => s.ts >= cutoffSpread);

  const cutoffTick = tick.ts - tickRateBaselineMin() * 60_000;
  state.tickTimestamps = state.tickTimestamps.filter((t) => t >= cutoffTick);
}

/**
 * Livello di liquidita' dallo stato accumulato: LOW se spread anomalo, tick rate crollato o ATR
 * M1/M15 fuori scala (rumore), HIGH solo se tutti e tre i segnali sono nella norma, MEDIUM
 * altrimenti. In warmup (avvio recente o storia ancora insufficiente) resta prudente su MEDIUM
 * senza inventare segnali da una storia troppo corta.
 */
export function computeLiquiditySnapshot(state: LiquidityState, nowTs: number): LiquiditySnapshot {
  const warmup = (nowTs - state.workerStartTs) < warmupMin() * 60_000
    || state.spreadHistory.length < 10;

  if (warmup) {
    return { level: "MEDIUM", spreadRatio: 1, tickRatePct: 1, atrRatio: 1, warmup: true };
  }

  // --- spread: quello corrente contro la media della finestra ---
  const currentSpread = state.spreadHistory[state.spreadHistory.length - 1].spread;
  const avgSpread = state.spreadHistory.reduce((s, x) => s + x.spread, 0) / state.spreadHistory.length;
  const spreadRatio = avgSpread > 0 ? currentSpread / avgSpread : 1;

  // --- tick rate: finestra recente confrontata con una baseline NON sovrapposta ---
  const recentCutoff = nowTs - tickRateWindowSec() * 1000;
  const recentTicks = state.tickTimestamps.filter((t) => t >= recentCutoff).length;

  const baselineTicks = state.tickTimestamps.filter((t) => t < recentCutoff);
  const baselineSpanMin = baselineTicks.length > 0
    ? (recentCutoff - baselineTicks[0]) / 60_000
    : 0;
  const expectedTicks = baselineSpanMin > 0
    ? (baselineTicks.length / baselineSpanMin) * (tickRateWindowSec() / 60)
    : recentTicks; // storia insufficiente: non penalizzare, tickRatePct resta 1

  const tickRatePct = expectedTicks > 0 ? recentTicks / expectedTicks : 1;

  // --- ATR ratio: M1 contro M15, aggiornati dal chiamante ad ogni candela chiusa ---
  const atrRatio = state.atrM15 > 0 ? state.atrM1 / state.atrM15 : 1;

  let level: LiquidityLevel;
  if (spreadRatio > spreadRatioLow() || tickRatePct < tickRateLowPct() || atrRatio > atrRatioHighNoise()) {
    level = "LOW";
  } else if (spreadRatio <= spreadRatioHigh() && tickRatePct >= 0.8 && atrRatio <= 1.2) {
    level = "HIGH";
  } else {
    level = "MEDIUM";
  }

  return { level, spreadRatio, tickRatePct, atrRatio, warmup: false };
}

/** Lotti finali per il livello: moltiplicatore configurabile, arrotondato al passo lotti. */
export function lotMultiplierFor(level: LiquidityLevel, baseLots: number): number {
  const mult = level === "LOW" ? lotMultLow() : level === "MEDIUM" ? lotMultMedium() : 1;
  const raw = baseLots * mult;
  const rounded = Math.round(raw / LOT_STEP) * LOT_STEP;
  return Math.max(LOT_STEP, Number(rounded.toFixed(2)));
}

/** Setup ammessi alla valutazione per livello: solo mtf in LOW, tutti gli altri livelli invariati. */
export function setupsAllowedFor(level: LiquidityLevel): ("mtf" | "m1_short" | "m1_range")[] {
  if (level === "LOW") return ["mtf"];
  return ["mtf", "m1_short", "m1_range"];
}

/** Riassunto leggibile per log/Telegram: numeri esatti dietro il livello, mai un'etichetta muta. */
export function describeLiquiditySnapshot(snapshot: LiquiditySnapshot): string {
  if (snapshot.warmup) {
    return "Liquidita' MEDIUM (warmup: storia di mercato ancora insufficiente): tutti i setup attivi, lotti invariati.";
  }
  const allowed = setupsAllowedFor(snapshot.level);
  const setupsNote = allowed.includes("m1_short")
    ? "tutti i setup attivi"
    : "solo mtf attivo (m1_short/m1_range esclusi)";
  return `Liquidita' ${snapshot.level} (spread x${snapshot.spreadRatio.toFixed(2)}, tick rate ${(snapshot.tickRatePct * 100).toFixed(0)}%, `
    + `ATR M1/M15 x${snapshot.atrRatio.toFixed(2)}): ${setupsNote}.`;
}

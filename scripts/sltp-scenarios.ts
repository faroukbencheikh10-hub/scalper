// Deterministic, offline scenarios for SLTP_MODE=off|fixed|trailing (structural SL/TP + trailing
// TP). No broker, database or wall-clock dependency, same isolation pattern as the other scripts.
import assert from "node:assert/strict";
import {
  decideTpBrokerUpdate, initTrailingTp, initialLevels, recalcTighterStop, sltpMode, slMaxUsd,
  takeProfitTouched, tpCloseReason, tpMaxTotalUsd, updateTrailingTp,
} from "../src/lib/server/dynamicSlTp";
import { MINUTE } from "../src/lib/server/marketStructure";
import type { Candle } from "../src/lib/types";

for (const key of Object.keys(process.env)) {
  if (/^(SLTP_|SL_MAX|TP_MAX|TP_EXTEND|TP_TRAIL)/.test(key)) delete process.env[key];
}

let passed = 0;
function check(name: string, test: () => void) {
  try { test(); passed++; console.log("OK " + name); }
  catch (error) { console.error("FAIL " + name); throw error; }
}
function withEnv(env: Record<string, string | undefined>, test: () => void) {
  const previous = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { test(); } finally {
    for (const [k, v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const bar = (ms: number, open: number, close: number, wick = 0.3): Candle => ({
  datetime: new Date(ms).toISOString(), open, close,
  high: Math.max(open, close) + wick, low: Math.min(open, close) - wick,
});

/** M1 con uno swing low/high riconoscibile subito sotto/sopra `level`, il resto piatto. */
function m1WithSwing(end: number, direction: "BUY" | "SELL", level: number, count = 40): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const t = end - (count - 1 - i) * MINUTE;
    if (i === count - 4) {
      out.push(direction === "BUY"
        ? { datetime: new Date(t).toISOString(), open: level + 0.5, close: level + 0.3, high: level + 0.6, low: level }
        : { datetime: new Date(t).toISOString(), open: level - 0.5, close: level - 0.3, high: level, low: level - 0.6 });
    } else {
      out.push(bar(t, level + 1, level + 1.05, 0.2));
    }
  }
  return out;
}

// --- 9: fixed, lo SL sale col prezzo (BUY) e non scende mai --------------------------------------

check("9) fixed: SL sale con il prezzo (BUY) e non scende mai", () => {
  withEnv({ SLTP_MODE: "fixed" }, () => {
    const end = Date.UTC(2026, 8, 9, 10, 0);
    let currentStopLoss = 2190; // SL iniziale ben sotto il prezzo di partenza
    const prices = [2200, 2202, 2205, 2204, 2208, 2211, 2209, 2215];
    const stops: number[] = [];
    for (const price of prices) {
      const m1 = m1WithSwing(end, "BUY", price - 3, 40);
      const decision = recalcTighterStop({
        direction: "BUY", currentPrice: price, currentStopLoss, m1, atrM1: 1, spreadUsd: 0.1,
        nowMs: end, lastUpdateAtMs: null,
      });
      if (decision.kind === "update") currentStopLoss = decision.stopLoss;
      stops.push(currentStopLoss);
    }
    for (let i = 1; i < stops.length; i++) assert.ok(stops[i] >= stops[i - 1], JSON.stringify(stops));
    assert.ok(stops.at(-1)! > 2190, "lo SL deve essersi mosso a favore rispetto all'iniziale");
  });
});

// --- 10: fixed, TP toccato chiude tp_fixed -------------------------------------------------------

check("10) fixed: TP toccato -> close tp_fixed", () => {
  withEnv({ SLTP_MODE: "fixed", SL_MAX: "15", TP_MAX: "10" }, () => {
    const end = Date.UTC(2026, 8, 9, 10, 0);
    const entry = 2200;
    const m1 = m1WithSwing(end, "BUY", entry - 4, 40);
    const levels = initialLevels({ direction: "BUY", entry, m1, atrM1: 1, spreadUsd: 0.1 });
    assert.ok(levels.valid, JSON.stringify(levels));
    const touched = takeProfitTouched({ direction: "BUY", triggered: false, referencePriceUsd: levels.takeProfit!, tpLevel: levels.takeProfit! });
    assert.ok(touched);
    assert.equal(tpCloseReason(false), "tp_fixed");
  });
});

// --- 11: SL oltre SL_MAX -> clampato al cap -------------------------------------------------------

check("11) fixed: SL calcolato oltre SL_MAX -> clampato al cap", () => {
  withEnv({ SLTP_MODE: "fixed", SL_MAX: "2" }, () => {
    const end = Date.UTC(2026, 8, 9, 10, 0);
    const entry = 2200;
    // Nessuno swing rilevante vicino: il fallback ATR (1.2x) su un ATR ampio supera facilmente SL_MAX=2.
    const m1 = Array.from({ length: 40 }, (_, i) => bar(end - (39 - i) * MINUTE, entry, entry + 0.05, 0.1));
    const levels = initialLevels({ direction: "BUY", entry, m1, atrM1: 5, spreadUsd: 0.2 });
    assert.ok(levels.valid, JSON.stringify(levels));
    assert.equal(levels.slClamped, true, JSON.stringify(levels));
    assert.ok(levels.slDistanceUsd! <= slMaxUsd() + 0.02, JSON.stringify(levels));
  });
});

// --- 12: trailing, TP toccato prima del trigger -> tp_fixed ---------------------------------------

check("12) trailing: TP toccato prima del trigger -> close tp_fixed", () => {
  withEnv({ SLTP_MODE: "trailing", TP_EXTEND_TRIGGER_USD: "1.0" }, () => {
    const entry = 2200, initialTp = 2204;
    let state = initTrailingTp(entry, initialTp);
    // Il prezzo tocca esattamente il TP iniziale senza mai superarlo del trigger.
    state = updateTrailingTp(state, { direction: "BUY", currentPrice: initialTp, initialTp, entry });
    assert.equal(state.triggered, false, JSON.stringify(state));
    assert.equal(state.currentTp, initialTp);
    const touched = takeProfitTouched({ direction: "BUY", triggered: state.triggered, referencePriceUsd: initialTp, tpLevel: state.currentTp });
    assert.ok(touched);
    assert.equal(tpCloseReason(state.triggered), "tp_fixed");
  });
});

// --- 13: trailing, 3 nuovi picchi poi ritiro di 2 -> tp_trailing al livello corretto --------------

check("13) trailing: 3 nuovi picchi poi pullback di 2 -> close tp_trailing al livello corretto", () => {
  withEnv({ SLTP_MODE: "trailing", TP_EXTEND_TRIGGER_USD: "1.0", TP_TRAIL_PULLBACK_USD: "2.0" }, () => {
    const entry = 2200, initialTp = 2204;
    let state = initTrailingTp(entry, initialTp);
    for (const price of [2205.5, 2207, 2209]) { // supera il trigger (>1$ oltre 2204) e fa 3 nuovi picchi
      state = updateTrailingTp(state, { direction: "BUY", currentPrice: price, initialTp, entry });
    }
    assert.equal(state.triggered, true, JSON.stringify(state));
    assert.equal(state.peak, 2209);
    assert.equal(state.currentTp, 2209 - 2.0);
    // Ritiro di 2 dal picco: tocca esattamente il livello trailing.
    const pulledBack = updateTrailingTp(state, { direction: "BUY", currentPrice: 2207, initialTp, entry });
    assert.equal(pulledBack.currentTp, 2207); // il picco non cala: currentTp resta ancorato al massimo storico
    const touched = takeProfitTouched({ direction: "BUY", triggered: state.triggered, referencePriceUsd: 2207, tpLevel: state.currentTp });
    assert.ok(touched, JSON.stringify({ state, price: 2207 }));
    assert.equal(tpCloseReason(state.triggered), "tp_trailing");
  });
});

// --- 14: trailing, pullback sotto soglia non chiude ------------------------------------------------

check("14) trailing: pullback di 1,5 (sotto la soglia) NON chiude", () => {
  withEnv({ SLTP_MODE: "trailing", TP_EXTEND_TRIGGER_USD: "1.0", TP_TRAIL_PULLBACK_USD: "2.0" }, () => {
    const entry = 2200, initialTp = 2204;
    let state = initTrailingTp(entry, initialTp);
    state = updateTrailingTp(state, { direction: "BUY", currentPrice: 2209, initialTp, entry });
    assert.equal(state.triggered, true);
    assert.equal(state.currentTp, 2207); // 2209 - 2.0
    const price = 2209 - 1.5; // pullback di 1,5, sotto la soglia di 2.0
    const touched = takeProfitTouched({ direction: "BUY", triggered: state.triggered, referencePriceUsd: price, tpLevel: state.currentTp });
    assert.equal(touched, false, JSON.stringify({ state, price }));
  });
});

// --- 15: trailing, distanza dall'apertura mai oltre TP_MAX_TOTAL_USD ------------------------------

check("15) trailing: distanza dal prezzo di apertura non supera mai TP_MAX_TOTAL_USD", () => {
  withEnv({ SLTP_MODE: "trailing", TP_MAX: "10", TP_MAX_TOTAL_USD: "12", TP_TRAIL_PULLBACK_USD: "2.0", TP_EXTEND_TRIGGER_USD: "1.0" }, () => {
    const entry = 2200, initialTp = 2204;
    let state = initTrailingTp(entry, initialTp);
    let price = initialTp;
    for (let i = 0; i < 500; i++) {
      price += 0.5; // trend lunghissimo, sempre nuovi massimi
      state = updateTrailingTp(state, { direction: "BUY", currentPrice: price, initialTp, entry });
      assert.ok(state.currentTp - entry <= tpMaxTotalUsd() + 1e-9, JSON.stringify({ i, state }));
    }
    // Con un trend cosi' lungo il cap deve essere stato raggiunto, non solo mai superato.
    assert.ok(Math.abs(state.currentTp - entry - tpMaxTotalUsd()) < 1e-6, JSON.stringify(state));
  });
});

// --- 16: trailing, aggiornamenti broker non piu' frequenti di SLTP_UPDATE_MIN_INTERVAL_SEC --------

check("16) trailing: aggiornamento TP al broker non piu' di una volta ogni SLTP_UPDATE_MIN_INTERVAL_SEC", () => {
  withEnv({ SLTP_MODE: "trailing", SLTP_UPDATE_MIN_INTERVAL_SEC: "5" }, () => {
    let currentBrokerTp = 2204, lastUpdateAtMs: number | null = null, updates = 0;
    const startMs = Date.UTC(2026, 8, 9, 10, 0, 0);
    const totalTicks = 200, tickEveryMs = 100; // 20 secondi simulati, un tick ogni 100ms
    for (let i = 0; i < totalTicks; i++) {
      const nowMs = startMs + i * tickEveryMs;
      const candidateTp = 2204 + i * 0.05; // sempre in miglioramento
      const decision = decideTpBrokerUpdate({
        direction: "BUY", candidateTp, currentBrokerTp, nowMs, lastUpdateAtMs, minUpdateIntervalMs: 5000, minStepUsd: 0.01,
      });
      if (decision.kind === "update") { currentBrokerTp = decision.takeProfit; lastUpdateAtMs = nowMs; updates++; }
    }
    const elapsedSec = (totalTicks * tickEveryMs) / 1000;
    const maxAllowedUpdates = Math.floor(elapsedSec / 5) + 1;
    assert.ok(updates <= maxAllowedUpdates, `troppi aggiornamenti: ${updates} > ${maxAllowedUpdates}`);
    assert.ok(updates >= 1, "il TP doveva comunque avanzare almeno una volta in 20s");
  });
});

// --- 17: SLTP_MODE=off -> identico a main (non-regressione) ---------------------------------------

check("17) SLTP_MODE=off -> nessuna nuova logica si attiva (non-regressione)", () => {
  assert.equal(process.env.SLTP_MODE, undefined, "il default deve restare off senza impostare l'env");
  assert.equal(sltpMode(), "off");
  withEnv({ SLTP_MODE: "off" }, () => assert.equal(sltpMode(), "off"));
  withEnv({ SLTP_MODE: "banana" }, () => assert.equal(sltpMode(), "off"));
  withEnv({ SLTP_MODE: "FIXED" }, () => assert.equal(sltpMode(), "fixed")); // case-insensitive, non un default silenzioso
});

console.log(`${passed} scenari superati.`);

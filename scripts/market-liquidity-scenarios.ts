// Deterministic, offline scenarios for src/lib/server/marketLiquidity.ts (liquidity from real
// market signals: spread ratio, tick rate, ATR M1/M15 ratio). No broker, database or wall-clock
// dependency: state is built by hand or via updateLiquidityState with explicit timestamps.
import assert from "node:assert/strict";
import {
  computeLiquiditySnapshot, createLiquidityState, describeLiquiditySnapshot, lotMultiplierFor,
  setupsAllowedFor, updateLiquidityState, type LiquidityState,
} from "../src/lib/server/marketLiquidity";

for (const key of Object.keys(process.env)) {
  if (/^(SPREAD_|TICK_RATE_|WARMUP_MIN|ATR_RATIO_|LOT_MULT_)/.test(key)) delete process.env[key];
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

function evenlySpaced(startTs: number, endTs: number, count: number): number[] {
  if (count <= 0) return [];
  const step = (endTs - startTs) / count;
  return Array.from({ length: count }, (_, i) => Math.round(startTs + i * step));
}

/**
 * Stato "maturo" con tick-rate stabile (recentTicks = expectedTicks per costruzione, ratio 1),
 * pronto per essere personalizzato con spread/ATR diversi in ogni scenario. now e' fisso e ben
 * oltre WARMUP_MIN dall'avvio, con 10 campioni di spread: mai in warmup per costruzione.
 */
function matureState(input: { spreads: number[]; atrM1: number; atrM15: number }): { state: LiquidityState; now: number } {
  const now = 4000 * 60_000;
  const recentCutoff = now - 60_000; // TICK_RATE_WINDOW_SEC default 60s
  const baselineStart = recentCutoff - 60 * 60_000; // TICK_RATE_BASELINE_MIN default 60min
  const baselineTicks = evenlySpaced(baselineStart, recentCutoff, 300); // 5 tick/min
  const recentTicks = evenlySpaced(recentCutoff, now, 5); // stesso ritmo nell'ultimo minuto
  const state: LiquidityState = createLiquidityState(0);
  state.tickTimestamps = [...baselineTicks, ...recentTicks];
  state.spreadHistory = input.spreads.map((spread, i) => ({ ts: now - (input.spreads.length - 1 - i) * 1000, spread }));
  state.atrM1 = input.atrM1;
  state.atrM15 = input.atrM15;
  return { state, now };
}

// --- warmup ---------------------------------------------------------------------------------

check("warmup: avvio recente (< WARMUP_MIN) resta MEDIUM anche con storia sufficiente", () => {
  const state = createLiquidityState(0);
  for (let i = 0; i < 10; i++) updateLiquidityState(state, { ts: i * 1000, bid: 100, ask: 100.1 });
  const snapshot = computeLiquiditySnapshot(state, 5 * 60_000); // 5 min dall'avvio, < 15 min default
  assert.equal(snapshot.warmup, true);
  assert.equal(snapshot.level, "MEDIUM");
  assert.equal(snapshot.spreadRatio, 1);
  assert.equal(snapshot.tickRatePct, 1);
  assert.equal(snapshot.atrRatio, 1);
});

check("warmup: uptime sufficiente ma meno di 10 campioni di spread resta MEDIUM", () => {
  const state = createLiquidityState(0);
  updateLiquidityState(state, { ts: 0, bid: 100, ask: 100.1 });
  const snapshot = computeLiquiditySnapshot(state, 20 * 60_000); // 20 min, oltre WARMUP_MIN
  assert.equal(snapshot.warmup, true);
  assert.equal(snapshot.level, "MEDIUM");
});

// --- updateLiquidityState: accumulo e potatura delle finestre -------------------------------

check("updateLiquidityState: pota spreadHistory (30 min) e tickTimestamps (60 min) indipendentemente", () => {
  const state = createLiquidityState(0);
  updateLiquidityState(state, { ts: 0, bid: 100, ask: 100.10 });
  updateLiquidityState(state, { ts: 10 * 60_000, bid: 100, ask: 100.12 });
  updateLiquidityState(state, { ts: 40 * 60_000, bid: 100, ask: 100.14 });
  // A 40 min: cutoff spread = 40-30=10 min -> il campione a ts=0 esce, gli altri due restano.
  assert.equal(state.spreadHistory.length, 2, JSON.stringify(state.spreadHistory));
  assert.deepEqual(state.spreadHistory.map((s) => s.ts), [10 * 60_000, 40 * 60_000]);
  // Il tick baseline (60 min) e' piu' largo: a 40 min nessun tick esce ancora.
  assert.equal(state.tickTimestamps.length, 3);
  updateLiquidityState(state, { ts: 120 * 60_000, bid: 100, ask: 100.20 });
  // A 120 min: cutoff tick = 120-60=60 min -> escono ts=0,10,40; resta solo il nuovo tick.
  assert.equal(state.tickTimestamps.length, 1);
  assert.equal(state.tickTimestamps[0], 120 * 60_000);
  // cutoff spread = 120-30=90 min -> esce anche ts=10min, resta solo il nuovo campione.
  assert.equal(state.spreadHistory.length, 1);
});

// --- classificazione: HIGH quando tutti e tre i segnali sono nella norma --------------------

check("HIGH: spread stabile, tick-rate al ritmo atteso, ATR M1~M15", () => {
  const { state, now } = matureState({ spreads: Array(10).fill(0.10), atrM1: 1.0, atrM15: 1.0 });
  const snapshot = computeLiquiditySnapshot(state, now);
  assert.equal(snapshot.warmup, false);
  assert.equal(snapshot.level, "HIGH", JSON.stringify(snapshot));
  assert.ok(Math.abs(snapshot.spreadRatio - 1) < 1e-9, String(snapshot.spreadRatio));
  assert.ok(Math.abs(snapshot.tickRatePct - 1) < 0.01, String(snapshot.tickRatePct));
  assert.equal(snapshot.atrRatio, 1);
});

// --- LOW: ciascuno dei tre segnali puo' portare a LOW da solo -------------------------------

check("LOW: spread anomalo (oltre SPREAD_RATIO_LOW) rispetto alla media della finestra", () => {
  const spreads = [...Array(9).fill(0.10), 0.30]; // media 0.12, ultimo 0.30 -> ratio 2.5 > 2.0
  const { state, now } = matureState({ spreads, atrM1: 1.0, atrM15: 1.0 });
  const snapshot = computeLiquiditySnapshot(state, now);
  assert.equal(snapshot.level, "LOW", JSON.stringify(snapshot));
  assert.ok(snapshot.spreadRatio > 2.0, String(snapshot.spreadRatio));
});

check("LOW: tick-rate crollato sotto TICK_RATE_LOW_PCT", () => {
  const { state, now } = matureState({ spreads: Array(10).fill(0.10), atrM1: 1.0, atrM15: 1.0 });
  const recentCutoff = now - 60_000;
  const baselineStart = recentCutoff - 60 * 60_000;
  // Stessa baseline (5 tick/min) della fixture, ma un solo tick recente invece di 5: attivita' crollata.
  state.tickTimestamps = [...evenlySpaced(baselineStart, recentCutoff, 300), recentCutoff + 1];
  const snapshot = computeLiquiditySnapshot(state, now);
  assert.equal(snapshot.level, "LOW", JSON.stringify(snapshot));
  assert.ok(snapshot.tickRatePct < 0.4, String(snapshot.tickRatePct));
});

check("LOW: ATR M1 fuori scala rispetto a M15 (rumore/spike)", () => {
  const { state, now } = matureState({ spreads: Array(10).fill(0.10), atrM1: 4.0, atrM15: 2.0 }); // ratio 2.0 > 1.8
  const snapshot = computeLiquiditySnapshot(state, now);
  assert.equal(snapshot.level, "LOW", JSON.stringify(snapshot));
  assert.ok(snapshot.atrRatio > 1.8, String(snapshot.atrRatio));
});

check("MEDIUM: nessun segnale abbastanza anomalo da LOW, ma non tutti nella fascia stretta di HIGH", () => {
  const spreads = [...Array(9).fill(0.10), 0.15]; // media 0.105, ratio ~1.43: sopra 1.3 (niente HIGH), sotto 2.0 (niente LOW)
  const { state, now } = matureState({ spreads, atrM1: 1.0, atrM15: 1.0 });
  const snapshot = computeLiquiditySnapshot(state, now);
  assert.equal(snapshot.level, "MEDIUM", JSON.stringify(snapshot));
});

// --- soglie configurabili via env, lette ad ogni chiamata ------------------------------------

check("le soglie sono env lette ad ogni chiamata: un cambio si applica subito", () => {
  const spreads = [...Array(9).fill(0.10), 0.15]; // ratio ~1.43, MEDIUM di default
  const { state, now } = matureState({ spreads, atrM1: 1.0, atrM15: 1.0 });
  assert.equal(computeLiquiditySnapshot(state, now).level, "MEDIUM");
  withEnv({ SPREAD_RATIO_LOW: "1.4" }, () => {
    assert.equal(computeLiquiditySnapshot(state, now).level, "LOW", "1.43 > 1.4: ora deve diventare LOW");
  });
  // Ripristinata l'env, torna al comportamento di default.
  assert.equal(computeLiquiditySnapshot(state, now).level, "MEDIUM");
});

// --- lotti: moltiplicatore per livello, arrotondato al passo lotti, mai sotto il passo minimo --

check("lotMultiplierFor: HIGH invariato, MEDIUM/LOW ridotti e arrotondati al passo 0.01", () => {
  assert.equal(lotMultiplierFor("HIGH", 0.10), 0.10);
  assert.equal(lotMultiplierFor("MEDIUM", 0.10), 0.07); // default 0.7
  assert.equal(lotMultiplierFor("LOW", 0.10), 0.05); // default 0.5
});

check("lotMultiplierFor: mai sotto il passo lotti minimo, anche con un moltiplicatore minuscolo", () => {
  withEnv({ LOT_MULT_LOW: "0.001" }, () => {
    assert.equal(lotMultiplierFor("LOW", 0.01), 0.01);
  });
});

check("lotMultiplierFor: i moltiplicatori sono configurabili via env", () => {
  withEnv({ LOT_MULT_MEDIUM: "0.4", LOT_MULT_LOW: "0.2" }, () => {
    assert.equal(lotMultiplierFor("MEDIUM", 0.10), 0.04);
    assert.equal(lotMultiplierFor("LOW", 0.10), 0.02);
  });
  assert.equal(lotMultiplierFor("MEDIUM", 0.10), 0.07);
});

// --- setup ammessi: solo mtf in LOW -----------------------------------------------------------

check("setupsAllowedFor: solo mtf in LOW, tutti e tre altrimenti", () => {
  assert.deepEqual(setupsAllowedFor("LOW"), ["mtf"]);
  assert.deepEqual(setupsAllowedFor("MEDIUM"), ["mtf", "m1_short", "m1_range"]);
  assert.deepEqual(setupsAllowedFor("HIGH"), ["mtf", "m1_short", "m1_range"]);
});

// --- descrizione leggibile per log/Telegram ---------------------------------------------------

check("describeLiquiditySnapshot: numeri esatti nel messaggio, mai solo l'etichetta", () => {
  const { state, now } = matureState({ spreads: Array(10).fill(0.10), atrM1: 1.0, atrM15: 1.0 });
  const high = computeLiquiditySnapshot(state, now);
  const text = describeLiquiditySnapshot(high);
  assert.match(text, /HIGH/);
  assert.match(text, /tutti i setup attivi/);
  assert.match(text, /spread x1\.00/);

  const lowState = createLiquidityState(0);
  const warmupText = describeLiquiditySnapshot(computeLiquiditySnapshot(lowState, 0));
  assert.match(warmupText, /warmup/i);

  const spreads = [...Array(9).fill(0.10), 0.30];
  const { state: lowMature, now: lowNow } = matureState({ spreads, atrM1: 1.0, atrM15: 1.0 });
  const lowText = describeLiquiditySnapshot(computeLiquiditySnapshot(lowMature, lowNow));
  assert.match(lowText, /LOW/);
  assert.match(lowText, /solo mtf attivo/);
});

console.log(`${passed} scenari superati.`);

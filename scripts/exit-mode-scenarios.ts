// Deterministic scenarios for exit_mode ("normal" | "fast"): la modalita' scelta dalla dashboard
// per le NUOVE posizioni, letta dal worker al momento dell'apertura e fissata sulla riga. Copre i
// moduli puri: src/lib/exitMode.ts (risoluzione/validazione, prezzo target) e la classificazione
// del motivo di chiusura in positionManager.ts.
import assert from "node:assert/strict";
import {
  clampFastTpUsd, DEFAULT_EXIT_MODE, DEFAULT_FAST_TP_USD, fastTargetPrice, MIN_FAST_TP_USD,
  resolveExitMode, resolveFastTpUsd,
} from "../src/lib/exitMode";
import { fastExitCloseReasonFromPrice, isManagedSetup } from "../src/lib/server/positionManager";

let passed = 0;
function check(name: string, test: () => void) {
  try { test(); passed++; console.log("OK " + name); }
  catch (error) { console.error("FAIL " + name); throw error; }
}

// --- resolveExitMode / resolveFastTpUsd / clampFastTpUsd: default "normal", nessuna sorpresa -----

check("resolveExitMode: 'fast' solo se letto esattamente cosi', tutto il resto è 'normal'", () => {
  assert.equal(resolveExitMode("fast"), "fast");
  assert.equal(resolveExitMode("normal"), "normal");
  assert.equal(resolveExitMode(undefined), DEFAULT_EXIT_MODE);
  assert.equal(resolveExitMode(null), "normal");
  assert.equal(resolveExitMode(""), "normal");
  assert.equal(resolveExitMode("FAST"), "normal", "case-sensitive: solo 'fast' esatto attiva la modalita'");
  assert.equal(resolveExitMode("qualunque-cosa"), "normal");
});

check("resolveFastTpUsd: default 2.5$, mai sotto il minimo, valori non numerici ignorati", () => {
  assert.equal(resolveFastTpUsd(undefined), DEFAULT_FAST_TP_USD);
  assert.equal(resolveFastTpUsd("banana"), DEFAULT_FAST_TP_USD);
  assert.equal(resolveFastTpUsd("4"), 4);
  assert.equal(resolveFastTpUsd("4.00"), 4);
  assert.equal(resolveFastTpUsd("0.1"), MIN_FAST_TP_USD, "sotto il minimo risale a MIN_FAST_TP_USD");
  assert.equal(resolveFastTpUsd("-3"), MIN_FAST_TP_USD);
});

check("clampFastTpUsd: nessun massimo, l'utente sceglie liberamente sopra il minimo", () => {
  assert.equal(clampFastTpUsd(4), 4);
  assert.equal(clampFastTpUsd(100), 100);
  assert.equal(clampFastTpUsd(MIN_FAST_TP_USD), MIN_FAST_TP_USD);
  assert.equal(clampFastTpUsd(0), MIN_FAST_TP_USD);
  assert.equal(clampFastTpUsd(Number.NaN), DEFAULT_FAST_TP_USD);
});

// --- fastTargetPrice: sempre arrotondato verso l'entry, mai oltre la distanza richiesta ----------

check("fastTargetPrice: BUY sopra l'entry, arrotondato al centesimo verso il basso (mai oltre)", () => {
  assert.equal(fastTargetPrice("BUY", 2200.123, 4), 2204.12);
});

check("fastTargetPrice: SELL sotto l'entry, arrotondato al centesimo verso l'alto (mai oltre)", () => {
  assert.equal(fastTargetPrice("SELL", 2200.123, 4), 2196.13);
});

check("fastTargetPrice: fast_tp_usd custom (es. 4$) rispettato esattamente, non il default", () => {
  const entry = 2500;
  assert.equal(fastTargetPrice("BUY", entry, 4), 2504);
  assert.notEqual(fastTargetPrice("BUY", entry, 4), fastTargetPrice("BUY", entry, DEFAULT_FAST_TP_USD));
});

check("fastTargetPrice: un fast_tp_usd sotto il minimo viene comunque clampato", () => {
  assert.equal(fastTargetPrice("BUY", 2500, 0.1), 2500 + MIN_FAST_TP_USD);
});

// --- fastExitCloseReasonFromPrice: exit_mode=fast chiude su un solo livello, mai su breakeven/trailing --

check("fast: chiusura al target unico -> tp_fast (mai target1/tp_broker/sl_breakeven/sl_trailing)", () => {
  const entry = 2500, fastTpUsd = 4;
  const target = fastTargetPrice("BUY", entry, fastTpUsd);
  const reason = fastExitCloseReasonFromPrice(target, 40, { initialStop: entry - 3, fastTarget: target });
  assert.equal(reason, "tp_fast");
});

check("fast: chiusura sullo SL iniziale in perdita -> sl_initial, come le altre modalita'", () => {
  const entry = 2500, initialStop = entry - 3;
  const reason = fastExitCloseReasonFromPrice(initialStop, -30, { initialStop, fastTarget: fastTargetPrice("BUY", entry, 4) });
  assert.equal(reason, "sl_initial");
});

check("fast: prezzo di chiusura su nessun livello noto -> manual (nessuna deduzione)", () => {
  const reason = fastExitCloseReasonFromPrice(2550, 10, { initialStop: 2497, fastTarget: 2504 });
  assert.equal(reason, "manual");
});

check("fast: SL toccato ma chiuso in profitto (slittamento) -> non e' sl_initial", () => {
  // Stesso principio di closeReasonFromPrice: sl_initial vale solo se la chiusura e' davvero una perdita.
  const reason = fastExitCloseReasonFromPrice(2497, 5, { initialStop: 2497, fastTarget: 2504 });
  assert.notEqual(reason, "sl_initial");
});

// --- normal: nessuna delle funzioni fast entra in gioco; isManagedSetup resta la stessa di sempre --

check("normal: isManagedSetup invariato (m1_short/m1_range gestiti, mtf mai)", () => {
  assert.equal(isManagedSetup("m1_short"), true);
  assert.equal(isManagedSetup("m1_range"), true);
  assert.equal(isManagedSetup("mtf_continuation"), false);
  assert.equal(isManagedSetup(null), false);
});

check("normal: fast_tp_usd non richiesto, resolveExitMode('normal') e default coincidono", () => {
  assert.equal(resolveExitMode(undefined), resolveExitMode("normal"));
});

console.log(`${passed} scenari superati.`);

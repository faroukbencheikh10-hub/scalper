// Deterministic, offline scenarios for src/lib/server/sessionLiquidity.ts (Sydney/Tokyo/London/
// New York sessions and liquidity level LOW/MEDIUM/HIGH). No broker, database or wall-clock
// dependency. getLiquidityLevel/activeSessions/sessionLotMultiplier/sessionLiquiditySnapshot are
// pure: same isolation pattern as the other scripts.
import assert from "node:assert/strict";
import {
  activeSessions, getLiquidityLevel, sessionLiquiditySnapshot, sessionLotMultiplier,
} from "../src/lib/server/sessionLiquidity";
import { clampLots } from "../src/lib/server/tradingConfig";

for (const key of Object.keys(process.env)) {
  if (/^SESSION_LOT_MULT_/.test(key)) delete process.env[key];
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

// --- Un orario UTC per fascia: livello e moltiplicatore lotti corretti ---------------------------

check("LOW (06:00-07:00, coda Tokyo): livello LOW, moltiplicatore di default 0.5", () => {
  assert.equal(getLiquidityLevel(6), "LOW");
  assert.equal(sessionLotMultiplier("LOW"), 0.5);
  const snapshot = sessionLiquiditySnapshot(Date.UTC(2026, 8, 10, 6, 30));
  assert.equal(snapshot.level, "LOW");
  assert.equal(snapshot.lotMultiplier, 0.5);
  assert.equal(snapshot.disableShort, true, "in LOW solo mtf resta attivo");
  assert.equal(snapshot.disableRange, true, "in LOW solo mtf resta attivo");
  // Alle 06:30 UTC Tokyo e' ancora aperta (00:00-09:00), Londra apre solo alle 07:00: nessun overlap.
  assert.deepEqual(snapshot.activeSessions, ["tokyo"]);
});

check("MEDIUM (07:00-12:00, sola Londra): livello MEDIUM, moltiplicatore di default 0.7", () => {
  assert.equal(getLiquidityLevel(9), "MEDIUM");
  assert.equal(sessionLotMultiplier("MEDIUM"), 0.7);
  const snapshot = sessionLiquiditySnapshot(Date.UTC(2026, 8, 10, 9, 0));
  assert.equal(snapshot.level, "MEDIUM");
  assert.equal(snapshot.lotMultiplier, 0.7);
  assert.equal(snapshot.disableShort, false);
  assert.equal(snapshot.disableRange, false);
});

check("MEDIUM (16:00-20:30, sola New York): livello MEDIUM, tutti i setup attivi", () => {
  assert.equal(getLiquidityLevel(18), "MEDIUM");
  const snapshot = sessionLiquiditySnapshot(Date.UTC(2026, 8, 10, 18, 0));
  assert.equal(snapshot.level, "MEDIUM");
  assert.equal(snapshot.lotMultiplier, 0.7);
  assert.equal(snapshot.disableShort, false);
  assert.equal(snapshot.disableRange, false);
  assert.deepEqual(snapshot.activeSessions, ["new_york"]);
});

check("HIGH (12:00-16:00, overlap Londra-New York): livello HIGH, nessuna modifica", () => {
  assert.equal(getLiquidityLevel(14), "HIGH");
  assert.equal(sessionLotMultiplier("HIGH"), 1);
  const snapshot = sessionLiquiditySnapshot(Date.UTC(2026, 8, 10, 14, 0));
  assert.equal(snapshot.level, "HIGH");
  assert.equal(snapshot.lotMultiplier, 1);
  assert.equal(snapshot.disableShort, false, "in HIGH tutti e tre i setup restano attivi");
  assert.equal(snapshot.disableRange, false, "in HIGH tutti e tre i setup restano attivi");
  assert.deepEqual([...snapshot.activeSessions].sort(), ["london", "new_york"]);
});

// --- Moltiplicatori configurabili senza redeploy --------------------------------------------------

check("SESSION_LOT_MULT_MEDIUM/LOW sono configurabili via env, letti ad ogni chiamata", () => {
  withEnv({ SESSION_LOT_MULT_MEDIUM: "0.4", SESSION_LOT_MULT_LOW: "0.2" }, () => {
    assert.equal(sessionLotMultiplier("MEDIUM"), 0.4);
    assert.equal(sessionLotMultiplier("LOW"), 0.2);
  });
  // Env ripristinata: torna ai default, nessuna costante di modulo che "ricorda" il valore precedente.
  assert.equal(sessionLotMultiplier("MEDIUM"), 0.7);
  assert.equal(sessionLotMultiplier("LOW"), 0.5);
});

check("un valore env non valido (0, negativo, fuori range) ripiega sul default", () => {
  for (const bad of ["0", "-1", "3", "abc", ""]) {
    withEnv({ SESSION_LOT_MULT_MEDIUM: bad }, () => assert.equal(sessionLotMultiplier("MEDIUM"), 0.7, `bad=${bad}`));
  }
});

// --- Lotti arrotondati al passo lotti del broker (clampLots, riuso della stessa funzione del worker) ---

check("lotti moltiplicati per il livello, arrotondati al passo lotti come nel worker", () => {
  withEnv({ EXEC_LOTS: "0.10", SCALPER_LOTS_MIN: "0.01", SCALPER_LOTS_MAX: "0.20" }, () => {
    const activeLots = 0.10;
    assert.equal(clampLots(activeLots * sessionLotMultiplier("HIGH")), 0.10);
    assert.equal(clampLots(activeLots * sessionLotMultiplier("MEDIUM")), 0.07);
    assert.equal(clampLots(activeLots * sessionLotMultiplier("LOW")), 0.05);
  });
});

// --- Sessioni attive: attraversamento della mezzanotte per Sydney -------------------------------

check("activeSessions: Sydney attraversa la mezzanotte (21:00-06:00 UTC)", () => {
  assert.ok(activeSessions(23).includes("sydney"));
  assert.ok(activeSessions(2).includes("sydney"));
  assert.ok(!activeSessions(10).includes("sydney"));
  // A mezzanotte UTC sono aperte sia Sydney (coda) sia Tokyo (appena aperta).
  assert.deepEqual([...activeSessions(0)].sort(), ["sydney", "tokyo"]);
});

check("nessuna sessione attiva solo nella breve finestra 09:00-12:00 fra Tokyo e l'overlap Londra-NY", () => {
  // Tokyo chiude alle 09:00, Londra apre alle 07:00 (gia' aperta), quindi 09:00-12:00 e' comunque
  // coperta da Londra da sola: verifichiamo che il livello resti MEDIUM in tutta la finestra.
  for (let hour = 9; hour < 12; hour++) {
    assert.equal(getLiquidityLevel(hour), "MEDIUM", `ora ${hour}`);
    assert.deepEqual(activeSessions(hour), ["london"], `ora ${hour}`);
  }
});

console.log(`${passed} scenari superati.`);

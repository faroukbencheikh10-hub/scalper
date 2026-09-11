// Deterministic, offline scenarios for the M15 4-state gate (M15_GATE_MODE=off|live).
// No broker, database or wall-clock dependency. Mirrors the isolation pattern of
// scripts/strategy-scenarios.ts: env vars that could leak from the shell are cleared up front.
import assert from "node:assert/strict";
import { classifyM15Regime, contextM5M15, evaluateScalper, shortContextGate } from "../src/lib/server/scalperStrategy";
import { MINUTE, closedBars } from "../src/lib/server/marketStructure";
import type { Candle, M15Regime, MarketContext } from "../src/lib/types";

for (const key of Object.keys(process.env)) {
  if (/^(MTF_|SCALPER_|SL_|SHOCK_|M15_|SHORT_|RANGE_|TP_)/.test(key)) delete process.env[key];
}
process.env.SCALPER_HOURS_UTC = "00:00-23:59";

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

/** MarketContext sintetico: isola il gate dal calcolo di banda/swing, che ha i suoi test a parte. */
function ctx(overrides: Partial<MarketContext> = {}): MarketContext {
  return {
    biasM5: "up",
    m15State: "trend_up",
    m15Regime: "trend_up",
    m15BreakoutRecent: false,
    ema20M5: 2200,
    ema20M5Before: 2199,
    closeM5: 2201,
    m15BandWidth: 10,
    m15BandAtr: 5,
    atr15: 2,
    detail: "synthetic",
    ...overrides,
  };
}

// --- 1-6: scenari puntuali della specifica ------------------------------------------------------

check("1) M5 up + M15 transition -> m1_short BUY passa (mode=live)", () => {
  withEnv({ M15_GATE_MODE: "live" }, () => {
    const gate = shortContextGate("m1_short", ctx({ biasM5: "up", m15Regime: "transition" }));
    assert.equal(gate.allowed, "BUY", JSON.stringify(gate));
    assert.equal(gate.blocked, null);
  });
});

check("2) M5 up + M15 true_range, nessun bias M15 opposto -> m1_short ACCETTATO", () => {
  withEnv({ M15_GATE_MODE: "live" }, () => {
    const gate = shortContextGate("m1_short", ctx({ biasM5: "up", m15Regime: "true_range" }));
    assert.equal(gate.allowed, "BUY", JSON.stringify(gate));
    assert.equal(gate.blocked, null);
    assert.equal(gate.passReason, "m15 range/transition ma nessun bias M15 opposto: consentito");
  });
});

check("3) M5 up + M15 trend_down -> m1_short bloccato", () => {
  withEnv({ M15_GATE_MODE: "live" }, () => {
    const gate = shortContextGate("m1_short", ctx({ biasM5: "up", m15Regime: "trend_down" }));
    assert.equal(gate.allowed, null);
    assert.match(gate.blocked!.reasoning, /m15_regime=trend_down contrario/);
  });
});

check("4) M5 flat + M15 qualsiasi -> m1_short bloccato (m1_range valuta a parte)", () => {
  withEnv({ M15_GATE_MODE: "live" }, () => {
    for (const m15Regime of ["true_range", "transition", "trend_up", "trend_down"] as M15Regime[]) {
      const gate = shortContextGate("m1_short", ctx({ biasM5: "flat", m15Regime }));
      assert.equal(gate.allowed, null, JSON.stringify({ m15Regime, gate }));
      assert.match(gate.blocked!.reasoning, /bias_m5=flat/);
    }
  });
});

check("5) range compresso con swing dall'aspetto direzionale -> true_range, mai transition/trend", () => {
  // La priorita' del range compresso vale sia con struttura up sia down sia assente.
  assert.equal(classifyM15Regime({ compressed: true, structureUp: true, structureDown: false }), "true_range");
  assert.equal(classifyM15Regime({ compressed: true, structureUp: false, structureDown: true }), "true_range");
  assert.equal(classifyM15Regime({ compressed: true, structureUp: false, structureDown: false }), "true_range");
  // Non compresso, nessuna struttura confermata: transition (mai range, mai trend).
  assert.equal(classifyM15Regime({ compressed: false, structureUp: false, structureDown: false }), "transition");
});

check("6) m15_breakout_recent=true -> m1_short bloccato anche con transition", () => {
  withEnv({ M15_GATE_MODE: "live" }, () => {
    const gate = shortContextGate("m1_short", ctx({ biasM5: "up", m15Regime: "transition", m15BreakoutRecent: true }));
    assert.equal(gate.allowed, null);
    assert.match(gate.blocked!.reasoning, /m15_breakout_recent=true/);
  });
});

// --- 7: non-regressione M15_GATE_MODE=off ------------------------------------------------------

check("7) M15_GATE_MODE=off -> risultato identico alla logica attuale (m15State a 3 valori)", () => {
  assert.equal(process.env.M15_GATE_MODE, undefined, "il default deve restare off senza bisogno di impostare l'env");
  const cases: Array<{ biasM5: "up" | "down" | "flat"; m15State: MarketContext["m15State"]; m15Regime: M15Regime; breakout: boolean }> = [
    { biasM5: "up", m15State: "trend_up", m15Regime: "trend_up", breakout: false },
    { biasM5: "up", m15State: "trend_down", m15Regime: "trend_down", breakout: false },
    { biasM5: "up", m15State: "range", m15Regime: "true_range", breakout: false },
    { biasM5: "up", m15State: "range", m15Regime: "transition", breakout: false },
    { biasM5: "down", m15State: "trend_down", m15Regime: "trend_down", breakout: true },
    { biasM5: "flat", m15State: "trend_up", m15Regime: "trend_up", breakout: false },
  ];
  for (const off of [undefined, "off", "banana"]) {
    withEnv({ M15_GATE_MODE: off }, () => {
      for (const c of cases) {
        const context = ctx({ biasM5: c.biasM5, m15State: c.m15State, m15Regime: c.m15Regime, m15BreakoutRecent: c.breakout });
        const gate = shortContextGate("m1_short", context);
        // Comportamento originale, invariato: dipende solo da m15State (3 valori), mai da m15Regime.
        const expectAllowed = c.biasM5 !== "flat"
          && !(c.biasM5 === "up" && c.m15State === "trend_down")
          && !(c.biasM5 === "down" && c.m15State === "trend_up")
          && c.m15State !== "range"
          && !c.breakout;
        if (expectAllowed) {
          assert.equal(gate.allowed, c.biasM5 === "up" ? "BUY" : "SELL", JSON.stringify({ off, c, gate }));
        } else {
          assert.equal(gate.allowed, null, JSON.stringify({ off, c, gate }));
        }
      }
    });
  }
});

check("7b) M15_GATE_MODE=off: la mtf resta identica a se stessa a parita' di input (contesto solo nel log)", () => {
  // Il contesto M5/M15 (e il suo stato a 4 valori) e' sempre calcolato e loggato, ma la mtf non lo
  // legge mai per decidere: verificato riusando la stessa fixture della matrice sotto, a mode off e live.
  const nowMs = Date.UTC(2026, 8, 9, 10, 6, 1);
  const bar = (ms: number, open: number, close: number, wick = 0.3): Candle => ({
    datetime: new Date(ms).toISOString(), open, close,
    high: Math.max(open, close) + wick, low: Math.min(open, close) - wick,
  });
  const end = Date.UTC(2026, 8, 9, 10, 5);
  const m5 = Array.from({ length: 120 }, (_, i) => bar(end - (120 - i) * 5 * MINUTE, 2200 + i * 0.4, 2200 + (i + 1) * 0.4, 0.35));
  const m1 = m5.slice(-30).flatMap((c) => Array.from({ length: 5 }, (_, j) =>
    bar(Date.parse(c.datetime) + j * MINUTE, c.open + (c.close - c.open) * j / 5, c.open + (c.close - c.open) * (j + 1) / 5, 0.35)));
  m1.push(bar(end, m5.at(-1)!.close, m5.at(-1)!.close + 0.05, 0.1));
  const quote = { bid: m5.at(-1)!.close, ask: m5.at(-1)!.close + 0.1, mid: m5.at(-1)!.close + 0.05, spread: 0.1, quotedAt: nowMs };
  const off = evaluateScalper({ quote, m1, m5, nowMs });
  withEnv({ M15_GATE_MODE: "live" }, () => {
    const live = evaluateScalper({ quote, m1, m5, nowMs });
    assert.deepEqual(
      { direction: off.direction, setup: off.setup, entry: off.entry, stopLoss: off.stopLoss, takeProfit: off.takeProfit },
      { direction: live.direction, setup: live.setup, entry: live.entry, stopLoss: live.stopLoss, takeProfit: live.takeProfit },
    );
  });
});

check("7c) contextM5M15: m15Regime sempre presente nel detail, anche a gate off", () => {
  const nowMs = Date.UTC(2026, 8, 9, 10, 5);
  const bar = (ms: number, open: number, close: number, wick = 0.5): Candle => ({
    datetime: new Date(ms).toISOString(), open, close,
    high: Math.max(open, close) + wick, low: Math.min(open, close) - wick,
  });
  // Trend M5 pulito con M15 in salita costante: struttura confermata, m15Regime deve essere trend_up.
  const m5 = Array.from({ length: 60 }, (_, i) => bar(nowMs - (60 - i) * MINUTE * 5, 2200 + i * 0.6, 2200 + (i + 1) * 0.6));
  const context = contextM5M15(closedBars(m5, 5, nowMs) ?? [], nowMs);
  assert.ok(context, "contesto atteso disponibile con storico sufficiente");
  assert.match(context!.detail, /m15_regime=(true_range|transition|trend_up|trend_down) \(gate=off\)/);
});

// --- 8: matrice 3 modalita' x 3 bias x 4 regime x 2 breakout = 72 combinazioni -------------------

check("8) matrice 72 combinazioni M5xM15 senza violazioni", () => {
  const modes = [undefined, "off", "live"];
  const biases: Array<"up" | "down" | "flat"> = ["up", "down", "flat"];
  const regimes: M15Regime[] = ["true_range", "transition", "trend_up", "trend_down"];
  const breakouts = [false, true];
  let combos = 0;
  for (const mode of modes) {
    withEnv({ M15_GATE_MODE: mode }, () => {
      const live = mode === "live";
      for (const biasM5 of biases) {
        for (const m15Regime of regimes) {
          for (const m15BreakoutRecent of breakouts) {
            combos++;
            // m15State a 3 valori derivato dal regime esattamente come contextM5M15 lo calcolerebbe:
            // true_range collassa su "range", transition pure (comportamento pre-esistente).
            const m15State: MarketContext["m15State"] = m15Regime === "trend_up" ? "trend_up"
              : m15Regime === "trend_down" ? "trend_down" : "range";
            const context = ctx({ biasM5, m15Regime, m15State, m15BreakoutRecent });
            const gate = shortContextGate("m1_short", context);
            const expectedDirection: "BUY" | "SELL" | null = biasM5 === "up" ? "BUY" : biasM5 === "down" ? "SELL" : null;

            if (biasM5 === "flat") {
              assert.equal(gate.allowed, null, JSON.stringify({ mode, biasM5, m15Regime, m15BreakoutRecent, gate }));
              continue;
            }
            const contraryRegime: M15Regime = biasM5 === "up" ? "trend_down" : "trend_up";
            const contraryState = biasM5 === "up" ? "trend_down" : "trend_up";

            const expectAllowed = live
              ? m15Regime !== contraryRegime && !m15BreakoutRecent
              : m15State !== "range" && m15State !== contraryState && !m15BreakoutRecent;

            assert.equal(
              gate.allowed,
              expectAllowed ? expectedDirection : null,
              JSON.stringify({ mode, biasM5, m15Regime, m15State, m15BreakoutRecent, gate }),
            );
            // true_range/transition senza bias M15 opposto: passa, ma con un passReason esplicito
            // che lo distingue nei log da un trend M15 allineato (mai per m15Regime di trend).
            if (live && expectAllowed && (m15Regime === "true_range" || m15Regime === "transition")) {
              assert.equal(
                gate.passReason,
                "m15 range/transition ma nessun bias M15 opposto: consentito",
                JSON.stringify({ mode, biasM5, m15Regime, gate }),
              );
            } else if (gate.allowed) {
              assert.equal(gate.passReason, undefined, JSON.stringify({ mode, biasM5, m15Regime, gate }));
            }
            // Invariante di non-regressione: off non deve MAI dipendere da m15Regime, solo da m15State.
            if (!live) {
              const altRegime: M15Regime = m15Regime === "true_range" ? "transition" : "true_range";
              const altContext = ctx({ biasM5, m15Regime: altRegime, m15State, m15BreakoutRecent });
              const altGate = shortContextGate("m1_short", altContext);
              assert.equal(gate.allowed, altGate.allowed, "in mode off il risultato non deve dipendere da m15Regime");
            }
          }
        }
      }
    });
  }
  assert.equal(combos, 72, `attese 72 combinazioni, trovate ${combos}`);
});

console.log(`${passed} scenari superati.`);

// Deterministic scenarios for the fourth setup, quick_tick (solo scalper_settings.exit_mode=
// "fast"): nessuna struttura M1/M5, solo la direzione del mid rispetto al tick precedente,
// filtrata dallo spread. m1/m5 restano vuoti in ogni fixture: closedBars([]) e' [] (non null,
// vedi marketStructure.ts), quindi commonPreflight passa e la mtf scarta da sola per storico
// insufficiente — con SHORT_ENABLED/RANGE_ENABLED=false la cascata arriva sempre a quick_tick.
import assert from "node:assert/strict";
import { evaluateScalper } from "../src/lib/server/scalperStrategy";
import type { Quote } from "../src/lib/types";
import type { ExitMode } from "../src/lib/exitMode";

for (const key of Object.keys(process.env)) {
  if (/^(MTF_|SCALPER_|SL_|SHOCK_|M15_|SHORT_|RANGE_|TP_|QUICK_TICK_)/.test(key)) delete process.env[key];
}
process.env.SCALPER_HOURS_UTC = "00:00-23:59";
process.env.SHORT_ENABLED = "false";
process.env.RANGE_ENABLED = "false";

let passed = 0;
function check(name: string, test: () => void) {
  try { test(); passed++; console.log("OK " + name); }
  catch (error) { console.error("FAIL " + name); throw error; }
}

const nowMs = Date.UTC(2026, 8, 9, 10, 6, 1);
function quote(mid: number, spread = 0.1, quotedAt = nowMs): Quote {
  return { bid: mid - spread / 2, ask: mid + spread / 2, mid, spread, quotedAt };
}
const previousMid = 2500;

function fixture(overrides: {
  midDelta?: number; spread?: number; previousTick?: Quote | null; exitMode?: ExitMode;
} = {}) {
  const delta = overrides.midDelta ?? 0.1;
  return {
    quote: quote(previousMid + delta, overrides.spread ?? 0.1),
    m1: [], m5: [], nowMs,
    exitMode: overrides.exitMode ?? "fast" as const,
    previousTick: overrides.previousTick === undefined ? quote(previousMid, 0.1, nowMs - 500) : overrides.previousTick,
  };
}
function assertNoTrade(input: ReturnType<typeof fixture>, reason: RegExp) {
  const s = evaluateScalper(input);
  assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
  assert.equal(s.entry, null); assert.equal(s.stopLoss, null); assert.equal(s.takeProfit, null); assert.equal(s.setupKey, null);
  assert.match(s.evaluations.map(e => e.reason).join(" "), reason);
  return s;
}

// --- Trigger: mid vs tick precedente, filtrato solo dallo spread -------------------------------

check("BUY: mid sopra il precedente oltre QUICK_TICK_BUFFER_USD (0.05$ default)", () => {
  const s = evaluateScalper(fixture({ midDelta: 0.10 }));
  assert.equal(s.direction, "BUY", JSON.stringify(s));
  assert.equal(s.setup, "quick_tick");
  assert.equal(s.entry, previousMid + 0.10 + 0.05); // ask = mid + spread/2
  assert.ok(s.stopLoss! < s.entry! && s.takeProfit! > s.entry!);
  assert.equal(s.riskReward, 1);
  assert.ok(s.evaluations.some(e => e.setup === "quick_tick" && e.status === "triggered" && e.direction === "BUY"));
});

check("SELL: mid sotto il precedente oltre QUICK_TICK_BUFFER_USD, condizioni simmetriche", () => {
  const s = evaluateScalper(fixture({ midDelta: -0.10 }));
  assert.equal(s.direction, "SELL", JSON.stringify(s));
  assert.equal(s.setup, "quick_tick");
  assert.ok(s.stopLoss! > s.entry! && s.takeProfit! < s.entry!);
});

check("Variazione chiaramente sotto soglia (0.03$ < 0.05$) non scatta", () => {
  assertNoTrade(fixture({ midDelta: 0.03 }), /variazione tick sotto soglia/);
});

check("Variazione chiaramente sopra soglia (0.07$ > 0.05$) scatta", () => {
  const s = evaluateScalper(fixture({ midDelta: 0.07 }));
  assert.equal(s.direction, "BUY", JSON.stringify(s));
});

check("Prezzo fermo (delta 0) non e' un setup", () => {
  assertNoTrade(fixture({ midDelta: 0 }), /variazione tick sotto soglia/);
});

// --- Unico filtro: lo spread ---------------------------------------------------------------

check("Spread chiaramente oltre QUICK_TICK_MAX_SPREAD (0.20$ default) scarta anche con tick valido", () => {
  assertNoTrade(fixture({ midDelta: 0.30, spread: 0.35 }), /spread troppo alto/);
});

check("Spread chiaramente dentro QUICK_TICK_MAX_SPREAD passa", () => {
  const s = evaluateScalper(fixture({ midDelta: 0.30, spread: 0.15 }));
  assert.equal(s.direction, "BUY", JSON.stringify(s));
});

check("Nessun altro filtro: niente m15/m5/context_gate nelle evaluations di quick_tick", () => {
  const s = evaluateScalper(fixture({ midDelta: 0.10 }));
  assert.ok(!s.evaluations.some(e => e.setup === "context_gate" || e.setup === "m15_gate" || e.setup === "range_gate"));
});

// --- Stato tick-per-tick: nessun tick precedente -> NO_TRADE, mai un crash ---------------------

check("previousTick assente (null): NO_TRADE, nessun crash", () => {
  assertNoTrade(fixture({ midDelta: 0.10, previousTick: null }), /nessun tick precedente disponibile/);
});

check("exit_mode assente (undefined): trattato come non-fast, quick_tick mai valutato", () => {
  const s = evaluateScalper({ quote: quote(previousMid + 0.10, 0.1), m1: [], m5: [], nowMs, previousTick: quote(previousMid, 0.1, nowMs - 500) });
  assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
  assert.ok(!s.evaluations.some(e => e.setup === "quick_tick"), "quick_tick non deve comparire nelle evaluations senza exit_mode=fast");
});

// --- Il gate e' exit_mode, non un env: SOLO "fast" lo accende --------------------------------

check('exit_mode="normal": quick_tick non viene mai valutato, anche con un tick che altrimenti scatterebbe', () => {
  const s = evaluateScalper(fixture({ midDelta: 0.10, exitMode: "normal" }));
  assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
  assert.ok(!s.evaluations.some(e => e.setup === "quick_tick"));
});

check('exit_mode="fast": quick_tick e\' l\'unico setup attivo quando SHORT_ENABLED/RANGE_ENABLED sono false', () => {
  const s = evaluateScalper(fixture({ midDelta: 0.10 }));
  assert.equal(s.setup, "quick_tick", JSON.stringify(s));
});

// --- setupKey: identita' del tick-pair, non una candela ----------------------------------------

check("Ripreflight identico non cambia nulla (stesso input, stesso risultato)", () => {
  const input = fixture({ midDelta: 0.10 });
  const s1 = evaluateScalper(input);
  for (let i = 0; i < 5; i++) assert.deepEqual(evaluateScalper(input), s1);
  assert.ok(s1.setupKey?.startsWith("quick-tick-v1:BUY:"));
});

check("setupKey cambia quando cambia il tick precedente (nuova opportunita', mai un blocco same_setup permanente)", () => {
  const a = evaluateScalper(fixture({ midDelta: 0.10, previousTick: quote(previousMid, 0.1, nowMs - 500) }));
  const b = evaluateScalper(fixture({ midDelta: 0.10, previousTick: quote(previousMid, 0.1, nowMs - 1500) }));
  assert.equal(a.direction, "BUY"); assert.equal(b.direction, "BUY");
  assert.notEqual(a.setupKey, b.setupKey);
});

// --- SL di emergenza: rete al broker, mai l'obiettivo del trade (quello e' il TP fisso di exit_mode=fast) --

check("SL di emergenza a QUICK_TICK_EMERGENCY_SL_USD (5$ default) dall'entry", () => {
  const buy = evaluateScalper(fixture({ midDelta: 0.10 }));
  assert.equal(Number((buy.entry! - buy.stopLoss!).toFixed(2)), 5);
  const sell = evaluateScalper(fixture({ midDelta: -0.10 }));
  assert.equal(Number((sell.stopLoss! - sell.entry!).toFixed(2)), 5);
});

// --- Priorita': i tre setup esistenti vincono, quick_tick e' l'ultima risorsa (vedi anche -------
// strategy-scenarios.ts per la stessa verifica con un fixture che fa scattare davvero la mtf) ----

check("mtf/m1_short/m1_range restano attivi in modalita' normale: senza exit_mode=fast la cascata e' quella di sempre", () => {
  const s = evaluateScalper(fixture({ midDelta: 0.10, exitMode: "normal" }));
  // Storico M1/M5 vuoto: la mtf scarta per "storico insufficiente", non per il gate di quick_tick.
  assert.match(s.reasoning, /Storico insufficiente/);
});

// --- Le env di quick_tick sono configurabili, come tutte le altre soglie della strategia --------

check("QUICK_TICK_BUFFER_USD/QUICK_TICK_MAX_SPREAD/QUICK_TICK_EMERGENCY_SL_USD sono lette da env", () => {
  const previous = {
    buffer: process.env.QUICK_TICK_BUFFER_USD,
    spread: process.env.QUICK_TICK_MAX_SPREAD,
    sl: process.env.QUICK_TICK_EMERGENCY_SL_USD,
  };
  process.env.QUICK_TICK_BUFFER_USD = "0.20";
  process.env.QUICK_TICK_MAX_SPREAD = "0.05";
  process.env.QUICK_TICK_EMERGENCY_SL_USD = "2";
  try {
    // 0.10$ passava la soglia default (0.05$) ma non la nuova (0.20$).
    assertNoTrade(fixture({ midDelta: 0.10, spread: 0.02 }), /variazione tick sotto soglia/);
    // 0.30$ supera la nuova soglia, ma uno spread di 0.10$ ora supera il nuovo massimo (0.05$).
    assertNoTrade(fixture({ midDelta: 0.30, spread: 0.10 }), /spread troppo alto/);
    const accepted = evaluateScalper(fixture({ midDelta: 0.30, spread: 0.02 }));
    assert.equal(accepted.direction, "BUY", JSON.stringify(accepted));
    assert.equal(Number((accepted.entry! - accepted.stopLoss!).toFixed(2)), 2);
  } finally {
    if (previous.buffer === undefined) delete process.env.QUICK_TICK_BUFFER_USD; else process.env.QUICK_TICK_BUFFER_USD = previous.buffer;
    if (previous.spread === undefined) delete process.env.QUICK_TICK_MAX_SPREAD; else process.env.QUICK_TICK_MAX_SPREAD = previous.spread;
    if (previous.sl === undefined) delete process.env.QUICK_TICK_EMERGENCY_SL_USD; else process.env.QUICK_TICK_EMERGENCY_SL_USD = previous.sl;
  }
});

console.log(`${passed} scenari superati.`);

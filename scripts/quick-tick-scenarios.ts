// Deterministic scenarios for the fourth setup, quick_tick (solo scalper_settings.exit_mode=
// "fast"): tre condizioni — direzione dal bias_m5 gia' calcolato per context_gate, rottura su tick
// di una finestra M1 corta (stesso trigger di m1_gate/m1_short), spread entro un rapporto sulla
// media rolling delle ultime M1 chiuse (fallback assoluto in warmup) — poi SL/TP dimensionati
// sull'ATR M1 e mandati al broker come ordine reale (nessun target1/breakeven/trailing).
import assert from "node:assert/strict";
import { evaluateScalper } from "../src/lib/server/scalperStrategy";
import { MINUTE } from "../src/lib/server/marketStructure";
import type { Candle } from "../src/lib/types";
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
function withEnv(overrides: Record<string, string>, test: () => void) {
  const previous = new Map(Object.keys(overrides).map((k) => [k, process.env[k]]));
  Object.assign(process.env, overrides);
  try { test(); } finally {
    for (const [k, v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const M5 = 5 * MINUTE, M15 = 15 * MINUTE;
const bar = (ms: number, open: number, close: number, wick = 0.3): Candle => ({
  datetime: new Date(ms).toISOString(), open, close,
  high: Math.max(open, close) + wick, low: Math.min(open, close) - wick,
});

/** M15 a gradini (due gruppi a favore, uno contro) per un bias_m5 pulito: stesso schema di strategy-scenarios.ts. */
function contextM5(bias: "up" | "down", end: number, total = 120) {
  const deltas = Array.from({ length: total }, (_, i) => {
    const group = Math.floor((end - (total - 1 - i) * M5) / M15) % 3;
    const step = group === 2 ? -0.5 : 1;
    return bias === "up" ? step : -step;
  });
  const levels: number[] = [];
  let level = 0;
  for (const delta of deltas) { levels.push(level); level += delta; }
  const offset = 2200 - level;
  return deltas.map((delta, i) => bar(end - (total - 1 - i) * M5,
    levels[i] + offset, levels[i] + offset + delta, Math.max(0.5, Math.abs(delta))));
}

/** M5 laterale (stesso schema usato per m1_range in strategy-scenarios.ts): bias_m5 resta "flat". */
function flatContextM5(end: number, total = 120) {
  const mid = 2200, wide = 22;
  const out: Candle[] = [];
  let previous = mid - (total - 6) * 0.5;
  for (let i = 0; i < total; i++) {
    const close = i <= total - 7 ? mid - (total - 7 - i) * 0.5 : i <= total - 3 ? mid + 10 : mid - 6;
    out.push(bar(end - (total - 1 - i) * M5, previous, close, i <= total - 7 ? 0.6 : wide));
    previous = close;
  }
  return out;
}

const END = Date.UTC(2026, 8, 9, 10, 5);
const M1_TOTAL = 40;

/** Finestra M1 piatta attorno a `level`: stesso schema (alternanza su/giu') di shortInput in strategy-scenarios.ts. */
function flatM1(level: number) {
  const m1: Candle[] = [];
  for (let i = 0; i < M1_TOTAL; i++) {
    const up = i % 2 === 0;
    m1.push(bar(END - (M1_TOTAL - 1 - i) * MINUTE, up ? level - 0.5 : level + 0.5, up ? level + 0.5 : level - 0.5, 0.2));
  }
  return m1;
}

function quoteFor(direction: "BUY" | "SELL" | null, high: number, low: number, distance: number, spread: number) {
  if (direction === "BUY") {
    const bid = high + distance;
    return { bid, ask: bid + spread, mid: bid + spread / 2, spread, quotedAt: END };
  }
  if (direction === "SELL") {
    const ask = low - distance;
    return { bid: ask - spread, ask, mid: ask - spread / 2, spread, quotedAt: END };
  }
  const mid = (high + low) / 2;
  return { bid: mid - spread / 2, ask: mid + spread / 2, mid, spread, quotedAt: END };
}

function fixture(options: {
  bias?: "up" | "down" | "flat";
  breakout?: "BUY" | "SELL" | "inside";
  distance?: number;
  spread?: number;
  quickTickSpreadAvg?: number | null;
  exitMode?: ExitMode;
  level?: number;
} = {}) {
  const bias = options.bias ?? "up";
  const m5 = bias === "flat" ? flatContextM5(END) : contextM5(bias, END);
  const m1 = flatM1(options.level ?? 2200);
  const closedM1 = m1.slice(0, -1); // l'ultima e' la candela in formazione a nowMs=END
  const window = closedM1.slice(-6); // QUICK_TICK_M1_WINDOW default
  const high = Math.max(...window.map((c) => c.high)), low = Math.min(...window.map((c) => c.low));
  const breakout = options.breakout ?? (bias === "up" ? "BUY" : bias === "down" ? "SELL" : "inside");
  const quote = quoteFor(breakout === "inside" ? null : breakout, high, low, options.distance ?? 0.30, options.spread ?? 0.10);
  return {
    nowMs: END, m1, m5, quote,
    exitMode: options.exitMode ?? "fast" as const,
    quickTickSpreadAvg: options.quickTickSpreadAvg === undefined ? null : options.quickTickSpreadAvg,
  };
}
function gateReason(s: ReturnType<typeof evaluateScalper>) {
  return s.evaluations.find((e) => e.setup === "quick_tick_gate")?.reason ?? "";
}

// --- Trigger di base: le tre condizioni tutte vere insieme -------------------------------------

check("BUY: bias_m5=up, rottura sopra la finestra M1, spread ok", () => {
  const s = evaluateScalper(fixture());
  assert.equal(s.direction, "BUY", JSON.stringify(s));
  assert.equal(s.setup, "quick_tick");
  // Le valutazioni convivono: la mtf lascia le sue (m15_gate incluso se arriva fin li'), poi
  // context_gate e quick_tick_gate di quick_tick sono sempre le ultime due.
  assert.deepEqual(s.evaluations.map((e) => e.setup).slice(-2), ["context_gate", "quick_tick_gate"]);
  const [contextEval, gateEval] = s.evaluations.slice(-2);
  assert.equal(contextEval.status, "triggered");
  assert.match(contextEval.reason, /bias_m5=up/);
  assert.equal(gateEval.status, "triggered");
  assert.match(gateEval.reason, /finestra 6 M1 chiuse/);
  assert.ok(s.stopLoss! < s.entry! && s.takeProfit! > s.entry!);
  assert.ok(s.setupKey?.startsWith("quick-tick-v2:BUY:"), s.setupKey ?? "");
});

check("SELL: bias_m5=down, rottura sotto la finestra M1, condizioni simmetriche", () => {
  const s = evaluateScalper(fixture({ bias: "down" }));
  assert.equal(s.direction, "SELL", JSON.stringify(s));
  assert.equal(s.setup, "quick_tick");
  assert.ok(s.stopLoss! > s.entry! && s.takeProfit! < s.entry!);
});

// --- CONDIZIONE 1: direzione dal bias_m5, riusato da context_gate ------------------------------

check("bias_m5=flat: quick_tick non valuta nulla, NO_TRADE immediato senza toccare l'M1", () => {
  const s = evaluateScalper(fixture({ bias: "flat", breakout: "BUY" }));
  assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
  assert.equal(s.evaluations.at(-1)!.setup, "context_gate");
  assert.match(s.evaluations.at(-1)!.reason, /bias_m5=flat/);
  assert.ok(!s.evaluations.some((e) => e.setup === "quick_tick_gate"), "con bias flat l'M1 non deve nemmeno essere guardato");
});

check("bias_m5=up ammette solo BUY: una rottura verso il basso viene scartata", () => {
  const s = evaluateScalper(fixture({ bias: "up", breakout: "SELL" }));
  assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
  const gate = s.evaluations.find((e) => e.setup === "quick_tick_gate")!;
  assert.equal(gate.direction, "SELL");
  assert.match(gate.reason, /bias_m5=up ammette solo BUY/);
});

check("bias_m5=down ammette solo SELL: una rottura verso l'alto viene scartata", () => {
  const s = evaluateScalper(fixture({ bias: "down", breakout: "BUY" }));
  assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
  assert.match(gateReason(s), /bias_m5=down ammette solo SELL/);
});

// --- CONDIZIONE 2: rottura su tick della finestra M1 corta --------------------------------------

check("prezzo dentro la finestra (nessuna rottura): NO_TRADE", () => {
  const s = evaluateScalper(fixture({ breakout: "inside" }));
  assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
  assert.match(gateReason(s), /prezzo dentro la finestra/);
});

check("rottura entro QUICK_TICK_BREAKOUT_BUFFER_USD (0.15$ default) non basta", () => {
  const s = evaluateScalper(fixture({ distance: 0.05 }));
  assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
});

check("rottura chiaramente oltre il buffer scatta", () => {
  const s = evaluateScalper(fixture({ distance: 0.30 }));
  assert.equal(s.direction, "BUY", JSON.stringify(s));
});

check("QUICK_TICK_BREAKOUT_BUFFER_USD e' letto da env", () => {
  // Stessa distanza (0.30$) che scatta di default: con la soglia alzata a 0.50$ non basta piu'.
  withEnv({ QUICK_TICK_BREAKOUT_BUFFER_USD: "0.50" }, () => {
    const s = evaluateScalper(fixture({ distance: 0.30 }));
    assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
  });
});

// --- CONDIZIONE 3: spread entro un rapporto sulla media rolling, fallback assoluto in warmup ----

check("spread entro QUICK_TICK_MAX_SPREAD_RATIO (1.5 default) volte la media rolling: passa", () => {
  const s = evaluateScalper(fixture({ spread: 0.12, quickTickSpreadAvg: 0.10 })); // 0.12 <= 1.5*0.10
  assert.equal(s.direction, "BUY", JSON.stringify(s));
});

check("spread oltre QUICK_TICK_MAX_SPREAD_RATIO volte la media rolling: scarta", () => {
  const s = evaluateScalper(fixture({ spread: 0.20, quickTickSpreadAvg: 0.10 })); // 0.20 > 1.5*0.10
  assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
  assert.match(gateReason(s), /oltre 1\.5x la media rolling/);
});

check("warmup (media rolling non disponibile): fallback QUICK_TICK_MAX_SPREAD (0.20$ default)", () => {
  const passes = evaluateScalper(fixture({ spread: 0.15, quickTickSpreadAvg: null }));
  assert.equal(passes.direction, "BUY", JSON.stringify(passes));
  const rejects = evaluateScalper(fixture({ spread: 0.25, quickTickSpreadAvg: null }));
  assert.equal(rejects.direction, "NO_TRADE", JSON.stringify(rejects));
  assert.match(gateReason(rejects), /fallback.*warmup/);
});

check("media rolling a zero/negativa e' trattata come warmup, mai una divisione impossibile", () => {
  const s = evaluateScalper(fixture({ spread: 0.15, quickTickSpreadAvg: 0 }));
  assert.equal(s.direction, "BUY", JSON.stringify(s)); // 0.15 <= fallback 0.20
});

check("QUICK_TICK_MAX_SPREAD_RATIO e QUICK_TICK_MAX_SPREAD sono lette da env", () => {
  withEnv({ QUICK_TICK_MAX_SPREAD_RATIO: "3" }, () => {
    // Con rapporto alzato a 3x, uno spread che prima scartava (0.20 > 1.5*0.10) ora passa (0.20 <= 3*0.10).
    const s = evaluateScalper(fixture({ spread: 0.20, quickTickSpreadAvg: 0.10 }));
    assert.equal(s.direction, "BUY", JSON.stringify(s));
  });
  withEnv({ QUICK_TICK_MAX_SPREAD: "0.05" }, () => {
    const s = evaluateScalper(fixture({ spread: 0.10, quickTickSpreadAvg: null })); // warmup, fallback ora 0.05
    assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
  });
});

// --- Uscita: SL/TP dimensionati sull'ATR M1, entrambi al broker --------------------------------

check("TP = QUICK_TICK_TP_ATR_MULT * ATR M1, clampato fra MIN e MAX", () => {
  const s = evaluateScalper(fixture());
  assert.equal(s.direction, "BUY", JSON.stringify(s));
  const atr1 = s.slPlan!.atr / 1.2; // risale all'ATR reale da QUICK_TICK_SL_ATR_MULT default
  const expectedReward = Math.min(Math.max(1.5 * atr1, 2), 4);
  assert.ok(Math.abs((s.takeProfit! - s.entry!) - expectedReward) <= 0.011, JSON.stringify(s.slPlan));
  assert.equal(s.riskReward, Number((expectedReward / (s.entry! - s.stopLoss!)).toFixed(2)));
});

check("SL = QUICK_TICK_SL_ATR_MULT * ATR M1, mai sotto QUICK_TICK_SL_MIN_USD", () => {
  const s = evaluateScalper(fixture());
  const atr1 = s.slPlan!.atr / 1.2;
  const expectedRisk = Math.max(1.2 * atr1, 2.5);
  assert.ok(Math.abs((s.entry! - s.stopLoss!) - expectedRisk) <= 0.011, JSON.stringify(s.slPlan));
});

check("TP: un moltiplicatore ATR minimo resta comunque al pavimento QUICK_TICK_TP_MIN_USD (2$)", () => {
  withEnv({ QUICK_TICK_TP_ATR_MULT: "0.1" }, () => {
    const s = evaluateScalper(fixture());
    assert.equal(s.direction, "BUY", JSON.stringify(s));
    assert.ok(Math.abs((s.takeProfit! - s.entry!) - 2) <= 0.011, JSON.stringify(s));
  });
});

check("TP: un moltiplicatore ATR massimo resta comunque al tetto QUICK_TICK_TP_MAX_USD (4$)", () => {
  withEnv({ QUICK_TICK_TP_ATR_MULT: "10" }, () => {
    const s = evaluateScalper(fixture());
    assert.equal(s.direction, "BUY", JSON.stringify(s));
    assert.ok(Math.abs((s.takeProfit! - s.entry!) - 4) <= 0.011, JSON.stringify(s));
  });
});

check("SL: oltre QUICK_TICK_SL_MAX_USD (6$) scarta il trade, non lo stringe (come RANGE_SL_MAX_PCT su m1_range)", () => {
  withEnv({ QUICK_TICK_SL_ATR_MULT: "10" }, () => {
    const s = evaluateScalper(fixture());
    assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
    assert.match(gateReason(s), /SL richiesto.*oltre il massimo/);
  });
});

check("entrambi SL e TP sono finiti e vanno al broker: nessun tpBroker/target1 separato", () => {
  const s = evaluateScalper(fixture());
  assert.equal(s.direction, "BUY");
  assert.ok(Number.isFinite(s.stopLoss!) && Number.isFinite(s.takeProfit!));
  assert.equal(s.tpBroker, undefined);
});

// --- setupKey: livello + candela chiusa, come m1_short (un tentativo finche' non chiude una nuova M1) --

check("setupKey stabile: ripreflight identico non consuma nulla", () => {
  const input = fixture();
  const s1 = evaluateScalper(input);
  for (let i = 0; i < 5; i++) assert.deepEqual(evaluateScalper(input), s1);
});

check("setupKey porta il livello della finestra: cambia se il livello cambia", () => {
  const a = evaluateScalper(fixture({ level: 2200 }));
  const b = evaluateScalper(fixture({ level: 2300 }));
  assert.equal(a.direction, "BUY"); assert.equal(b.direction, "BUY");
  assert.notEqual(a.setupKey, b.setupKey);
});

// --- Il gate e' exit_mode, non un env: SOLO "fast" valuta quick_tick ----------------------------

check('exit_mode="normal": quick_tick non viene mai valutato, anche con un input che altrimenti scatterebbe', () => {
  const s = evaluateScalper(fixture({ exitMode: "normal" }));
  assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
  assert.ok(!s.evaluations.some((e) => e.setup === "quick_tick_gate" || e.setup === "quick_tick"));
});

check("exit_mode assente (undefined): trattato come non-fast, quick_tick mai valutato", () => {
  const { exitMode: _drop, ...rest } = fixture();
  const s = evaluateScalper(rest);
  assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
  assert.ok(!s.evaluations.some((e) => e.setup === "quick_tick_gate"));
});

console.log(`${passed} scenari superati.`);

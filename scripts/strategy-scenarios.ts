// Deterministic, offline scenarios: no broker, database or wall-clock dependency.
import assert from "node:assert/strict";
import { evaluateScalper, plannedEntryValid } from "../src/lib/server/scalperStrategy";
import { definitelyRejected, recoverOrder, riskPerLot } from "../src/lib/server/orderSafety";
import { aggregateM15, closedBars, MINUTE, swingLevels } from "../src/lib/server/marketStructure";
import type { Candle } from "../src/lib/types";

// Isolate test configuration from deployment/local env.
for (const key of Object.keys(process.env)) {
  if (/^(MTF_|SCALPER_|SL_|SHOCK_|M15_|SHORT_)/.test(key)) delete process.env[key];
}
process.env.SCALPER_HOURS_UTC = "00:00-23:59";
// Gli scenari mtf girano con il secondo setup spento: ognuno verifica una strategia sola.
process.env.SHORT_ENABLED = "false";
function withShort(env: Record<string, string>, test: () => void) {
  const previous = new Map(Object.keys(env).concat("SHORT_ENABLED").map(k => [k, process.env[k]]));
  process.env.SHORT_ENABLED = "true";
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try { test(); } finally {
    for (const [k, v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const nowMs = Date.UTC(2026, 8, 9, 10, 6, 1);
const bar = (ms: number, open: number, close: number, wick = 0.3): Candle => ({
  datetime: new Date(ms).toISOString(), open, close,
  high: Math.max(open, close) + wick, low: Math.min(open, close) - wick,
});
function fixture() {
  const end = Date.UTC(2026, 8, 9, 10, 5);
  const m5 = Array.from({ length: 120 }, (_, i) => bar(end - (120 - i) * 5 * MINUTE, 2200 + i * 0.4, 2200 + (i + 1) * 0.4, 0.35));
  const base = m5[116].close;
  m5[117] = bar(Date.parse(m5[117].datetime), base, base + 10, 0.4);
  m5[118] = bar(Date.parse(m5[118].datetime), base + 10, base + 5, 0.3);
  m5[119] = bar(Date.parse(m5[119].datetime), base + 5, base + 2, 0.7);
  const m1 = m5.slice(-30).flatMap(c => Array.from({ length: 5 }, (_, j) =>
    bar(Date.parse(c.datetime) + j * MINUTE, c.open + (c.close - c.open) * j / 5,
      c.open + (c.close - c.open) * (j + 1) / 5, 0.35)));
  m1.push(bar(end, base + 2, base + 3.7, 0.1));
  // Ingresso su tick: il prezzo live supera di oltre ENTRY_BUFFER_USD il massimo dell'ultima M1 chiusa.
  const bid = base + 3.95;
  return { nowMs, m1, m5, quote: { bid, ask: bid + 0.12, mid: bid + 0.06, spread: 0.12, quotedAt: nowMs } };
}
type Input = ReturnType<typeof fixture>;
function mirror(input: Input): Input {
  const invert = (c: Candle): Candle => ({ ...c, open: 5000 - c.open, close: 5000 - c.close, high: 5000 - c.low, low: 5000 - c.high });
  return { ...input, m1: input.m1.map(invert), m5: input.m5.map(invert),
    quote: { ...input.quote, bid: 5000 - input.quote.ask, ask: 5000 - input.quote.bid, mid: 5000 - input.quote.mid } };
}
function withClosureGap(input: Input, cutoffMs: number, reopenMs: number, closureMs: number): Input {
  const delta = reopenMs - cutoffMs;
  const shift = (ms: number) => ms + delta - (ms < cutoffMs ? closureMs : 0);
  const move = (c: Candle): Candle => ({ ...c, datetime: new Date(shift(Date.parse(c.datetime))).toISOString() });
  return {
    ...input,
    nowMs: shift(input.nowMs),
    m1: input.m1.map(move),
    m5: input.m5.map(move),
    quote: { ...input.quote, quotedAt: shift(input.quote.quotedAt) },
  };
}
function withLiveSession(test: () => void) {
  const previous = process.env.SCALPER_HOURS_UTC;
  process.env.SCALPER_HOURS_UTC = "22:00-20:30";
  try { test(); } finally { process.env.SCALPER_HOURS_UTC = previous; }
}
let passed = 0;
function check(name: string, test: () => void) {
  try { test(); passed++; console.log("OK " + name); }
  catch (error) { console.error("FAIL " + name); throw error; }
}
function rejected(input: Input, reason: RegExp) {
  const s = evaluateScalper(input);
  assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
  assert.match(s.reasoning + s.evaluations.map(e => e.reason).join(" "), reason);
  assert.equal(s.entry, null); assert.equal(s.stopLoss, null); assert.equal(s.takeProfit, null); assert.equal(s.setupKey, null);
}
check("BUY: M15 trend, M5 pullback, M1 confirmed", () => {
  const s = evaluateScalper(fixture());
  assert.equal(s.direction, "BUY", JSON.stringify(s)); assert.equal(s.setup, "micro_pullback");
  assert.ok(s.stopLoss! < s.entry! && s.takeProfit! > s.entry! && s.riskReward! >= 1.5);
  assert.ok(s.setupKey?.startsWith("mtf-continuation-v1:BUY"));
});
check("M5 breakout retest when the broken level is touched", () => {
  const input = fixture(); input.m5.at(-1)!.low -= 0.4;
  const s = evaluateScalper(input);
  assert.equal(s.direction, "BUY", JSON.stringify(s)); assert.equal(s.setup, "breakout_retest");
});
check("SELL uses symmetric conditions and prices", () => {
  const s = evaluateScalper(mirror(fixture()));
  assert.equal(s.direction, "SELL", JSON.stringify(s));
  assert.ok(s.stopLoss! > s.entry! && s.takeProfit! < s.entry!);
});
check("Repeated preflights never consume a setup", () => {
  const input = fixture(), before = structuredClone(input), s = evaluateScalper(input);
  for (let i = 0; i < 5; i++) assert.deepEqual(evaluateScalper(input), s);
  assert.deepEqual(input, before);
});
check("Missing quote time / stale / future quotes blocked", () => {
  for (const offset of [-10_000, 10_000]) {
    const input = fixture(); input.quote.quotedAt += offset; rejected(input, /Quote/);
  }
  const input = fixture(); input.quote.quotedAt = NaN; rejected(input, /Quote/);
});
check("Spread derived from bid/ask, not trusted spread field", () => {
  const input = fixture(); input.quote.ask += 2; rejected(input, /Spread/);
});
check("No entry chasing an extended M1 confirmation", () => {
  const input = fixture(); input.quote.bid += 2; input.quote.ask += 2; input.quote.mid += 2;
  rejected(input, /esteso/);
});
check("Live price loses trigger level", () => {
  const input = fixture(); input.quote.bid -= 3; input.quote.ask -= 3; input.quote.mid -= 3;
  rejected(input, /non oltre il livello M1/);
});
check("Il livello va superato di ENTRY_BUFFER_USD, non solo toccato", () => {
  const input = fixture();
  const level = input.m1.at(-1)!.high;          // massimo dell'ultima M1 chiusa
  input.quote.bid = level + 0.05;               // dentro il buffer: nessun trigger
  input.quote.ask = input.quote.bid + 0.12;
  input.quote.mid = input.quote.bid + 0.06;
  rejected(input, /non oltre il livello M1/);
  input.quote.bid = level + 0.11;               // oltre il buffer: trigger valido
  input.quote.ask = input.quote.bid + 0.12;
  input.quote.mid = input.quote.bid + 0.06;
  assert.equal(evaluateScalper(input).direction, "BUY");
});
check("La candela M1 in formazione non entra in livelli, range, EMA o ATR", () => {
  const input = fixture();
  const base = evaluateScalper(input);
  assert.equal(base.direction, "BUY", JSON.stringify(base));
  // Candela ancora aperta, tutta sopra il livello: se venisse usata sposterebbe il trigger.
  const level = input.m1.at(-1)!.high;
  input.m1.push(bar(Date.UTC(2026, 8, 9, 10, 6), level + 5, level + 5.2, 0.1));
  const after = evaluateScalper(input);
  assert.equal(after.direction, base.direction, JSON.stringify(after));
  assert.equal(after.setupKey, base.setupKey);
  assert.equal(after.stopLoss, base.stopLoss);
  assert.equal(after.takeProfit, base.takeProfit);
});
check("M15 range blocks an otherwise bullish M1", () => {
  const input = fixture();
  input.m5 = input.m5.map(c => bar(Date.parse(c.datetime), 2200, 2200, 1));
  rejected(input, /M15 in range/);
});
// M15 senza trend confermato ma banda larga: in soft mode decide il bias M5.
// La minima di m5[110] scende sotto la minima del gruppo M15 precedente (rompe gli higher low M15)
// restando sopra la minima delle 20 candele M5 precedenti (la struttura M5 HH/HL regge).
function m15Transition(low: number) {
  const input = fixture();
  input.m5[110] = { ...input.m5[110], low };
  return input;
}
function withTrendMode(mode: string, test: () => void) {
  const previous = process.env.M15_TREND_MODE;
  process.env.M15_TREND_MODE = mode;
  try { test(); } finally {
    if (previous === undefined) delete process.env.M15_TREND_MODE; else process.env.M15_TREND_MODE = previous;
  }
}
check("M15 transition: M5 bias unlocks the entry in soft mode", () => {
  const s = evaluateScalper(m15Transition(2240));
  assert.equal(s.direction, "BUY", JSON.stringify(s));
  assert.equal(s.setup, "micro_pullback");
  const gate = s.evaluations.find(e => e.setup === "m15_gate");
  assert.ok(gate && gate.status === "triggered", JSON.stringify(s.evaluations));
  assert.match(gate!.reason, /M15 transizione, M5 bias BUY ok/);
  // Il motivo porta i numeri: struttura M5, prezzo, EMA20 M5 e banda M15.
  assert.match(gate!.reason, /max 2257\.20 vs 2244\.35/);
  assert.match(gate!.reason, /EMA20 M5 \d+\.\d\d/);
  assert.match(gate!.reason, /banda 12 M15 \d+\.\d\d\$ = \d+\.\d\d ATR15/);
  // SL/TP restano quelli del setup, la modifica riguarda solo il contesto.
  const base = evaluateScalper(fixture());
  assert.equal(s.entry, base.entry); assert.equal(s.stopLoss, base.stopLoss); assert.equal(s.takeProfit, base.takeProfit);
});
check("M15_TREND_MODE=strict keeps blocking the same transition", () => {
  withTrendMode("strict", () => rejected(m15Transition(2240), /M15 in range o transizione/));
});
check("M15 transition without M5 structure stays blocked", () => {
  rejected(m15Transition(2239.5), /bias M5 non direzionale/);
});
check("M15 opposite to M1 cannot buy", () => {
  const input = fixture(); input.m5 = mirror(input).m5;
  // Contesto SELL con prezzo sopra i massimi M1: il trigger short non scatta mai.
  rejected(input, /non oltre il livello M1/);
});
check("Missing recent M5 prevents synthetic M15 fabrication", () => {
  const input = fixture(); input.m5.splice(-5, 1);
  rejected(input, /incompleto/);
});
check("Daily XAUUSD pause does not block evaluation after 22:00 UTC reopen", () => {
  const input = withClosureGap(fixture(), Date.UTC(2026, 8, 9, 9, 30), Date.UTC(2026, 8, 9, 22, 0), 60 * MINUTE);
  input.m1 = input.m1.filter(c => Date.parse(c.datetime) !== Date.UTC(2026, 8, 9, 22, 0));
  input.m5 = input.m5.filter(c => Date.parse(c.datetime) !== Date.UTC(2026, 8, 9, 22, 0));
  withLiveSession(() => {
    const s = evaluateScalper(input);
    assert.doesNotMatch(s.reasoning + s.evaluations.map(e => e.reason).join(" "), /Storico recente M1\/M5\/M15 incompleto/);
  });
});
check("Monday reopen after weekend does not block evaluation", () => {
  const input = withClosureGap(fixture(), Date.UTC(2026, 8, 9, 9, 30), Date.UTC(2026, 8, 13, 22, 0), 49 * 60 * MINUTE);
  input.m1 = input.m1.filter(c => Date.parse(c.datetime) !== Date.UTC(2026, 8, 13, 22, 0));
  input.m5 = input.m5.filter(c => Date.parse(c.datetime) !== Date.UTC(2026, 8, 13, 22, 0));
  withLiveSession(() => {
    const s = evaluateScalper(input);
    assert.doesNotMatch(s.reasoning + s.evaluations.map(e => e.reason).join(" "), /Storico recente M1\/M5\/M15 incompleto/);
  });
});
check("Duplicate and malformed candles rejected", () => {
  const duplicate = fixture(); duplicate.m5.push(duplicate.m5.at(-1)!); rejected(duplicate, /non valide/);
  const malformed = fixture(); malformed.m1.at(-1)!.high = 1; rejected(malformed, /non valide/);
});
check("Shock candle blocked", () => {
  const input = fixture(); input.m1.at(-1)!.high += 20; rejected(input, /shock/);
});
check("Structural stop cannot be squeezed to pass max risk", () => {
  const input = fixture(); input.m5.at(-1)!.low -= 12; rejected(input, /SL o costi/);
});
check("Nearby resistance blocks inadequate reward", () => {
  const input = fixture();
  const c = input.m5[110]; c.high = input.quote.ask + 2; // confirmed historical pivot ahead of entry
  rejected(input, /Ostacolo/);
});
check("Excessive estimated commission blocks entry", () => {
  process.env.MTF_ROUNDTRIP_COMMISSION_PER_LOT_USD = "100";
  try { rejected(fixture(), /Ostacolo/); } finally { delete process.env.MTF_ROUNDTRIP_COMMISSION_PER_LOT_USD; }
});
check("Forming M5 changes never change M15 context", () => {
  const input = fixture(), baseline = evaluateScalper(input);
  input.m5.push(bar(Date.UTC(2026, 8, 9, 10, 5), input.quote.bid, input.quote.bid - 20));
  assert.deepEqual(evaluateScalper(input), baseline);
});
check("M15 aggregation includes only complete groups", () => {
  const input = fixture(), closed = closedBars(input.m5, 5, nowMs)!;
  const aggregated = aggregateM15(closed);
  assert.equal(aggregated.at(-1)!.datetime, "2026-09-09T09:45:00.000Z");
  const start = closed.findIndex(c => c.datetime === aggregated.at(-1)!.datetime);
  assert.equal(aggregated.at(-1)!.close, closed[start + 2].close);
  assert.equal(aggregateM15(closed.filter((_, i) => i !== start + 1)).length, aggregated.length - 1);
});
check("Planned SL/TP rechecked after entry drifts", () => {
  const input = fixture(), s = evaluateScalper(input);
  assert.equal(plannedEntryValid(s, input.quote), true);
  assert.equal(plannedEntryValid(s, { ...input.quote, ask: input.quote.ask + 2 }), false);
});
check("Rejected preflight does not consume a subsequently valid setup", () => {
  const input = fixture(), key = evaluateScalper(input).setupKey;
  rejected({ ...input, quote: { ...input.quote, ask: input.quote.ask + 3 } }, /Spread/);
  assert.equal(evaluateScalper(input).setupKey, key);
});
check("Timeout stays ambiguous; explicit invalid stops can release reservation", () => {
  assert.equal(definitelyRejected(new Error("timeout")), false);
  assert.equal(definitelyRejected({ numericCode: 10012 }), false);
  assert.equal(definitelyRejected({ numericCode: 10016 }), true);
});
check("Recovery matches exact clientId and symbol, including already-closed trades", () => {
  const position = { id: "p1", symbol: "XAUUSD", clientId: "ours", openPrice: 2200 };
  assert.equal(recoverOrder("ours", "XAUUSD", [position], [])?.positionId, "p1");
  assert.equal(recoverOrder("other", "XAUUSD", [position], []), null);
  assert.equal(recoverOrder("ours", "BTCUSD", [position], []), null);
  assert.equal(recoverOrder("ours", "XAUUSD", [], [{ clientId: "ours", symbol: "XAUUSD", positionId: "p1", entryType: "DEAL_ENTRY_IN" }])?.positionId, "p1");
});
check("Risk uses broker tick value rather than assuming EUR equals USD", () => {
  assert.equal(riskPerLot(3, 0.01, 0.92), 276);
  assert.equal(riskPerLot(3, 0, 0.92), null);
  assert.equal(riskPerLot(3, 0.01, NaN), null);
});
check("Pivot needs closed candles on both sides", () => {
  const bars = [bar(0, 10, 10), bar(MINUTE, 11, 11), bar(2 * MINUTE, 20, 20)];
  assert.equal(swingLevels(bars, "BUY").length, 0);
});
// --- m1_short: secondo setup, valutato solo quando la mtf non produce un ordine ---
// M5 piatte => contesto M15 in range vero => la mtf non entra mai in questi scenari.
// Il trigger e' il prezzo live: le candele costruiscono solo il range chiuso, la quote lo supera o no.
function shortInput(options: { drift?: number; flatBars?: number; breakout?: number; shock?: number } = {}) {
  const base = fixture();
  const end = Date.UTC(2026, 8, 9, 10, 5), total = 40;
  const drift = options.drift ?? 0, flatBars = options.flatBars ?? total, breakout = options.breakout ?? 0.5;
  const driftBars = total - flatBars;
  const m5 = base.m5.map(c => bar(Date.parse(c.datetime), 2200, 2200, 1));
  const m1: Candle[] = [];
  let level = 2200 - driftBars * drift;
  for (let i = 0; i < total; i++) {
    if (i < driftBars) level += drift;
    const up = i % 2 === 0;
    m1.push(bar(end - (total - 1 - i) * MINUTE, up ? level - 0.5 : level + 0.5, up ? level + 0.5 : level - 0.5, 0.2));
  }
  if (options.shock !== undefined) {
    const last = m1.at(-1)!;
    m1[m1.length - 1] = bar(Date.parse(last.datetime), last.open, last.open + options.shock, 0.2);
  }
  const window = m1.slice(-8);
  const high = Math.max(...window.map(c => c.high)), low = Math.min(...window.map(c => c.low));
  const bid = breakout >= 0 ? high + breakout : low + breakout;
  return { nowMs: base.nowMs, m1, m5, quote: { bid, ask: bid + 0.12, mid: bid + 0.06, spread: 0.12, quotedAt: base.nowMs } };
}
check("m1_short entra sulla rottura del range M1 quando la mtf non produce nulla", () => {
  withShort({}, () => {
    const input = shortInput();
    const s = evaluateScalper(input);
    assert.equal(s.direction, "BUY", JSON.stringify(s));
    assert.equal(s.setup, "m1_short");
    assert.ok(s.setupKey?.startsWith("m1-short-v1:BUY:"), s.setupKey ?? "");
    // Le due valutazioni convivono: contesto mtf scartato + m1_gate con i numeri.
    assert.deepEqual(s.evaluations.map(e => e.setup), ["filtri", "m1_gate"]);
    const gate = s.evaluations.at(-1)!;
    assert.equal(gate.status, "triggered");
    assert.match(gate.reason, /range 8 M1 chiuse \d+\.\d\d-\d+\.\d\d/);
    assert.match(gate.reason, /EMA20 M1 \d+\.\d\d/);
    assert.match(gate.reason, /ATR M1 \d+\.\d\d\$, SL \d+\.\d\d\$, TP \d+\.\d\d\$/);
    // SL = 2 x ATR con minimo 3$, TP = 0.6 x ATR con minimo 1.5$, indipendente dallo SL.
    const atrM1 = s.slPlan!.atr / 2;
    assert.ok(Math.abs(s.stopLoss! - (s.entry! - Math.max(2 * atrM1, 3))) <= 0.011, JSON.stringify(s.slPlan));
    assert.ok(Math.abs(s.takeProfit! - (s.entry! + Math.min(Math.max(0.6 * atrM1, 1.5), 3))) <= 0.011, JSON.stringify(s.slPlan));
    assert.ok(s.riskReward! < 1, "il TP e' piu' vicino dello SL per costruzione");
    assert.ok(plannedEntryValid(s, input.quote), "il piano deve restare valido al preflight finale");
  });
});
check("La mtf ha la precedenza sul m1_short", () => {
  withShort({}, () => {
    const s = evaluateScalper(fixture());
    assert.equal(s.direction, "BUY", JSON.stringify(s));
    assert.equal(s.setup, "micro_pullback");
    assert.ok(!s.evaluations.some(e => e.setup === "m1_gate"), "m1_short non viene valutato se la mtf entra");
  });
});
check("SHORT_ENABLED=false lascia solo la mtf", () => {
  const s = evaluateScalper(shortInput());
  assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
  assert.ok(!s.evaluations.some(e => e.setup === "m1_gate"));
});
check("m1_short: rottura contro l'EMA20 M1 scartata", () => {
  withShort({}, () => {
    // Serie in discesa: l'EMA20 resta sopra, il rimbalzo rompe il range ma non la direzione.
    const s = evaluateScalper(shortInput({ drift: 1, flatBars: 13, breakout: -0.5 }));
    assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
    const gate = s.evaluations.find(e => e.setup === "m1_gate");
    assert.match(gate!.reason, /contro l'EMA20 M1/);
  });
});
check("m1_short: SL oltre il massimo scarta il trade", () => {
  withShort({ SHORT_SL_ATR: "10" }, () => {
    const s = evaluateScalper(shortInput());
    assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
    const gate = s.evaluations.find(e => e.setup === "m1_gate");
    assert.match(gate!.reason, /oltre il massimo 8\.00\$/);
  });
});
check("m1_short: il TP resta dentro i limiti indipendentemente dallo SL", () => {
  withShort({ SHORT_TP_ATR: "5" }, () => {
    const s = evaluateScalper(shortInput());
    assert.equal(s.direction, "BUY", JSON.stringify(s));
    assert.ok(Math.abs(s.takeProfit! - (s.entry! + 3)) <= 0.011, JSON.stringify(s));
  });
  withShort({ SHORT_TP_ATR: "0.01", SHORT_TP_MIN_USD: "1.5" }, () => {
    const s = evaluateScalper(shortInput());
    assert.ok(Math.abs(s.takeProfit! - (s.entry! + 1.5)) <= 0.011, JSON.stringify(s));
  });
});
check("mtf: la chiave porta livello e M1 chiusa, un solo tentativo per livello", () => {
  const input = fixture();
  const first = evaluateScalper(input);
  assert.equal(first.direction, "BUY", JSON.stringify(first));
  const closed = input.m1.at(-1)!;
  assert.ok(first.setupKey!.includes(closed.datetime), first.setupKey ?? "");
  assert.ok(first.setupKey!.includes(closed.high.toFixed(2)), first.setupKey ?? "");
  // Altro tick sullo stesso livello: stessa chiave, quindi la prenotazione non riapre un secondo ordine.
  const later = { ...input, quote: { ...input.quote, bid: input.quote.bid + 0.2, ask: input.quote.ask + 0.2, mid: input.quote.mid + 0.2 } };
  assert.equal(evaluateScalper(later).setupKey, first.setupKey);
});
check("m1_short: un solo tentativo per livello, riarmato dalla nuova M1 chiusa", () => {
  withShort({}, () => {
    const input = shortInput();
    const first = evaluateScalper(input);
    assert.equal(first.setup, "m1_short", JSON.stringify(first));
    const closed = input.m1.at(-1)!;
    assert.ok(first.setupKey!.includes(closed.datetime), first.setupKey ?? "");
    // Prezzo ancora piu' su, stesso range e stessa M1 chiusa: chiave invariata.
    const higher = { ...input, quote: { ...input.quote, bid: input.quote.bid + 0.4, ask: input.quote.ask + 0.4, mid: input.quote.mid + 0.4 } };
    assert.equal(evaluateScalper(higher).setupKey, first.setupKey);
    // Nuova M1 chiusa dentro il range: stesso livello ma setup riarmato, chiave diversa.
    const next = { ...input, nowMs: input.nowMs + MINUTE, m1: [...input.m1], quote: { ...input.quote, quotedAt: input.nowMs + MINUTE } };
    next.m1.push(bar(Date.parse(closed.datetime) + MINUTE, closed.open, closed.close, 0.2));
    const after = evaluateScalper(next);
    assert.equal(after.setup, "m1_short", JSON.stringify(after));
    assert.notEqual(after.setupKey, first.setupKey);
  });
});
check("m1_short: chiusura dentro il range non entra", () => {
  withShort({}, () => {
    // Dentro il buffer: il livello e' toccato ma non superato di ENTRY_BUFFER_USD.
    const s = evaluateScalper(shortInput({ breakout: 0.05 }));
    assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
    assert.match(s.evaluations.find(e => e.setup === "m1_gate")!.reason, /dentro il range/);
  });
});
check("m1_short: candela shock esclusa come nella mtf", () => {
  withShort({}, () => {
    const s = evaluateScalper(shortInput({ shock: 12 }));
    assert.equal(s.direction, "NO_TRADE", JSON.stringify(s));
    assert.match(s.evaluations.find(e => e.setup === "m1_gate")!.reason, /shock/);
  });
});
console.log(passed + " scenari superati.");

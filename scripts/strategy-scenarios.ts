// Deterministic, offline scenarios: no broker, database or wall-clock dependency.
import assert from "node:assert/strict";
import { evaluateScalper, plannedEntryValid } from "../src/lib/server/scalperStrategy";
import { definitelyRejected, recoverOrder, riskPerLot } from "../src/lib/server/orderSafety";
import { aggregateM15, closedBars, MINUTE, swingLevels } from "../src/lib/server/marketStructure";
import type { Candle } from "../src/lib/types";

// Isolate test configuration from deployment/local env.
for (const key of Object.keys(process.env)) {
  if (/^(MTF_|SCALPER_|SL_|SHOCK_|M15_)/.test(key)) delete process.env[key];
}
process.env.SCALPER_HOURS_UTC = "00:00-23:59";
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
  const bid = base + 3.72;
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
  rejected(input, /Conferma M1 persa/);
});
check("Unclosed M1 cannot supply an entry", () => {
  const input = fixture(); input.nowMs -= MINUTE; input.quote.quotedAt = input.nowMs;
  rejected(input, /attendo chiusura M1/);
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
  rejected(input, /attendo chiusura M1/);
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
console.log(passed + " scenari superati.");

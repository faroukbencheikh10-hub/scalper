import assert from "node:assert/strict";
import {
  classifyM15PaperRegime,
  evaluateRangeContextPaper,
  evaluateShortContextPaper,
  type M15PaperInput,
} from "../src/lib/server/m15TransitionPaper";

let passed = 0;
const run = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log("ok - " + name);
};

const base = (patch: Partial<M15PaperInput> = {}): M15PaperInput => ({
  biasM5: "up",
  structure: "unclear",
  m15BandAtr: 3.14,
  maxBandAtr: 3,
  priceInsideRangeBand: true,
  breakoutRecent: false,
  ...patch,
});

run("wide unclear M15 is transition, not range", () => {
  assert.equal(classifyM15PaperRegime(base()), "transition");
});

run("compressed unclear M15 with price inside is true range", () => {
  assert.equal(classifyM15PaperRegime(base({ m15BandAtr: 2.4 })), "true_range");
});

run("compressed band with price outside is transition", () => {
  assert.equal(classifyM15PaperRegime(base({ m15BandAtr: 2.4, priceInsideRangeBand: false })), "transition");
});

run("confirmed up structure remains trend_up outside a compressed range", () => {
  assert.equal(classifyM15PaperRegime(base({ structure: "trend_up", m15BandAtr: 3.5 })), "trend_up");
});

run("compressed range has priority over apparent trend structure while price stays inside", () => {
  assert.equal(classifyM15PaperRegime(base({ structure: "trend_up", m15BandAtr: 2.4 })), "true_range");
});

run("compressed range with apparent trend still blocks m1_short", () => {
  const d = evaluateShortContextPaper(base({ structure: "trend_up", m15BandAtr: 2.4, biasM5: "up" }));
  assert.equal(d.regime, "true_range");
  assert.equal(d.allowed, null);
});

run("M5 up + M15 transition allows BUY paper setup", () => {
  const d = evaluateShortContextPaper(base({ biasM5: "up" }));
  assert.equal(d.regime, "transition");
  assert.equal(d.allowed, "BUY");
});

run("M5 down + M15 transition allows SELL paper setup", () => {
  const d = evaluateShortContextPaper(base({ biasM5: "down" }));
  assert.equal(d.allowed, "SELL");
});

run("true M15 range still blocks directional setup", () => {
  const d = evaluateShortContextPaper(base({ m15BandAtr: 2.4 }));
  assert.equal(d.regime, "true_range");
  assert.equal(d.allowed, null);
});

run("opposite confirmed M15 trend still blocks", () => {
  const d = evaluateShortContextPaper(base({ biasM5: "up", structure: "trend_down" }));
  assert.equal(d.allowed, null);
});

run("flat M5 still blocks m1_short", () => {
  const d = evaluateShortContextPaper(base({ biasM5: "flat" }));
  assert.equal(d.allowed, null);
});

run("recent M15 breakout keeps anti-chase protection", () => {
  const d = evaluateShortContextPaper(base({ breakoutRecent: true }));
  assert.equal(d.allowed, null);
});

run("invalid M15 metrics fail closed for m1_short", () => {
  const d = evaluateShortContextPaper(base({ m15BandAtr: Number.NaN }));
  assert.equal(d.regime, "invalid");
  assert.equal(d.allowed, null);
});

run("invalid maxBandAtr fails closed for m1_range", () => {
  const d = evaluateRangeContextPaper(base({ biasM5: "flat", maxBandAtr: 0 }));
  assert.equal(d.regime, "invalid");
  assert.notEqual(d.reason, "m1_range context ok");
});

run("m1_range accepts only true range with flat M5", () => {
  const d = evaluateRangeContextPaper(base({ biasM5: "flat", m15BandAtr: 2.4 }));
  assert.equal(d.regime, "true_range");
  assert.equal(d.reason, "m1_range context ok");
});

run("m1_range rejects transition even with flat M5", () => {
  const d = evaluateRangeContextPaper(base({ biasM5: "flat", m15BandAtr: 3.14 }));
  assert.equal(d.regime, "transition");
  assert.notEqual(d.reason, "m1_range context ok");
});

console.log(`m15-transition paper scenarios: ${passed}/16 passed`);

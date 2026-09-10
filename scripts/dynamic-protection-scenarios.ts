// Deterministic paper/backtest scenarios for dynamic SL/TP and early profit protection.
// No MetaApi calls, broker orders or database writes happen in this file.
import assert from "node:assert/strict";
import {
  dynamicDistances,
  dynamicProfitProtection,
  initialDynamicLevels,
} from "../src/lib/server/dynamicProtection";

let passed = 0;
function check(name: string, test: () => void) {
  test();
  passed += 1;
  console.log("OK " + name);
}

check("dynamic: SL/TP respond to ATR and spread", () => {
  const calm = dynamicDistances(1.0, 0.1);
  const fast = dynamicDistances(3.0, 0.4);
  assert.ok(fast.slDistanceUsd > calm.slDistanceUsd);
  assert.ok(fast.tpDistanceUsd > calm.tpDistanceUsd);
  assert.ok(calm.slDistanceUsd >= 3);
  assert.ok(calm.tpDistanceUsd >= 1.5);
});

check("dynamic: BUY starts with broker-style SL below and TP above entry", () => {
  const levels = initialDynamicLevels({ direction: "BUY", entry: 4400, atrM1: 2, spreadUsd: 0.2 });
  assert.ok(levels.stopLoss < 4400);
  assert.ok(levels.takeProfit > 4400);
});

check("dynamic: below +2 EUR the SL does not move", () => {
  const action = dynamicProfitProtection({
    direction: "BUY",
    entry: 4400,
    currentPrice: 4400.8,
    currentStopLoss: 4396,
    profitEur: 1.99,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  assert.equal(action.kind, "hold");
  assert.equal(action.stopLoss, 4396);
});

check("dynamic: at +2 EUR SL moves immediately to breakeven", () => {
  const action = dynamicProfitProtection({
    direction: "BUY",
    entry: 4400,
    currentPrice: 4401,
    currentStopLoss: 4396,
    profitEur: 2,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  assert.equal(action.kind, "protect");
  assert.equal(action.stopLoss, 4400);
});

check("dynamic: at +3 EUR trailing starts and never loosens SL", () => {
  const first = dynamicProfitProtection({
    direction: "BUY",
    entry: 4400,
    currentPrice: 4402,
    currentStopLoss: 4400,
    profitEur: 3,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  assert.equal(first.kind, "trail");
  assert.ok(first.stopLoss > 4400);

  const pullback = dynamicProfitProtection({
    direction: "BUY",
    entry: 4400,
    currentPrice: 4401.5,
    currentStopLoss: first.stopLoss,
    profitEur: 3.2,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  assert.equal(pullback.kind, "trail");
  assert.equal(pullback.stopLoss, first.stopLoss);
});

check("dynamic: SELL mirrors BUY protection", () => {
  const protect = dynamicProfitProtection({
    direction: "SELL",
    entry: 4400,
    currentPrice: 4399,
    currentStopLoss: 4404,
    profitEur: 2,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  assert.equal(protect.kind, "protect");
  assert.equal(protect.stopLoss, 4400);

  const trail = dynamicProfitProtection({
    direction: "SELL",
    entry: 4400,
    currentPrice: 4398,
    currentStopLoss: 4400,
    profitEur: 3,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  assert.equal(trail.kind, "trail");
  assert.ok(trail.stopLoss < 4400);
});

console.log(`dynamic-protection scenarios: ${passed}/6 passed`);

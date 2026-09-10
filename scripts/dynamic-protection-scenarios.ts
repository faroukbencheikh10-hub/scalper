// Deterministic paper/backtest scenarios for code-calculated SL/TP and immediate dynamic SL.
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

check("dynamic: SL/TP are calculated from ATR and spread", () => {
  const calm = dynamicDistances(1.0, 0.1);
  const fast = dynamicDistances(3.0, 0.4);
  assert.ok(fast.slDistanceUsd > calm.slDistanceUsd);
  assert.ok(fast.tpDistanceUsd > calm.tpDistanceUsd);
});

check("dynamic: BUY starts with calculated SL below and TP above entry", () => {
  const levels = initialDynamicLevels({ direction: "BUY", entry: 4400, atrM1: 2, spreadUsd: 0.2 });
  assert.ok(levels.stopLoss < 4400);
  assert.ok(levels.takeProfit > 4400);
});

check("dynamic: SL tightens immediately without +2/+3 EUR trigger", () => {
  const levels = initialDynamicLevels({ direction: "BUY", entry: 4400, atrM1: 2, spreadUsd: 0.2 });
  const action = dynamicProfitProtection({
    direction: "BUY",
    entry: 4400,
    currentPrice: 4400.2,
    currentStopLoss: levels.stopLoss,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  assert.equal(action.kind, "trail");
  assert.ok(action.stopLoss > levels.stopLoss);
});

check("dynamic: stronger favourable move keeps tightening SL", () => {
  const first = dynamicProfitProtection({
    direction: "BUY",
    entry: 4400,
    currentPrice: 4400.2,
    currentStopLoss: 4397,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  const second = dynamicProfitProtection({
    direction: "BUY",
    entry: 4400,
    currentPrice: 4401.5,
    currentStopLoss: first.stopLoss,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  assert.ok(second.stopLoss > first.stopLoss);
});

check("dynamic: pullback never loosens an already tightened BUY SL", () => {
  const first = dynamicProfitProtection({
    direction: "BUY",
    entry: 4400,
    currentPrice: 4402,
    currentStopLoss: 4397,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  const pullback = dynamicProfitProtection({
    direction: "BUY",
    entry: 4400,
    currentPrice: 4401,
    currentStopLoss: first.stopLoss,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  assert.equal(pullback.stopLoss, first.stopLoss);
});

check("dynamic: SELL mirrors BUY and SL only moves downward", () => {
  const levels = initialDynamicLevels({ direction: "SELL", entry: 4400, atrM1: 2, spreadUsd: 0.2 });
  const first = dynamicProfitProtection({
    direction: "SELL",
    entry: 4400,
    currentPrice: 4399.8,
    currentStopLoss: levels.stopLoss,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  const second = dynamicProfitProtection({
    direction: "SELL",
    entry: 4400,
    currentPrice: 4398.5,
    currentStopLoss: first.stopLoss,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  assert.ok(first.stopLoss < levels.stopLoss);
  assert.ok(second.stopLoss < first.stopLoss);
});

console.log(`dynamic-protection scenarios: ${passed}/6 passed`);

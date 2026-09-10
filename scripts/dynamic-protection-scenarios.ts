// Deterministic paper/backtest scenarios for code-calculated SL/TP and immediate dynamic SL.
// No MetaApi calls, broker orders or database writes happen in this file.
import assert from "node:assert/strict";
import {
  adaptiveMinImprovementUsd,
  dynamicDistances,
  dynamicProfitProtection,
  initialDynamicLevels,
  normalizeLevelToTick,
  type DynamicProtectionConfig,
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
  assert.equal(calm.valid, true);
  assert.equal(fast.valid, true);
  assert.ok(fast.requiredSlDistanceUsd! > calm.requiredSlDistanceUsd!);
  assert.ok(fast.tpDistanceUsd! > calm.tpDistanceUsd!);
});

check("dynamic: BUY starts with calculated SL below and TP above entry", () => {
  const levels = initialDynamicLevels({ direction: "BUY", entry: 4400, atrM1: 2, spreadUsd: 0.2 });
  assert.equal(levels.valid, true);
  assert.ok(levels.stopLoss !== null && levels.stopLoss < 4400);
  assert.ok(levels.takeProfit !== null && levels.takeProfit > 4400);
});

check("dynamic: TP is code-calculated from ATR M1 + spread", () => {
  const calm = initialDynamicLevels({ direction: "BUY", entry: 4400, atrM1: 1, spreadUsd: 0.1 });
  const fast = initialDynamicLevels({ direction: "BUY", entry: 4400, atrM1: 3, spreadUsd: 0.4 });
  assert.equal(calm.valid, true);
  assert.equal(fast.valid, true);
  assert.ok(fast.tpDistanceUsd! > calm.tpDistanceUsd!);
});

check("dynamic: market structure can widen the initial SL", () => {
  const base = initialDynamicLevels({ direction: "BUY", entry: 4400, atrM1: 1, spreadUsd: 0.1 });
  const structural = initialDynamicLevels({
    direction: "BUY",
    entry: 4400,
    atrM1: 1,
    spreadUsd: 0.1,
    structuralDistanceUsd: 5,
  });
  assert.equal(base.valid, true);
  assert.equal(structural.valid, true);
  assert.ok(structural.slDistanceUsd! > base.slDistanceUsd!);
  assert.equal(structural.stopLoss, 4395);
});

check("dynamic: oversized required SL rejects setup instead of tightening it", () => {
  const levels = initialDynamicLevels({
    direction: "BUY",
    entry: 4400,
    atrM1: 2,
    spreadUsd: 0.2,
    structuralDistanceUsd: 9,
  });
  assert.equal(levels.valid, false);
  assert.equal(levels.rejectReason, "sl_distance_above_max");
  assert.equal(levels.stopLoss, null);
  assert.equal(levels.takeProfit, null);
});

check("dynamic: invalid ATR fails closed", () => {
  const levels = initialDynamicLevels({ direction: "BUY", entry: 4400, atrM1: Number.NaN, spreadUsd: 0.2 });
  assert.equal(levels.valid, false);
  assert.equal(levels.rejectReason, "invalid_market_data");
  assert.equal(levels.stopLoss, null);
  assert.equal(levels.takeProfit, null);
});

check("dynamic: invalid spread fails closed", () => {
  const levels = initialDynamicLevels({ direction: "BUY", entry: 4400, atrM1: 2, spreadUsd: -0.1 });
  assert.equal(levels.valid, false);
  assert.equal(levels.rejectReason, "invalid_market_data");
});

check("dynamic: incoherent config fails closed", () => {
  const bad: DynamicProtectionConfig = {
    slAtrMult: 1.3,
    slMinUsd: 9,
    slMaxUsd: 8,
    tpAtrMult: 0.8,
    tpMinUsd: 1.5,
    tpMaxUsd: 4,
    spreadMult: 3,
    trailAtrMult: 0.35,
    trailMinUsd: 0.3,
    trailMaxUsd: 1.2,
  };
  const levels = initialDynamicLevels({ direction: "BUY", entry: 4400, atrM1: 2, spreadUsd: 0.2, config: bad });
  assert.equal(levels.valid, false);
  assert.equal(levels.rejectReason, "invalid_config");
});

check("dynamic: broker minimum distance is respected at entry", () => {
  const levels = initialDynamicLevels({
    direction: "BUY",
    entry: 4400,
    atrM1: 1,
    spreadUsd: 0.1,
    brokerMinDistanceUsd: 2,
  });
  assert.equal(levels.valid, true);
  assert.ok(levels.tpDistanceUsd! >= 2);
  assert.ok(levels.slDistanceUsd! >= 2);
});

check("dynamic: tick normalization rounds levels away from entry", () => {
  const levels = initialDynamicLevels({
    direction: "BUY",
    entry: 4400,
    atrM1: 2.03,
    spreadUsd: 0.1,
    tickSizeUsd: 0.05,
  });
  assert.equal(levels.valid, true);
  assert.ok(levels.takeProfit! >= 4401.624);
  assert.ok(Math.abs(levels.takeProfit! / 0.05 - Math.round(levels.takeProfit! / 0.05)) < 1e-8);
  assert.ok(Math.abs(levels.stopLoss! / 0.05 - Math.round(levels.stopLoss! / 0.05)) < 1e-8);
});

check("dynamic: explicit tick normalizer preserves safe side for SELL", () => {
  const sl = normalizeLevelToTick({ direction: "SELL", kind: "stopLoss", value: 4403.011, tickSizeUsd: 0.05 });
  const tp = normalizeLevelToTick({ direction: "SELL", kind: "takeProfit", value: 4398.489, tickSizeUsd: 0.05 });
  assert.equal(sl, 4403.05);
  assert.equal(tp, 4398.45);
});

check("dynamic: adaptive minimum improvement uses tick spread and floor", () => {
  assert.equal(adaptiveMinImprovementUsd({ spreadUsd: 0.4, tickSizeUsd: 0.01 }), 0.1);
  assert.equal(adaptiveMinImprovementUsd({ spreadUsd: 0.04, tickSizeUsd: 0.01 }), 0.05);
  assert.equal(adaptiveMinImprovementUsd({ spreadUsd: 0.04, tickSizeUsd: 0.1 }), 0.1);
});

check("dynamic: SL tightens immediately without +2/+3 EUR trigger", () => {
  const levels = initialDynamicLevels({ direction: "BUY", entry: 4400, atrM1: 2, spreadUsd: 0.2 });
  assert.equal(levels.valid, true);
  assert.ok(levels.stopLoss !== null);
  const action = dynamicProfitProtection({
    direction: "BUY",
    entry: 4400,
    currentPrice: 4400.2,
    currentStopLoss: levels.stopLoss!,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  assert.equal(action.kind, "trail");
  assert.ok(action.stopLoss > levels.stopLoss!);
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
  assert.equal(first.kind, "trail");
  const second = dynamicProfitProtection({
    direction: "BUY",
    entry: 4400,
    currentPrice: 4401.5,
    currentStopLoss: first.stopLoss,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  assert.equal(second.kind, "trail");
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
  assert.equal(first.kind, "trail");
  const pullback = dynamicProfitProtection({
    direction: "BUY",
    entry: 4400,
    currentPrice: 4401,
    currentStopLoss: first.stopLoss,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  assert.equal(pullback.kind, "hold");
  assert.equal(pullback.stopLoss, first.stopLoss);
});

check("dynamic: adaptive threshold suppresses micro updates", () => {
  const action = dynamicProfitProtection({
    direction: "BUY",
    entry: 4400,
    currentPrice: 4400.83,
    currentStopLoss: 4400.1,
    atrM1: 2,
    spreadUsd: 0.4,
    tickSizeUsd: 0.01,
  });
  assert.equal(action.kind, "hold");
  assert.equal(action.stopLoss, 4400.1);
  assert.equal(action.minImprovementUsd, 0.1);
});

check("dynamic: rate limit holds repeated update inside interval", () => {
  const action = dynamicProfitProtection({
    direction: "BUY",
    entry: 4400,
    currentPrice: 4402,
    currentStopLoss: 4400,
    atrM1: 2,
    spreadUsd: 0.2,
    nowMs: 10_200,
    lastUpdateAtMs: 10_000,
    minUpdateIntervalMs: 350,
  });
  assert.equal(action.kind, "hold");
  assert.equal(action.reason, "rate_limited");
  assert.equal(action.stopLoss, 4400);
});

check("dynamic: update is allowed after rate-limit interval", () => {
  const action = dynamicProfitProtection({
    direction: "BUY",
    entry: 4400,
    currentPrice: 4402,
    currentStopLoss: 4400,
    atrM1: 2,
    spreadUsd: 0.2,
    nowMs: 10_400,
    lastUpdateAtMs: 10_000,
    minUpdateIntervalMs: 350,
  });
  assert.equal(action.kind, "trail");
  assert.ok(action.stopLoss > 4400);
});

check("dynamic: broker minimum distance is respected during trailing", () => {
  const action = dynamicProfitProtection({
    direction: "BUY",
    entry: 4400,
    currentPrice: 4402,
    currentStopLoss: 4399,
    atrM1: 1,
    spreadUsd: 0.1,
    brokerMinDistanceUsd: 1,
    tickSizeUsd: 0.05,
  });
  assert.equal(action.kind, "trail");
  assert.ok(4402 - action.stopLoss >= 1 - 1e-9);
});

check("dynamic: TP is fixed after entry while only SL moves", () => {
  const levels = initialDynamicLevels({ direction: "BUY", entry: 4400, atrM1: 2, spreadUsd: 0.2 });
  assert.equal(levels.valid, true);
  assert.ok(levels.stopLoss !== null && levels.takeProfit !== null);
  const initialTp = levels.takeProfit!;
  const action = dynamicProfitProtection({
    direction: "BUY",
    entry: 4400,
    currentPrice: 4402,
    currentStopLoss: levels.stopLoss!,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  assert.equal(action.kind, "trail");
  assert.ok(action.stopLoss > levels.stopLoss!);
  assert.equal(levels.takeProfit, initialTp);
  assert.equal("takeProfit" in action, false);
});

check("dynamic: SELL mirrors BUY and SL only moves downward", () => {
  const levels = initialDynamicLevels({ direction: "SELL", entry: 4400, atrM1: 2, spreadUsd: 0.2 });
  assert.equal(levels.valid, true);
  assert.ok(levels.stopLoss !== null);
  const first = dynamicProfitProtection({
    direction: "SELL",
    entry: 4400,
    currentPrice: 4399.8,
    currentStopLoss: levels.stopLoss!,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  assert.equal(first.kind, "trail");
  const second = dynamicProfitProtection({
    direction: "SELL",
    entry: 4400,
    currentPrice: 4398.5,
    currentStopLoss: first.stopLoss,
    atrM1: 2,
    spreadUsd: 0.2,
  });
  assert.equal(second.kind, "trail");
  assert.ok(first.stopLoss < levels.stopLoss!);
  assert.ok(second.stopLoss < first.stopLoss);
});

console.log(`dynamic-protection scenarios: ${passed}/21 passed`);

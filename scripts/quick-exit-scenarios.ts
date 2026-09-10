// Deterministic paper/backtest scenarios for EXIT_MODE=quick.
// No MetaApi calls, broker orders or database writes happen in this file.
import assert from "node:assert/strict";
import {
  emergencySlUsd,
  isInvalidStopsError,
  openQuickExit,
  quickOrderStops,
  quickReEntrySec,
  quickTakeProfit,
  quickTickDecision,
  quickTpUsd,
  reEntryBlocked,
} from "../src/lib/server/quickExit";
import type { Quote } from "../src/lib/types";

for (const key of ["EXIT_MODE", "TP_QUICK_USD", "EMERGENCY_SL_USD", "RE_ENTRY_SEC"]) {
  delete process.env[key];
}

const quote = (bid: number, ask = bid + 0.1): Quote => ({
  bid,
  ask,
  mid: Number(((bid + ask) / 2).toFixed(2)),
  spread: Number((ask - bid).toFixed(2)),
  quotedAt: Date.UTC(2026, 8, 10, 12, 0, 0),
});

let passed = 0;
function check(name: string, test: () => void) {
  try {
    test();
    passed += 1;
    console.log("OK " + name);
  } catch (error) {
    console.error("FAIL " + name);
    throw error;
  }
}

check("quick: tp_quick su tick a +1.5 USD", () => {
  const state = openQuickExit({
    positionId: "paper-1",
    signalId: "signal-1",
    setup: "mtf",
    direction: "BUY",
    openPrice: 4400,
    tpBroker: 4401.5,
  });
  assert.equal(quickTickDecision(state, quote(4401.49), quickTpUsd(), emergencySlUsd()), null);
  assert.equal(quickTickDecision(state, quote(4401.5), quickTpUsd(), emergencySlUsd()), "tp_quick");
});

check("quick: emergency su tick a -15 USD", () => {
  const state = openQuickExit({
    positionId: "paper-2",
    signalId: "signal-2",
    setup: "m1_short",
    direction: "BUY",
    openPrice: 4400,
    tpBroker: 4401.5,
  });
  assert.equal(quickTickDecision(state, quote(4385.01), quickTpUsd(), emergencySlUsd()), null);
  assert.equal(quickTickDecision(state, quote(4385), quickTpUsd(), emergencySlUsd()), "emergency");
});

check("quick: oscillazione tra -10 e +1 USD senza chiusura", () => {
  const state = openQuickExit({
    positionId: "paper-3",
    signalId: "signal-3",
    setup: "m1_range",
    direction: "BUY",
    openPrice: 4400,
    tpBroker: 4401.5,
  });
  for (const price of [4390, 4395, 4400.25, 4401, 4392.5, 4400.8]) {
    assert.equal(quickTickDecision(state, quote(price), quickTpUsd(), emergencySlUsd()), null);
  }
});

check("quick: re-entry bloccata per 30 secondi dopo tp_quick", () => {
  const closedAt = Date.UTC(2026, 8, 10, 12, 0, 0);
  assert.equal(quickReEntrySec(), 30);
  assert.equal(reEntryBlocked(closedAt, closedAt + 29_999, quickReEntrySec()), true);
  assert.equal(reEntryBlocked(closedAt, closedAt + 30_000, quickReEntrySec()), false);
});

check("quick: TP broker rifiutato -> paper open senza TP, worker chiude a +1.5 USD", () => {
  assert.equal(isInvalidStopsError({ numericCode: 10016, stringCode: "TRADE_RETCODE_INVALID_STOPS" }), true);
  const fallbackStops = quickOrderStops("SELL", 4400, quickTpUsd(), true);
  assert.equal(fallbackStops.stopLoss, undefined);
  assert.equal(fallbackStops.takeProfit, undefined);

  const state = openQuickExit({
    positionId: "paper-4",
    signalId: "signal-4",
    setup: "mtf",
    direction: "SELL",
    openPrice: 4400,
    tpBroker: null,
    tpRejected: true,
  });
  // Per SELL la decisione usa Ask: 4398.50 e' esattamente +1.50 USD a favore dal fill 4400.
  assert.equal(quickTickDecision(state, quote(4398.4, 4398.5), quickTpUsd(), emergencySlUsd()), "tp_quick");
  assert.equal(quickTakeProfit("SELL", 4400, quickTpUsd()), 4398.5);
});

console.log(`quick-exit scenarios: ${passed}/5 passed`);

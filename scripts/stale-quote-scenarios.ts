import assert from "node:assert/strict";
import { staleQuoteDecision } from "../src/lib/server/staleQuoteGuard";

let passed = 0;
function check(name: string, test: () => void) {
  try { test(); passed += 1; console.log("OK " + name); }
  catch (error) { console.error("FAIL " + name); throw error; }
}

const start = Date.UTC(2026, 8, 10, 6, 30, 0);
const decide = (seconds: number, overrides: Partial<Parameters<typeof staleQuoteDecision>[0]> = {}) =>
  staleQuoteDecision({
    active: true,
    nowMs: start + seconds * 1000,
    lastQuoteReceivedAtMs: start,
    sessionStartAtMs: start,
    fallbackStartAtMs: start,
    staleQuoteSec: 120,
    staleQuoteExitSec: 300,
    ...overrides,
  });

check("quote ferma -> reconnect -> exit", () => {
  assert.equal(decide(120).action, "idle");
  assert.deepEqual(decide(121), { action: "reconnect", quoteAgeSec: 121 });
  assert.equal(decide(299).action, "reconnect");
  assert.deepEqual(decide(301), { action: "exit", quoteAgeSec: 301 });
});
check("nuova quote azzera il silenzio", () => {
  assert.deepEqual(decide(301, { lastQuoteReceivedAtMs: start + 250_000 }), { action: "idle", quoteAgeSec: 51 });
});
check("fuori fascia nessuna azione", () => {
  assert.deepEqual(decide(900, { active: false }), { action: "idle", quoteAgeSec: null });
});
check("riapertura non eredita silenzio overnight", () => {
  const oldQuote = start - 10 * 60 * 60_000;
  assert.equal(decide(120, { lastQuoteReceivedAtMs: oldQuote }).action, "idle");
  assert.equal(decide(121, { lastQuoteReceivedAtMs: oldQuote }).action, "reconnect");
});
console.log(`Stale quote scenarios passed: ${passed}`);

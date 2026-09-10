// Deterministic scenarios: SCALPER_HOURS_UTC non deve piu' gating l'operativita'. Solo weekend
// (chiusura di calendario) e la finestra di flatten restano blocchi reali, sia nel preflight
// condiviso di evaluateScalper (la stessa logica di sessionGuard in worker/streaming.ts) sia nel
// badge di stato della dashboard (currentOperationalState).
import assert from "node:assert/strict";
import { getSessionStatus, sessionAllowsEntry, sessionConfigFromEnv } from "../src/lib/session";
import { evaluateScalper } from "../src/lib/server/scalperStrategy";
import { currentOperationalState } from "../src/lib/operationalState";
import { MINUTE } from "../src/lib/server/marketStructure";
import type { Candle } from "../src/lib/types";

for (const key of Object.keys(process.env)) {
  if (/^(MTF_|SCALPER_|SL_|SHOCK_|M15_|SHORT_|RANGE_|TP_)/.test(key)) delete process.env[key];
}

let passed = 0;
function check(name: string, test: () => void) {
  try { test(); passed++; console.log("OK " + name); }
  catch (error) { console.error("FAIL " + name); throw error; }
}
function withHours(hoursUtc: string, test: () => void) {
  const previous = process.env.SCALPER_HOURS_UTC;
  process.env.SCALPER_HOURS_UTC = hoursUtc;
  try { test(); } finally {
    if (previous === undefined) delete process.env.SCALPER_HOURS_UTC; else process.env.SCALPER_HOURS_UTC = previous;
  }
}

const wednesday10h = Date.UTC(2026, 8, 9, 10, 6, 1); // mercoledi': nessuna chiusura di calendario
const saturday = Date.UTC(2026, 8, 12, 15, 0, 0); // weekend reale

function quoteAt(ms: number) {
  return { bid: 2200, ask: 2200.12, mid: 2200.06, spread: 0.12, quotedAt: ms };
}
function bar(ms: number, price: number): Candle {
  return { datetime: new Date(ms).toISOString(), open: price, close: price, high: price + 0.3, low: price - 0.3 };
}
// Candele volutamente minime: il preflight comune valuta la sessione prima di leggerne il contenuto,
// quindi bastano a raggiungere (o superare) il gate senza dover costruire uno storico di mercato valido.
function candlesEndingAt(ms: number) {
  const m5 = Array.from({ length: 5 }, (_, i) => bar(ms - (5 - i) * 5 * MINUTE, 2200 + i));
  const m1 = Array.from({ length: 5 }, (_, i) => bar(ms - (5 - i) * MINUTE, 2200 + i));
  return { m1, m5 };
}

check("getSessionStatus: fuori SCALPER_HOURS_UTC non genera piu' blockReason", () => {
  withHours("12:00-13:00", () => {
    const status = getSessionStatus(new Date(wednesday10h), sessionConfigFromEnv());
    assert.equal(status.inside, false);
    assert.equal(status.weekendClosed, false);
    assert.equal(status.inFlattenWindow, false);
    assert.equal(status.blockReason, null);
  });
});

check("sessionAllowsEntry: true fuori fascia oraria (solo weekend/flatten bloccano)", () => {
  withHours("12:00-13:00", () => {
    assert.equal(sessionAllowsEntry(new Date(wednesday10h), sessionConfigFromEnv()), true);
  });
});

check("evaluateScalper: nessun rifiuto per sola ora del giorno fuori SCALPER_HOURS_UTC", () => {
  withHours("12:00-13:00", () => {
    const { m1, m5 } = candlesEndingAt(wednesday10h);
    const s = evaluateScalper({ quote: quoteAt(wednesday10h), m1, m5, nowMs: wednesday10h });
    const text = s.reasoning + s.evaluations.map((e) => e.reason).join(" ");
    assert.doesNotMatch(text, /Fuori fascia|Fuori sessione/);
  });
});

check("evaluateScalper: weekend chiuso blocca ancora (weekendClosed)", () => {
  withHours("00:00-23:59", () => {
    const status = getSessionStatus(new Date(saturday), sessionConfigFromEnv());
    assert.equal(status.weekendClosed, true);
    const { m1, m5 } = candlesEndingAt(saturday);
    const s = evaluateScalper({ quote: quoteAt(saturday), m1, m5, nowMs: saturday });
    assert.equal(s.direction, "NO_TRADE");
    assert.match(s.reasoning, /weekend/i);
  });
});

check("evaluateScalper: finestra di flatten blocca ancora (inFlattenWindow)", () => {
  // Fascia che termina alle 10:10 UTC: con flattenBeforeEndMin=5 il flatten scatta dalle 10:05.
  withHours("09:00-10:10", () => {
    const status = getSessionStatus(new Date(wednesday10h), sessionConfigFromEnv());
    assert.equal(status.inFlattenWindow, true);
    assert.equal(status.weekendClosed, false);
    const { m1, m5 } = candlesEndingAt(wednesday10h);
    const s = evaluateScalper({ quote: quoteAt(wednesday10h), m1, m5, nowMs: wednesday10h });
    assert.equal(s.direction, "NO_TRADE");
    assert.match(s.reasoning, /Chiusura sessione/);
  });
});

check("currentOperationalState: mai WAITING per sola ora del giorno", () => {
  const state = currentOperationalState({
    systemStopped: false,
    session: { weekendClosed: false, inFlattenWindow: false },
    stream: { heartbeat: new Date(wednesday10h).toISOString() },
  }, wednesday10h + 1000);
  assert.equal(state, "LIVE");
});

check("currentOperationalState: WAITING per weekend", () => {
  const state = currentOperationalState({
    systemStopped: false,
    session: { weekendClosed: true, inFlattenWindow: false },
    stream: { heartbeat: new Date(saturday).toISOString() },
  }, saturday + 1000);
  assert.equal(state, "WAITING");
});

check("currentOperationalState: WAITING per finestra di flatten", () => {
  const state = currentOperationalState({
    systemStopped: false,
    session: { weekendClosed: false, inFlattenWindow: true },
    stream: { heartbeat: new Date(wednesday10h).toISOString() },
  }, wednesday10h + 1000);
  assert.equal(state, "WAITING");
});

check("currentOperationalState: STOP e OFFLINE restano invariati", () => {
  assert.equal(currentOperationalState(null, Date.now()), "OFFLINE");
  assert.equal(currentOperationalState({ systemStopped: true }, Date.now()), "STOP");
  assert.equal(currentOperationalState({ systemStopped: false, stream: { heartbeat: null } }, Date.now()), "OFFLINE");
});

console.log(`\n${passed} scenari OK.`);

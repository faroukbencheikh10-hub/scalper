// Deterministic scenarios for switching instrument and for the per-symbol loss guards.
// Due regole condivise da worker e API di controllo, entrambe pure e verificabili a secco:
// - symbolSwitchDecision: con una posizione aperta (su qualunque strumento) il cambio e' vietato;
// - lossGuardsFromClosures: LOSS_LOCK e la pausa da perdite consecutive sono per strumento, quindi
//   una serie sull'oro non tocca NAS100 e viceversa.
import assert from "node:assert/strict";
import { symbolSwitchDecision } from "../src/lib/symbols";
import { lossGuardsFromClosures, type ClosureRow } from "../src/lib/server/lossGuards";

let passed = 0;
function check(name: string, test: () => void) {
  try { test(); passed++; console.log("OK " + name); }
  catch (error) { console.error("FAIL " + name); throw error; }
}

// --- Cambio strumento ---------------------------------------------------------------------------

check("senza posizioni aperte il cambio e' permesso", () => {
  const decision = symbolSwitchDecision({ current: "XAUUSD", requested: "NAS100", openPositionSymbol: null });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, null);
});

check("con una posizione aperta sullo strumento corrente il cambio e' bloccato", () => {
  const decision = symbolSwitchDecision({ current: "XAUUSD", requested: "NAS100", openPositionSymbol: "XAUUSD" });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason!, /Posizione aperta su XAUUSD/);
  assert.match(decision.reason!, /prima di passare a NAS100/);
});

check("bloccato anche se la posizione e' aperta sull'ALTRO strumento: il limite e' di conto", () => {
  const decision = symbolSwitchDecision({ current: "NAS100", requested: "XAUUSD", openPositionSymbol: "NAS100" });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason!, /Posizione aperta su NAS100/);
});

check("un ciclo d'ordine in volo rimanda il cambio, non lo nega per sempre", () => {
  const decision = symbolSwitchDecision({ current: "XAUUSD", requested: "NAS100", openPositionSymbol: null, busy: true });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason!, /rimandato al prossimo controllo/);
});

check("chiedere lo strumento gia' attivo non e' un cambio", () => {
  const decision = symbolSwitchDecision({ current: "NAS100", requested: "NAS100", openPositionSymbol: null });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason!, /gia' su NAS100/);
});

// --- LOSS_LOCK e perdite consecutive, per strumento ---------------------------------------------

const T0 = Date.UTC(2026, 8, 9, 10, 0, 0);
const OPTIONS = { lossLockMs: 30 * 60_000, consecLossPauseMs: 120 * 60_000, consecLossCount: 3 };
const loss = (symbol: string, direction: "BUY" | "SELL", minutesAgo: number): ClosureRow => ({
  symbol, direction, outcome: "LOSS", close_reason: "sl_initial", mt5_profit: -12,
  closed_at: new Date(T0 - minutesAgo * 60_000).toISOString(),
});
const win = (symbol: string, direction: "BUY" | "SELL", minutesAgo: number): ClosureRow => ({
  symbol, direction, outcome: "WIN", close_reason: "tp_fast", mt5_profit: 9,
  closed_at: new Date(T0 - minutesAgo * 60_000).toISOString(),
});

check("una perdita su XAUUSD blocca quella direzione SOLO su XAUUSD", () => {
  const guards = lossGuardsFromClosures([loss("XAUUSD", "BUY", 5)], OPTIONS);
  assert.equal(guards.get("XAUUSD")!.locks.BUY, T0 - 5 * 60_000 + OPTIONS.lossLockMs);
  assert.equal(guards.get("XAUUSD")!.locks.SELL, 0, "l'altra direzione resta libera");
  assert.equal(guards.get("NAS100"), undefined, "NAS100 non ha alcun blocco");
});

check("una perdita su NAS100 non tocca XAUUSD, e le due convivono senza mischiarsi", () => {
  const guards = lossGuardsFromClosures([loss("NAS100", "SELL", 2), loss("XAUUSD", "BUY", 8)], OPTIONS);
  assert.equal(guards.get("NAS100")!.locks.SELL, T0 - 2 * 60_000 + OPTIONS.lossLockMs);
  assert.equal(guards.get("NAS100")!.locks.BUY, 0);
  assert.equal(guards.get("XAUUSD")!.locks.BUY, T0 - 8 * 60_000 + OPTIONS.lossLockMs);
  assert.equal(guards.get("XAUUSD")!.locks.SELL, 0);
});

check("tre perdite consecutive su XAUUSD mettono in pausa XAUUSD, mai NAS100", () => {
  const rows = [loss("XAUUSD", "BUY", 1), loss("XAUUSD", "SELL", 4), loss("XAUUSD", "BUY", 9)];
  const guards = lossGuardsFromClosures(rows, OPTIONS);
  assert.equal(guards.get("XAUUSD")!.pauseUntil, T0 - 1 * 60_000 + OPTIONS.consecLossPauseMs);
  assert.equal(guards.get("NAS100"), undefined);
});

check("le perdite dei due strumenti non si sommano nel contatore di perdite consecutive", () => {
  // Due su XAUUSD e una su NAS100: nessuno dei due arriva a tre, nessuna pausa da nessuna parte.
  const rows = [loss("XAUUSD", "BUY", 1), loss("NAS100", "BUY", 3), loss("XAUUSD", "SELL", 6)];
  const guards = lossGuardsFromClosures(rows, OPTIONS);
  assert.equal(guards.get("XAUUSD")!.pauseUntil, 0);
  assert.equal(guards.get("NAS100")!.pauseUntil, 0);
});

check("una vincita interrompe la serie del proprio strumento, non quella dell'altro", () => {
  const rows = [
    loss("NAS100", "BUY", 1), loss("NAS100", "SELL", 2), loss("NAS100", "BUY", 3),
    loss("XAUUSD", "BUY", 1), win("XAUUSD", "SELL", 2), loss("XAUUSD", "BUY", 3), loss("XAUUSD", "SELL", 4),
  ];
  const guards = lossGuardsFromClosures(rows, OPTIONS);
  assert.equal(guards.get("NAS100")!.pauseUntil, T0 - 1 * 60_000 + OPTIONS.consecLossPauseMs, "tre di fila su NAS100");
  assert.equal(guards.get("XAUUSD")!.pauseUntil, 0, "la vincita spezza la serie dell'oro");
});

check("solo sl_initial in perdita conta: le uscite gestite non bloccano nulla", () => {
  const managed: ClosureRow[] = [
    { symbol: "NAS100", direction: "BUY", outcome: "LOSS", close_reason: "sl_breakeven", mt5_profit: -3, closed_at: new Date(T0).toISOString() },
    { symbol: "NAS100", direction: "SELL", outcome: "LOSS", close_reason: "sl_trailing", mt5_profit: -2, closed_at: new Date(T0).toISOString() },
  ];
  const guards = lossGuardsFromClosures(managed, OPTIONS);
  assert.deepEqual(guards.get("NAS100")!.locks, { BUY: 0, SELL: 0 });
  assert.equal(guards.get("NAS100")!.pauseUntil, 0);
});

check("lo storico senza colonna symbol resta sotto XAUUSD, come dopo la migrazione", () => {
  const legacy: ClosureRow[] = [{ direction: "BUY", outcome: "LOSS", close_reason: "sl_initial", mt5_profit: -10, closed_at: new Date(T0).toISOString() }];
  const guards = lossGuardsFromClosures(legacy, OPTIONS);
  assert.equal(guards.get("XAUUSD")!.locks.BUY, T0 + OPTIONS.lossLockMs);
  assert.equal(guards.get("NAS100"), undefined);
});

console.log(`${passed} scenari superati.`);

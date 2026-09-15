// Deterministic scenarios for the margin-failure cooldown (MARGIN_FAIL_COOLDOWN_SEC): blocco
// aggiuntivo e indipendente da LOSS_LOCK/CONSEC_LOSS/re-entry, per singola combinazione
// symbol+setup+direzione, armato SOLO dal fallimento specifico del margine.
// Il tempo e' iniettato (nowMs), quindi niente orologio reale: ciclo completo verificabile a secco.
import assert from "node:assert/strict";
import {
  armMarginCooldown, isInsufficientMarginFailure, marginCooldownActive, marginCooldownKey,
  marginCooldownReason, MARGIN_NO_MONEY_CODE, type MarginCooldownState,
} from "../src/lib/server/marginCooldown";

let passed = 0;
function check(name: string, test: () => void) {
  try { test(); passed++; console.log("OK " + name); }
  catch (error) { console.error("FAIL " + name); throw error; }
}

const SYMBOL = "XAUUSD";
const COOLDOWN_MS = 30_000; // MARGIN_FAIL_COOLDOWN_SEC default
const T0 = Date.UTC(2026, 8, 9, 10, 5, 0);
const state = (): MarginCooldownState => new Map();

// --- Riconoscimento: le due sole firme reali del fallimento per margine --------------------------

check("preflight free margin (status insufficient_margin) riconosciuto", () => {
  assert.equal(isInsufficientMarginFailure({
    status: "insufficient_margin",
    reason: "0.05 lotti @ 2200.00: richiesti 110.00, liberi 40.00",
  }), true);
});

check("rifiuto broker 10019 con numericCode propagato riconosciuto", () => {
  assert.equal(MARGIN_NO_MONEY_CODE, 10019);
  assert.equal(isInsufficientMarginFailure({
    status: "error", numericCode: MARGIN_NO_MONEY_CODE, error: "Esito ordine non confermato: {...}",
  }), true);
});

check("rifiuto broker 10019 riconosciuto anche solo dal messaggio, senza numericCode", () => {
  assert.equal(isInsufficientMarginFailure({
    status: "error",
    error: 'Esito ordine non confermato: {"numericCode":10019,"stringCode":"TRADE_RETCODE_NO_MONEY"}',
  }), true);
  assert.equal(isInsufficientMarginFailure({
    status: "error", error: "TradeError: TRADE_RETCODE_NO_MONEY",
  }), true);
});

check("nessun altro esito arma il cooldown (errore generico, blocchi, ordine aperto)", () => {
  for (const execution of [
    { status: "error", error: "Esito ordine non confermato: {\"numericCode\":10013}" },
    { status: "error", error: "timeout" },
    { status: "pending_confirmation", error: "socket hang up" },
    { status: "blocked_position_limit" },
    { status: "blocked", reason: "max_trades_per_day" },
    { status: "opened" },
  ]) {
    assert.equal(isInsufficientMarginFailure(execution), false, JSON.stringify(execution));
  }
});

check("10019 dentro un altro campo non basta: serve il retcode, non un numero qualsiasi", () => {
  assert.equal(isInsufficientMarginFailure({
    status: "error", error: 'Esito ordine non confermato: {"numericCode":10013,"volume":10019}',
  }), false);
});

check("un timeout ambiguo con retcode di margine non arma nulla: solo gli esiti rifiutati contano", () => {
  assert.equal(isInsufficientMarginFailure({
    status: "pending_confirmation", numericCode: MARGIN_NO_MONEY_CODE,
  }), false);
});

// --- Ciclo completo: fallimento -> cooldown -> setup scartato -> scadenza -> di nuovo valutabile --

check("margine insufficiente -> cooldown attivo -> scaduto al tempo pieno -> setup di nuovo valutabile", () => {
  const cooldowns = state();
  const key = marginCooldownKey(SYMBOL, "m1_short", "BUY");
  assert.equal(marginCooldownActive(cooldowns, key, T0), null, "prima del fallimento nessun blocco");

  const armed = armMarginCooldown(cooldowns, key, T0, COOLDOWN_MS);
  assert.equal(armed.armed, true, "primo fallimento: cooldown armato");
  assert.equal(armed.until, T0 + COOLDOWN_MS);

  // Dentro la finestra il setup e' scartato senza nemmeno costruire l'ordine.
  assert.equal(marginCooldownActive(cooldowns, key, T0 + 1), T0 + COOLDOWN_MS);
  assert.equal(marginCooldownActive(cooldowns, key, T0 + COOLDOWN_MS - 1), T0 + COOLDOWN_MS);
  // Alla scadenza esatta il blocco cade e la chiave si pulisce da sola.
  assert.equal(marginCooldownActive(cooldowns, key, T0 + COOLDOWN_MS), null);
  assert.equal(cooldowns.size, 0);
  assert.equal(marginCooldownActive(cooldowns, key, T0 + COOLDOWN_MS + 1), null);
});

check("il cooldown non si cancella in anticipo se il margine si libera: scade solo al tempo pieno", () => {
  const cooldowns = state();
  const key = marginCooldownKey(SYMBOL, "quick_tick", "SELL");
  armMarginCooldown(cooldowns, key, T0, COOLDOWN_MS);
  // Nessuna API per revocarlo: margine libero di nuovo o no, il blocco resta fino alla scadenza.
  for (const elapsed of [1_000, 5_000, 15_000, 29_999]) {
    assert.equal(marginCooldownActive(cooldowns, key, T0 + elapsed), T0 + COOLDOWN_MS, `t+${elapsed}ms`);
  }
  assert.equal(marginCooldownActive(cooldowns, key, T0 + COOLDOWN_MS), null);
});

check("log una volta sola: un secondo fallimento nella finestra non riarma e non allunga", () => {
  const cooldowns = state();
  const key = marginCooldownKey(SYMBOL, "m1_range", "BUY");
  const first = armMarginCooldown(cooldowns, key, T0, COOLDOWN_MS);
  const second = armMarginCooldown(cooldowns, key, T0 + 5_000, COOLDOWN_MS);
  assert.equal(first.armed, true, "solo la prima attivazione si logga");
  assert.equal(second.armed, false, "dentro la finestra non si logga nulla");
  assert.equal(second.until, first.until, "la finestra non si allunga a ogni fallimento");
  // Dopo la scadenza un nuovo fallimento riarma (e rilogga) normalmente.
  const third = armMarginCooldown(cooldowns, key, T0 + COOLDOWN_MS, COOLDOWN_MS);
  assert.equal(third.armed, true);
  assert.equal(third.until, T0 + 2 * COOLDOWN_MS);
});

// --- Isolamento: direzione, setup e symbol restano indipendenti (stesso principio di LOSS_LOCK) --

check("il blocco e' per singola direzione: BUY bloccato non blocca SELL", () => {
  const cooldowns = state();
  armMarginCooldown(cooldowns, marginCooldownKey(SYMBOL, "m1_short", "BUY"), T0, COOLDOWN_MS);
  assert.notEqual(marginCooldownActive(cooldowns, marginCooldownKey(SYMBOL, "m1_short", "BUY"), T0 + 1), null);
  assert.equal(marginCooldownActive(cooldowns, marginCooldownKey(SYMBOL, "m1_short", "SELL"), T0 + 1), null);
});

check("il blocco non tocca gli altri setup ne' un altro symbol", () => {
  const cooldowns = state();
  armMarginCooldown(cooldowns, marginCooldownKey(SYMBOL, "m1_short", "BUY"), T0, COOLDOWN_MS);
  for (const key of [
    marginCooldownKey(SYMBOL, "m1_range", "BUY"),
    marginCooldownKey(SYMBOL, "quick_tick", "BUY"),
    marginCooldownKey(SYMBOL, "micro_pullback", "BUY"),
    marginCooldownKey("EURUSD", "m1_short", "BUY"),
  ]) {
    assert.equal(marginCooldownActive(cooldowns, key, T0 + 1), null, key);
  }
});

// --- Spegnimento e motivo mostrato --------------------------------------------------------------

check("MARGIN_FAIL_COOLDOWN_SEC=0 spegne il blocco: nessuna chiave registrata", () => {
  const cooldowns = state();
  const key = marginCooldownKey(SYMBOL, "m1_short", "BUY");
  const armed = armMarginCooldown(cooldowns, key, T0, 0);
  assert.equal(armed.armed, false);
  assert.equal(cooldowns.size, 0);
  assert.equal(marginCooldownActive(cooldowns, key, T0), null);
});

check("il motivo porta setup, direzione, orario di scadenza e secondi mancanti", () => {
  const reason = marginCooldownReason("m1_short", "BUY", T0 + COOLDOWN_MS, T0 + 10_000);
  assert.match(reason, /Margine insufficiente su m1_short BUY/);
  assert.match(reason, /10:05:30 UTC/);
  assert.match(reason, /altri 20 s/);
});

console.log(`${passed} scenari superati.`);

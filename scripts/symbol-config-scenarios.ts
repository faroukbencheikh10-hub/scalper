// Deterministic scenarios for the per-symbol parameters (XAUUSD / NAS100).
// La logica dei setup non cambia mai: cambiano solo i numeri in unita' di prezzo che ricevono.
// Qui si verifica la catena di risoluzione (env con prefisso -> env storica solo per XAUUSD ->
// default per strumento), che i default NAS100 non siano una copia di quelli dell'oro, e che gli
// stessi identici dati di mercato producano esiti diversi a seconda dello strumento attivo.
import assert from "node:assert/strict";
import { evaluateScalper } from "../src/lib/server/scalperStrategy";
import {
  contractSpec, fastTpBounds, PRICE_PARAM_DEFAULTS, symbolPriceParam,
} from "../src/lib/server/symbolConfig";
import {
  execLotsSettingKey, fastTpSettingKey, pickSymbolSetting, resolveTradedSymbol, TRADED_SYMBOLS,
} from "../src/lib/symbols";
import { lossAtStop, requiredMargin } from "../src/lib/lots";
import { MINUTE } from "../src/lib/server/marketStructure";
import type { Candle } from "../src/lib/types";

for (const key of Object.keys(process.env)) {
  if (/^(MTF_|SCALPER_|SL_|SHOCK_|M15_|SHORT_|RANGE_|TP_|QUICK_TICK_|XAUUSD_|NAS100_|ENTRY_)/.test(key)) delete process.env[key];
}
process.env.SCALPER_HOURS_UTC = "00:00-23:59";
process.env.SHORT_ENABLED = "false";
process.env.RANGE_ENABLED = "false";

let passed = 0;
function check(name: string, test: () => void) {
  try { test(); passed++; console.log("OK " + name); }
  catch (error) { console.error("FAIL " + name); throw error; }
}
function withEnv(overrides: Record<string, string>, test: () => void) {
  const previous = new Map(Object.keys(overrides).map((k) => [k, process.env[k]]));
  Object.assign(process.env, overrides);
  try { test(); } finally {
    for (const [k, v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// --- Catena di risoluzione ----------------------------------------------------------------------

check("default per strumento quando non c'e' nessuna env", () => {
  assert.equal(symbolPriceParam("XAUUSD", "SL_MIN_USD", 0.1, 50), 3);
  assert.equal(symbolPriceParam("NAS100", "SL_MIN_USD", 0.1, 50), 15);
});

check("env con prefisso dello strumento: vince su tutto", () => {
  withEnv({ NAS100_SL_MIN_USD: "22", XAUUSD_SL_MIN_USD: "4" }, () => {
    assert.equal(symbolPriceParam("NAS100", "SL_MIN_USD", 0.1, 50), 22);
    assert.equal(symbolPriceParam("XAUUSD", "SL_MIN_USD", 0.1, 50), 4);
  });
});

check("env storica senza prefisso: vale solo per XAUUSD, mai per NAS100", () => {
  withEnv({ SL_MIN_USD: "5" }, () => {
    assert.equal(symbolPriceParam("XAUUSD", "SL_MIN_USD", 0.1, 50), 5, "il deploy dell'oro non cambia");
    assert.equal(symbolPriceParam("NAS100", "SL_MIN_USD", 0.1, 50), 15, "un SL in dollari non si applica a NAS100");
  });
});

check("un valore fuori dai limiti viene ignorato e si passa al livello successivo", () => {
  withEnv({ NAS100_SL_MIN_USD: "999" }, () => {
    assert.equal(symbolPriceParam("NAS100", "SL_MIN_USD", 0.1, 50), 15);
  });
});

check("i default NAS100 non sono una copia di XAUUSD: ogni distanza e' piu' larga", () => {
  const gold = PRICE_PARAM_DEFAULTS.XAUUSD, nas = PRICE_PARAM_DEFAULTS.NAS100;
  const names = Object.keys(gold) as Array<keyof typeof gold>;
  assert.ok(names.length >= 25, "la tabella copre tutti i parametri in unita' di prezzo");
  for (const name of names) {
    // La commissione per lotto e' l'unica voce che NON e' una distanza: sugli indici e' piu' bassa.
    if (name === "MTF_ROUNDTRIP_COMMISSION_PER_LOT_USD") continue;
    assert.ok(nas[name] > gold[name], `${name}: NAS100 ${nas[name]} deve superare XAUUSD ${gold[name]}`);
  }
});

// --- Stessi dati, strumento diverso, esito diverso (stessa logica, numeri diversi) ---------------

const END = Date.UTC(2026, 8, 9, 10, 5);
const M5 = 5 * MINUTE, M15 = 15 * MINUTE;
const bar = (ms: number, open: number, close: number, wick: number): Candle => ({
  datetime: new Date(ms).toISOString(), open, close,
  high: Math.max(open, close) + wick, low: Math.min(open, close) - wick,
});

/** M5 in trend pulito attorno a `level`, con ampiezza proporzionale alla scala dello strumento. */
function contextM5(level: number, scale: number, total = 120) {
  const deltas = Array.from({ length: total }, (_, i) => {
    const group = Math.floor((END - (total - 1 - i) * M5) / M15) % 3;
    return (group === 2 ? -0.5 : 1) * scale;
  });
  const levels: number[] = [];
  let running = 0;
  for (const delta of deltas) { levels.push(running); running += delta; }
  const offset = level - running;
  return deltas.map((delta, i) => bar(END - (total - 1 - i) * M5,
    levels[i] + offset, levels[i] + offset + delta, Math.max(0.5 * scale, Math.abs(delta))));
}

/** M1 piatta attorno a `level`: l'ampiezza di ogni candela scala con lo strumento (ATR M1). */
function flatM1(level: number, scale: number, total = 40) {
  return Array.from({ length: total }, (_, i) => {
    const up = i % 2 === 0;
    const half = 0.5 * scale;
    return bar(END - (total - 1 - i) * MINUTE, up ? level - half : level + half, up ? level + half : level - half, 0.2 * scale);
  });
}

/** Rottura verso l'alto della finestra quick_tick, con distanze proporzionali allo strumento. */
function fixture(level: number, scale: number, symbol: "XAUUSD" | "NAS100") {
  const m1 = flatM1(level, scale);
  const window = m1.slice(0, -1).slice(-6);
  const high = Math.max(...window.map((c) => c.high));
  const distance = 0.30 * scale;
  const spread = 0.10 * scale;
  const bid = high + distance;
  return {
    nowMs: END, m1, m5: contextM5(level, scale),
    quote: { bid, ask: bid + spread, mid: bid + spread / 2, spread, quotedAt: END },
    exitMode: "fast" as const, quickTickSpreadAvg: null, symbol,
  };
}

check("stessi dati NAS100: passano con i parametri NAS100, scartati con quelli dell'oro", () => {
  // Scala 5x rispetto all'oro: ATR M1 di ~7 punti, ben dentro i limiti NAS100 (4-30) e ben oltre
  // il massimo dell'oro (6). Cambia solo il simbolo: candele, quote e logica sono identiche.
  const asNas = evaluateScalper(fixture(22_000, 5, "NAS100"));
  assert.equal(asNas.direction, "BUY", JSON.stringify(asNas));
  assert.equal(asNas.setup, "quick_tick");

  const asGold = evaluateScalper({ ...fixture(22_000, 5, "NAS100"), symbol: "XAUUSD" as const });
  assert.equal(asGold.direction, "NO_TRADE", JSON.stringify(asGold));
  assert.match(
    asGold.evaluations.map((e) => e.reason).join(" "),
    /volatilit.* M1 fuori limiti/,
    "con i limiti ATR dell'oro la stessa volatilita' e' fuori scala",
  );
});

check("SL e TP di quick_tick sono nella scala dello strumento, non in quella dell'oro", () => {
  const nas = evaluateScalper(fixture(22_000, 5, "NAS100"));
  assert.equal(nas.direction, "BUY");
  const nasRisk = nas.entry! - nas.stopLoss!, nasReward = nas.takeProfit! - nas.entry!;
  // NAS100: SL fra 12 e 30 punti, TP fra 10 e 20 punti (QUICK_TICK_*_MIN/MAX_USD di NAS100).
  assert.ok(nasRisk >= 12 && nasRisk <= 30, `SL NAS100 fuori scala: ${nasRisk}`);
  assert.ok(nasReward >= 10 && nasReward <= 20, `TP NAS100 fuori scala: ${nasReward}`);

  const gold = evaluateScalper(fixture(3_300, 1, "XAUUSD"));
  assert.equal(gold.direction, "BUY", JSON.stringify(gold));
  const goldRisk = gold.entry! - gold.stopLoss!, goldReward = gold.takeProfit! - gold.entry!;
  // XAUUSD: invariato rispetto a sempre, SL 2.5-6$ e TP 2-4$.
  assert.ok(goldRisk >= 2.5 && goldRisk <= 6, `SL XAUUSD fuori scala: ${goldRisk}`);
  assert.ok(goldReward >= 2 && goldReward <= 4, `TP XAUUSD fuori scala: ${goldReward}`);
  assert.ok(nasRisk > goldRisk * 2 && nasReward > goldReward * 2, "le due scale restano distinte");
});

check("senza simbolo la valutazione resta quella storica di XAUUSD", () => {
  const withSymbol = evaluateScalper(fixture(3_300, 1, "XAUUSD"));
  const { symbol: _drop, ...withoutSymbol } = fixture(3_300, 1, "XAUUSD");
  assert.deepEqual(evaluateScalper(withoutSymbol), withSymbol);
});

// --- Margine e rischio: la contract size e' dello strumento, non dell'oro -----------------------

check("contract spec: oro 100 once per lotto, NAS100 1 unita' di indice", () => {
  assert.deepEqual(contractSpec("XAUUSD"), { contractSize: 100, leverage: 500 });
  assert.deepEqual(contractSpec("NAS100"), { contractSize: 1, leverage: 200 });
});

check("contract spec sovrascrivibile da env quando il broker differisce", () => {
  withEnv({ NAS100_CONTRACT_SIZE: "20", NAS100_MARGIN_LEVERAGE: "100" }, () => {
    assert.deepEqual(contractSpec("NAS100"), { contractSize: 20, leverage: 100 });
  });
});

check("margine e rischio seguono lo strumento: con la contract size dell'oro NAS100 sarebbe ~100x", () => {
  const lots = 0.05;
  // 0.05 * 1 * 22000 / 200 = 5.50 con la specifica giusta; 0.05 * 100 * 22000 / 500 = 220 con
  // quella dell'oro, cioe' 40 volte tanto: con un free margin normale bloccherebbe ogni ordine.
  assert.equal(requiredMargin(lots, 22_000, contractSpec("NAS100")), 5.5);
  assert.equal(requiredMargin(lots, 22_000, contractSpec("XAUUSD")), 220);
  assert.equal(lossAtStop(lots, 20, contractSpec("NAS100").contractSize), 1);
  assert.equal(lossAtStop(lots, 4, contractSpec("XAUUSD").contractSize), 20);
});

// --- Impostazioni per strumento ------------------------------------------------------------------

check("chiavi delle impostazioni separate per strumento", () => {
  assert.equal(execLotsSettingKey("XAUUSD"), "exec_lots_xauusd");
  assert.equal(execLotsSettingKey("NAS100"), "exec_lots_nas100");
  assert.equal(fastTpSettingKey("NAS100"), "fast_tp_usd_nas100");
});

check("la chiave storica exec_lots resta il ripiego solo per XAUUSD", () => {
  assert.equal(pickSymbolSetting("XAUUSD", undefined, "0.07"), "0.07");
  assert.equal(pickSymbolSetting("XAUUSD", "0.03", "0.07"), "0.03", "la chiave nuova vince");
  assert.equal(pickSymbolSetting("NAS100", undefined, "0.07"), undefined, "NAS100 non eredita i lotti dell'oro");
});

check("TP fisso di exit_mode=fast: minimo e default per strumento", () => {
  assert.deepEqual(fastTpBounds("XAUUSD"), { minUsd: 0.5, defaultUsd: 2.5 });
  assert.deepEqual(fastTpBounds("NAS100"), { minUsd: 2.5, defaultUsd: 12 });
});

check("resolveTradedSymbol: solo i simboli noti, tutto il resto resta XAUUSD", () => {
  assert.deepEqual(TRADED_SYMBOLS, ["XAUUSD", "NAS100"]);
  assert.equal(resolveTradedSymbol("NAS100"), "NAS100");
  assert.equal(resolveTradedSymbol("nas100"), "NAS100");
  assert.equal(resolveTradedSymbol("US100"), "XAUUSD", "un nome di broker non e' una chiave logica");
  assert.equal(resolveTradedSymbol(undefined), "XAUUSD");
});

console.log(`${passed} scenari superati.`);

// Scenari sintetici della logica d'ingresso e del dimensionamento SL/TP.
// Esecuzione: npm run scenarios  (nessuna connessione a MetaApi o al database).
import { evaluateScalper } from "../src/lib/server/scalperStrategy";
import { emaClose } from "../src/lib/server/indicators";
import type { Candle, Quote } from "../src/lib/types";

process.env.SCALPER_HOURS_UTC = "00:00-23:59";

let t = Date.UTC(2026, 0, 5, 10, 0, 0);
function candle(open: number, high: number, low: number, close: number): Candle {
  const c = { datetime: new Date(t).toISOString(), open, high, low, close };
  t += 60_000;
  return c;
}
function flatM5(price = 2000, n = 40): Candle[] {
  let ts = Date.UTC(2026, 0, 5, 6, 0, 0);
  return Array.from({ length: n }, () => {
    const c = { datetime: new Date(ts).toISOString(), open: price, high: price + 0.4, low: price - 0.4, close: price };
    ts += 5 * 60_000;
    return c;
  });
}
function trendM5(start: number, step: number, n = 40): Candle[] {
  let ts = Date.UTC(2026, 0, 5, 6, 0, 0);
  let price = start;
  return Array.from({ length: n }, () => {
    const open = price; price += step;
    const c = { datetime: new Date(ts).toISOString(), open, high: Math.max(open, price) + 0.3, low: Math.min(open, price) - 0.3, close: price };
    ts += 5 * 60_000;
    return c;
  });
}
function quote(mid: number): Quote {
  return { bid: mid - 0.1, ask: mid + 0.1, mid, spread: 0.2, quotedAt: Date.now() };
}
function oscillating(n: number, base: number, drift = 0, band = 1.0): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const mid = base + drift * i;
    const up = i % 2 === 0;
    const open = up ? mid - band / 2 : mid + band / 2;
    const close = up ? mid + band / 2 : mid - band / 2;
    out.push(candle(open, Math.max(open, close) + 0.05, Math.min(open, close) - 0.05, close));
  }
  return out;
}
function accelerate(m1: Candle[], bars: number, body: number) {
  for (let i = 0; i < bars; i++) {
    const ema = emaClose(m1, 9)!;
    const low = ema - 0.05;
    const open = ema + 0.1;
    const close = open + body;
    m1.push(candle(open, close + 0.05, low, close));
  }
}

let failures = 0;
type Expect = {
  direction: string;
  setup?: string | null;
  /** Verifica aggiuntiva sul segnale: restituisce null se va bene, altrimenti il motivo del fallimento. */
  check?: (signal: ReturnType<typeof evaluateScalper>) => string | null;
};

function show(name: string, m1: Candle[], m5: Candle[], q: Quote, expect: Expect) {
  const s = evaluateScalper({ quote: q, m1, m5 });
  const extra = expect.check ? expect.check(s) : null;
  const ok = s.direction === expect.direction && (expect.setup === undefined || s.setup === expect.setup) && extra === null;
  if (!ok) failures++;
  console.log(`\n### ${ok ? "OK " : "KO "} ${name}`);
  console.log(`   -> ${s.direction}${s.setup ? ` (${s.setup})` : ""} entry=${s.entry} SL=${s.stopLoss} TP=${s.takeProfit}`);
  if (s.slPlan) {
    console.log(`   SL struttura ${s.slPlan.structural}$ · ATR ${s.slPlan.atr}$ · applicato ${s.slPlan.applied}$ · TP ${(s.slPlan.applied * s.slPlan.rr).toFixed(2)}$ (${s.slPlan.rr}R)`);
  }
  if (!ok) console.log(`   atteso: ${expect.direction}${expect.setup ? ` (${expect.setup})` : ""}${extra ? ` — ${extra}` : ""}`);
  for (const e of s.evaluations) console.log(`   · ${e.setup} [${e.status}]${e.direction ? ` ${e.direction}` : ""}: ${e.reason}`);
  return s;
}

// A) M5 neutro + M1 accelerato: micro_pullback consentito, ma il breakout ha priorita' piu' alta
{
  const m1 = oscillating(40, 2000);
  accelerate(m1, 6, 1.6);
  show("A · M5 neutro + M1 accelerato (priorita' al momentum_breakout)", m1, flatM5(2000), quote(m1.at(-1)!.close), { direction: "BUY", setup: "momentum_breakout" });
}

// B) M5 neutro + M1 lento: nessun trigger
{
  const m1 = oscillating(46, 2000, 0.12);
  show("B · M5 neutro + M1 lento", m1, flatM5(2000), quote(m1.at(-1)!.close), { direction: "NO_TRADE" });
}

// C) Momentum breakout puro, con estensione oltre il livello dentro BREAKOUT_MAX_EXT_ATR
{
  const m1 = oscillating(44, 1990, 0.05);
  const top = Math.max(...m1.slice(-14).map((c) => c.high));
  m1.push(candle(top - 0.2, top + 1.3, top - 0.3, top + 1.2));
  m1.push(candle(top + 1.2, top + 1.4, top + 1, top + 1.05));
  show("C · Momentum breakout M1", m1, flatM5(1990), quote(m1.at(-1)!.close), { direction: "BUY", setup: "momentum_breakout" });
}

// N) Breakout gia' scappato: chiusura troppo oltre il livello rotto -> scartato
{
  const m1 = oscillating(44, 1990, 0.05);
  const top = Math.max(...m1.slice(-14).map((c) => c.high));
  m1.push(candle(top - 0.2, top + 2.9, top - 0.3, top + 2.8));
  m1.push(candle(top + 2.8, top + 3, top + 2.6, top + 2.65));
  show("N · Breakout troppo esteso (deve scartare)", m1, flatM5(1990), quote(m1.at(-1)!.close), {
    direction: "NO_TRADE",
    check: (s) => {
      const breakout = s.evaluations.find((item) => item.setup === "momentum_breakout");
      if (!breakout) return "momentum_breakout non valutato";
      if (breakout.status !== "rejected") return `momentum_breakout ${breakout.status} invece di rejected`;
      return breakout.reason.includes("movimento già esteso") ? null : `motivo inatteso: ${breakout.reason}`;
    },
  });
}

// D) Range sporco: ampiezza compressa, EMA piatte, nessuna accelerazione
{
  const m1 = oscillating(40, 2000, 0, 0.9);
  show("D · Range sporco compresso", m1, flatM5(2000), quote(m1.at(-1)!.close), { direction: "NO_TRADE" });
}

// E) M5 contrario alla direzione M1
{
  const m1 = oscillating(40, 2000);
  accelerate(m1, 6, 1.6);
  show("E · M5 ribassista contro long M1", m1, trendM5(2100, -1.2), quote(m1.at(-1)!.close), { direction: "NO_TRADE" });
}

// F) Compressione breve + accelerazione: l'anti-accumulo non blocca
{
  const m1 = oscillating(34, 2000, 0, 0.9);
  accelerate(m1, 4, 1.6);
  show("F · Compressione + accelerazione M1", m1, flatM5(2000), quote(m1.at(-1)!.close), { direction: "BUY" });
}

// G) Candela shock in corso: nessun ingresso diretto
{
  const m1 = oscillating(44, 2000);
  const base = m1.at(-1)!.close;
  m1.push(candle(base, base + 6.3, base - 0.3, base + 6.0));
  show("G · Candela shock in corso (nessun inseguimento)", m1, flatM5(2000), quote(m1.at(-1)!.close), { direction: "NO_TRADE" });
}

// H) Breakout retest dopo la shock: ritracciamento e riavvio
{
  const m1 = oscillating(44, 2000);
  const base = m1.at(-1)!.close;
  m1.push(candle(base, base + 6.3, base - 0.3, base + 6.0));               // shock chiusa
  m1.push(candle(base + 6.0, base + 6.1, base + 2.0, base + 2.4));         // retest verso il livello/EMA9
  m1.push(candle(base + 2.4, base + 3.6, base + 2.35, base + 3.5));        // riavvio in corso
  show("H · Breakout retest dopo shock", m1, flatM5(2000), quote(m1.at(-1)!.close), { direction: "BUY", setup: "breakout_retest" });
}

// I) Retest fallito: il prezzo chiude oltre il livello rotto
{
  const m1 = oscillating(44, 2000);
  const base = m1.at(-1)!.close;
  m1.push(candle(base, base + 6.3, base - 0.3, base + 6.0));
  m1.push(candle(base + 6.0, base + 6.1, base - 1.5, base - 1.0));         // chiude sotto il livello
  m1.push(candle(base - 1.0, base + 0.2, base - 1.1, base + 0.1));
  show("I · Retest fallito sotto il livello", m1, flatM5(2000), quote(m1.at(-1)!.close), { direction: "NO_TRADE" });
}

// J) Priorita': sweep di liquidita' vince sugli altri
{
  const m1 = oscillating(44, 2000);
  const lows = Math.min(...m1.slice(-10, -2).map((c) => c.low));
  m1.push(candle(lows + 0.3, lows + 0.4, lows - 0.8, lows + 0.2));         // sweep dei minimi
  m1.push(candle(lows + 0.2, lows + 1.2, lows + 0.15, lows + 1.1));        // rientro
  show("J · Sweep di liquidita' prioritario", m1, flatM5(2000), quote(m1.at(-1)!.close), { direction: "BUY", setup: "liquidity_sweep" });
}

// K) M5 rialzista allineato: micro_pullback come prima
{
  const m1 = oscillating(40, 2000);
  accelerate(m1, 4, 1.6);
  accelerate(m1, 2, 0.35);
  show("K · M5 rialzista, pullback lento", m1, trendM5(1980, 1.0), quote(m1.at(-1)!.close), { direction: "BUY", setup: "micro_pullback" });
}

// L) SL strutturale sotto l'ATR: la distanza va alzata a SL_ATR_MULT * ATR, il TP resta a TP_RR.
// Il caso riproduce il problema reale: struttura da rumore (~1$) con ATR M1 sopra i 3$.
{
  const m1 = oscillating(40, 2000, 0, 4);
  accelerate(m1, 4, 1.6);
  accelerate(m1, 2, 0.35);
  show("L · SL strutturale sotto ATR (deve essere alzato)", m1, trendM5(1980, 1.0), quote(m1.at(-1)!.close), {
    direction: "BUY",
    setup: "micro_pullback",
    check: (s) => {
      const plan = s.slPlan;
      if (!plan) return "slPlan mancante";
      if (!(plan.structural < plan.atr)) return `lo scenario non ha SL struttura (${plan.structural}$) sotto ATR (${plan.atr}$)`;
      if (!(plan.atr > plan.minUsd)) return `ATR ${plan.atr}$ non sopra il minimo ${plan.minUsd}$: il caso non prova l'alzata da ATR`;
      if (Math.abs(plan.applied - plan.atr) > 0.01) return `SL applicato ${plan.applied}$ invece dell'ATR ${plan.atr}$`;
      const distance = Math.abs(s.entry! - s.stopLoss!);
      if (Math.abs(distance - plan.applied) > 0.02) return `SL sul prezzo ${distance.toFixed(2)}$ diverso dal piano ${plan.applied}$`;
      const tpDistance = Math.abs(s.takeProfit! - s.entry!);
      if (Math.abs(tpDistance - plan.applied * plan.rr) > 0.02) return `TP ${tpDistance.toFixed(2)}$ invece di ${(plan.applied * plan.rr).toFixed(2)}$`;
      return null;
    },
  });
}

// M) SL strutturale oltre il massimo: il trade va scartato, non stretto
{
  const m1 = oscillating(44, 2000);
  const low = Math.min(...m1.slice(-10, -2).map((c) => c.low));
  // Candela di sweep molto profonda: lo stop struttura finisce oltre SL_MAX_USD.
  m1.push(candle(low + 0.4, low + 0.5, low - 11, low + 0.3));
  m1.push(candle(low + 0.3, low + 1.4, low + 0.25, low + 1.3));
  show("M · SL strutturale oltre il massimo (deve scartare)", m1, flatM5(2000), quote(m1.at(-1)!.close), {
    direction: "NO_TRADE",
    check: (s) => (s.reasoning.includes("SL troppo ampio") ? null : `motivo inatteso: ${s.reasoning.slice(0, 120)}`),
  });
}

console.log(`\n=== ${failures === 0 ? "TUTTI GLI SCENARI OK" : `${failures} SCENARI KO`} ===`);
process.exit(failures === 0 ? 0 : 1);

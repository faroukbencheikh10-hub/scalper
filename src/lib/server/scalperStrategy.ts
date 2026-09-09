import type { Candle, Quote, ScalperSetup, ScalperSignal, SetupEvaluation } from "@/lib/types";
import { setupLabel } from "@/lib/setups";
import { atr, emaClose, emaCloseSeries } from "./indicators";

function envN(name: string, fallback: number) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
function envI(name: string, fallback: number, min: number, max: number) {
  const v = Number(process.env[name]);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function no(reasoning: string, evaluations: SetupEvaluation[] = []): ScalperSignal {
  return { direction: "NO_TRADE", entry: null, stopLoss: null, takeProfit: null, riskReward: null, setup: null, slPlan: null, reasoning, evaluations };
}
/** Blocco dei filtri di protezione a monte: nessun setup viene nemmeno valutato. */
function blockedByFilter(reason: string): SetupEvaluation[] {
  return [{ setup: "filtri", status: "rejected", reason }];
}
function hoursAllowed(now = new Date()) {
  const raw = process.env.SCALPER_HOURS_UTC?.trim() || "06:30-20:30";
  const [a, b] = raw.split("-");
  const mins = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  if (!a || !b) return true;
  const start = mins(a), end = mins(b);
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (start === end) return true;
  return start < end ? cur >= start && cur <= end : cur >= start || cur <= end;
}
function bullish(c: Candle) { return c.close > c.open; }
function bearish(c: Candle) { return c.close < c.open; }
function range(c: Candle) { return Math.max(0.01, c.high - c.low); }
function bodyRatio(c: Candle) { return Math.abs(c.close - c.open) / range(c); }

export function evaluateScalper(input: { quote: Quote; m1: Candle[]; m5: Candle[] }): ScalperSignal {
  const { quote, m1, m5 } = input;
  if (!hoursAllowed()) {
    const reason = `Fuori fascia scalper ${process.env.SCALPER_HOURS_UTC || "06:30-20:30"} UTC.`;
    return no(reason, blockedByFilter(reason));
  }
  if (m1.length < 35 || m5.length < 30) return no("Storico M1/M5 insufficiente.", blockedByFilter("Storico M1/M5 insufficiente."));

  // --- Filtri di protezione invariati: spread, ATR minimo/massimo, candela shock. ---
  const maxSpread = envN("SCALPER_MAX_SPREAD", 1.2);
  if (quote.spread > maxSpread) {
    const reason = `Spread ${quote.spread.toFixed(2)}$ sopra massimo ${maxSpread.toFixed(2)}$.`;
    return no(reason, blockedByFilter(reason));
  }

  const atr1 = atr(m1, 14, true);
  if (!atr1) return no("ATR M1 non disponibile.", blockedByFilter("ATR M1 non disponibile."));
  const minAtr = envN("SCALPER_MIN_ATR_M1", 0.8), maxAtr = envN("SCALPER_MAX_ATR_M1", 6);
  if (atr1 < minAtr) {
    const reason = `Volatilità M1 troppo bassa: ATR ${atr1.toFixed(2)}$.`;
    return no(reason, blockedByFilter(reason));
  }
  if (atr1 > maxAtr) {
    const reason = `Volatilità M1 troppo alta: ATR ${atr1.toFixed(2)}$.`;
    return no(reason, blockedByFilter(reason));
  }

  const last = m1[m1.length - 1], prev = m1[m1.length - 2];
  // Candela shock: l'ingresso diretto resta scartato. Il movimento non viene pero' perso:
  // il setup breakout_retest lo riprende sul ritracciamento delle candele successive.
  const shockThreshold = Math.max(atr1 * envN("SHOCK_ATR_MULT", 2.2), 5.5);
  const isShock = (candle: Candle) => candle.high - candle.low > shockThreshold;
  if (isShock(last)) {
    const reason = `Candela M1 shock ${(last.high - last.low).toFixed(2)}$: niente inseguimento, attendo il retest.`;
    return no(reason, blockedByFilter(reason));
  }

  const fast5 = emaClose(m5, 9), slow5 = emaClose(m5, 21);
  const fast1Series = emaCloseSeries(m1, 9), slow1Series = emaCloseSeries(m1, 20);
  const fast1 = fast1Series[m1.length - 1], slow1 = slow1Series[m1.length - 1];
  if ([fast5, slow5, fast1, slow1].some(v => v === null)) return no("EMA non disponibili.", blockedByFilter("EMA non disponibili."));
  const lastM5Close = m5[m5.length - 1].close;
  const trendUp = lastM5Close > fast5! && fast5! > slow5!;
  const trendDown = lastM5Close < fast5! && fast5! < slow5!;
  const m5Label = trendUp ? "rialzista" : trendDown ? "ribassista" : "neutro";

  // --- Direzionalità M1: sostituisce il trend M5 quando l'M5 e' neutro. ---
  // Struttura: EMA9/EMA20 allineate da almeno M1_ALIGN_BARS candele e prezzo dal lato giusto di entrambe.
  // Accelerazione: ultime ACCEL_BARS candele nella stessa direzione, range medio >= ACCEL_ATR_MULT * ATR
  // e corpi >= ACCEL_BODY_RATIO del range.
  const alignBars = envI("M1_ALIGN_BARS", 3, 1, 20);
  const alignFast = fast1Series.slice(m1.length - alignBars);
  const alignSlow = slow1Series.slice(m1.length - alignBars);
  const alignReady = alignFast.length === alignBars && alignFast.every(v => v !== null) && alignSlow.every(v => v !== null);
  const alignedUp = alignReady && alignFast.every((v, i) => v! > alignSlow[i]!);
  const alignedDown = alignReady && alignFast.every((v, i) => v! < alignSlow[i]!);
  const priceAbove = last.close > fast1! && last.close > slow1!;
  const priceBelow = last.close < fast1! && last.close < slow1!;

  const accelBars = envI("ACCEL_BARS", 3, 2, 10);
  const accelAtrMult = envN("ACCEL_ATR_MULT", 1.2);
  const accelBodyMin = envN("ACCEL_BODY_RATIO", 0.6);
  const accelSlice = m1.slice(m1.length - accelBars);
  const accelRangeAvg = accelSlice.reduce((sum, c) => sum + (c.high - c.low), 0) / accelSlice.length;
  const accelFast = accelRangeAvg >= atr1 * accelAtrMult;
  const accelBodies = accelSlice.every(c => bodyRatio(c) >= accelBodyMin);
  const accelUp = accelFast && accelBodies && accelSlice.every(bullish);
  const accelDown = accelFast && accelBodies && accelSlice.every(bearish);

  /**
   * Gate M5 comune a tutti i setup.
   * - M5 contrario alla direzione: blocco sempre.
   * - M5 allineato: passa.
   * - M5 neutro: passa solo se l'M1 e' chiaramente direzionale, al livello richiesto dal setup
   *   ("accelerata" = struttura + accelerazione, "struttura" = solo EMA allineate + prezzo dal lato giusto,
   *   "libera" = nessun requisito extra, comportamento storico del liquidity sweep).
   * Restituisce null se il gate passa, altrimenti il motivo del blocco.
   */
  const m5Gate = (direction: "BUY" | "SELL", level: "accelerata" | "struttura" | "libera"): string | null => {
    if (direction === "BUY" && trendDown) return "trend M5 ribassista contrario al long";
    if (direction === "SELL" && trendUp) return "trend M5 rialzista contrario allo short";
    const aligned = (direction === "BUY" && trendUp) || (direction === "SELL" && trendDown);
    if (aligned || level === "libera") return null;
    const structure = direction === "BUY" ? alignedUp && priceAbove : alignedDown && priceBelow;
    if (!structure) {
      const emaOk = direction === "BUY" ? alignedUp : alignedDown;
      return `M5 neutro e M1 non direzionale (${emaOk ? "prezzo non dal lato giusto delle EMA M1" : `EMA9/EMA20 M1 non allineate da ${alignBars} candele`})`;
    }
    if (level === "struttura") return null;
    const accel = direction === "BUY" ? accelUp : accelDown;
    if (!accel) {
      const missing = !accelFast
        ? `range medio ${accelRangeAvg.toFixed(2)}$ < ${(atr1 * accelAtrMult).toFixed(2)}$`
        : !accelBodies ? `corpi sotto il ${(accelBodyMin * 100).toFixed(0)}% del range` : "candele non tutte nella stessa direzione";
      return `M5 neutro senza accelerazione M1 su ${accelBars} candele (${missing})`;
    }
    return null;
  };

  // --- Anti-accumulo: blocca solo il range sporco. ---
  // Range sporco = ampiezza delle ultime RANGE_LOOKBACK candele sotto RANGE_ATR_MULT * ATR M1
  // con EMA9 ed EMA20 M1 piatte. Con accelerazione M1 reale il filtro non blocca mai.
  const rangeLookback = envI("RANGE_LOOKBACK", 12, 4, 60);
  const rangeBars = m1.slice(m1.length - rangeLookback);
  const rangeHigh = Math.max(...rangeBars.map(c => c.high));
  const rangeLow = Math.min(...rangeBars.map(c => c.low));
  const rangeWidth = rangeHigh - rangeLow;
  const rangeAtrMult = envN("RANGE_ATR_MULT", 1.5);
  const slopeBars = envI("EMA_SLOPE_BARS", 5, 2, 30);
  const flatSlopeAtr = envN("EMA_FLAT_SLOPE_ATR", 0.12);
  const slopeOf = (series: (number | null)[]) => {
    const head = series[m1.length - 1], tail = series[m1.length - 1 - slopeBars];
    return head === null || head === undefined || tail === null || tail === undefined ? null : Math.abs(head - tail);
  };
  const fastSlope = slopeOf(fast1Series), slowSlope = slopeOf(slow1Series);
  const emaFlat = fastSlope !== null && slowSlope !== null
    && fastSlope <= atr1 * flatSlopeAtr && slowSlope <= atr1 * flatSlopeAtr;
  const rangeCompressed = rangeWidth < atr1 * rangeAtrMult && emaFlat;
  if (rangeCompressed && !accelUp && !accelDown) {
    const reason = `Range M1 sporco: ampiezza ${rangeWidth.toFixed(2)}$ su ${rangeLookback} candele sotto ${(atr1 * rangeAtrMult).toFixed(2)}$`
      + ` con EMA9/EMA20 piatte (pendenza ${fastSlope!.toFixed(2)}$/${slowSlope!.toFixed(2)}$ su ${slopeBars} candele) e nessuna accelerazione M1.`;
    return no(reason, blockedByFilter(reason));
  }

  // --- Valutazione dei setup. Tutti vengono sempre valutati e tracciati; vince il primo valido
  //     nell'ordine di priorita': liquidity_sweep -> momentum_breakout -> breakout_retest -> micro_pullback. ---
  type Candidate = { setup: ScalperSetup; direction: "BUY" | "SELL"; structureStop: number };
  const evaluations: SetupEvaluation[] = [];
  const candidates: Candidate[] = [];
  const record = (setup: ScalperSetup, status: "triggered" | "rejected", reason: string, direction?: "BUY" | "SELL") => {
    evaluations.push(direction ? { setup, status, direction, reason } : { setup, status, reason });
  };
  const breakoutLookback = envI("BREAKOUT_LOOKBACK", 12, 5, 60);
  const breakoutBody = bodyRatio(prev);

  // 1) Sweep di liquidita' sui minimi/massimi recenti (finestra storica invariata).
  {
    let low = Infinity, high = -Infinity;
    for (let i = Math.max(0, m1.length - 10); i < Math.max(0, m1.length - 2); i++) {
      low = Math.min(low, m1[i].low);
      high = Math.max(high, m1[i].high);
    }
    const buy = prev.low < low && prev.close > low && last.close > prev.high && bullish(last);
    const sell = prev.high > high && prev.close < high && last.close < prev.low && bearish(last);
    if (!buy && !sell) {
      record("liquidity_sweep", "rejected", `nessuno sweep dei minimi ${low.toFixed(2)}$ / massimi ${high.toFixed(2)}$ con rientro`);
    } else {
      const direction = buy ? "BUY" : "SELL";
      const blocked = m5Gate(direction, "libera");
      if (blocked) record("liquidity_sweep", "rejected", blocked, direction);
      else {
        const structureStop = direction === "BUY" ? prev.low - 0.25 : prev.high + 0.25;
        candidates.push({ setup: "liquidity_sweep", direction, structureStop });
        record("liquidity_sweep", "triggered", `sweep ${direction === "BUY" ? "dei minimi" : "dei massimi"} con rientro (M5 ${m5Label})`, direction);
      }
    }
  }

  // 2) Momentum breakout M1: rottura del canale delle ultime BREAKOUT_LOOKBACK candele.
  // La candela di rottura e' l'ultima M1 chiusa (prev): l'ingresso cade quindi sulla candela successiva,
  // cioe' quella in corso, e lo stop struttura va sotto/sopra la candela di rottura.
  {
    const bodyMin = envN("BREAKOUT_BODY_RATIO", 0.6);
    const closeMult = envN("BREAKOUT_CLOSE_ATR_MULT", 0.15);
    const maxExtMult = envN("BREAKOUT_MAX_EXT_ATR", 1.5);
    const breakIdx = m1.length - 2;
    const windowStart = breakIdx - breakoutLookback;
    if (windowStart < 0) {
      record("momentum_breakout", "rejected", `storico M1 insufficiente (servono ${breakoutLookback + 2} candele)`);
    } else {
      const window = m1.slice(windowStart, breakIdx);
      const high = Math.max(...window.map(c => c.high));
      const low = Math.min(...window.map(c => c.low));
      const buffer = atr1 * closeMult;
      const brokeUp = bullish(prev) && prev.close >= high + buffer;
      const brokeDown = bearish(prev) && prev.close <= low - buffer;
      if (!brokeUp && !brokeDown) {
        record("momentum_breakout", "rejected",
          `chiusura ${prev.close.toFixed(2)}$ dentro il canale ${breakoutLookback} candele ${low.toFixed(2)}$-${high.toFixed(2)}$ (serve oltre ${buffer.toFixed(2)}$)`);
      } else {
        const direction = brokeUp ? "BUY" : "SELL";
        const emaAt = fast1Series[breakIdx], emaSlowAt = slow1Series[breakIdx];
        const emaOk = emaAt !== null && emaSlowAt !== null && (direction === "BUY" ? emaAt > emaSlowAt : emaAt < emaSlowAt);
        // Conferma sulla candela d'ingresso: il prezzo deve essere ancora oltre il livello rotto.
        const holds = direction === "BUY" ? last.close > high : last.close < low;
        // Distanza fra la chiusura di rottura e il livello: oltre BREAKOUT_MAX_EXT_ATR * ATR
        // il movimento e' gia' andato e non si insegue.
        const extension = direction === "BUY" ? prev.close - high : low - prev.close;
        const maxExtension = atr1 * maxExtMult;
        const missing: string[] = [];
        if (extension > maxExtension) missing.push(`movimento già esteso: chiusura ${extension.toFixed(2)}$ oltre il livello, massimo ${maxExtension.toFixed(2)}$`);
        if (breakoutBody < bodyMin) missing.push(`corpo ${(breakoutBody * 100).toFixed(0)}% sotto il ${(bodyMin * 100).toFixed(0)}% del range`);
        if (!emaOk) missing.push(`EMA9/EMA20 M1 non allineate ${direction}`);
        if (!holds) missing.push(`prezzo rientrato nel canale (${last.close.toFixed(2)}$)`);
        const blocked = m5Gate(direction, "libera");
        if (blocked) missing.push(blocked);
        if (missing.length > 0) record("momentum_breakout", "rejected", missing.join("; "), direction);
        else {
          const structureStop = direction === "BUY" ? prev.low - 0.25 : prev.high + 0.25;
          candidates.push({ setup: "momentum_breakout", direction, structureStop });
          record("momentum_breakout", "triggered",
            `rottura ${direction === "BUY" ? `del massimo ${high.toFixed(2)}$` : `del minimo ${low.toFixed(2)}$`} su ${breakoutLookback} candele con corpo ${(breakoutBody * 100).toFixed(0)}% (M5 ${m5Label})`,
            direction);
        }
      }
    }
  }

  // 3) Breakout retest dopo una candela shock: l'ingresso diretto sulla shock resta scartato,
  // ma se entro RETEST_MAX_BARS candele il prezzo ritraccia verso il livello rotto (o l'EMA9 M1)
  // senza chiuderlo dall'altra parte e riparte nella direzione della shock, si entra al riavvio.
  {
    const retestMaxBars = envI("RETEST_MAX_BARS", 4, 2, 12);
    const retestZoneAtr = envN("RETEST_ZONE_ATR", 0.5);
    const entryIdx = m1.length - 1;
    // La shock deve essere chiusa da almeno una candela di retest: offset fra 2 e RETEST_MAX_BARS.
    let shockIdx = -1;
    for (let offset = 2; offset <= retestMaxBars; offset++) {
      const index = entryIdx - offset;
      if (index < 1) break;
      if (isShock(m1[index])) { shockIdx = index; break; }
    }
    if (shockIdx < 0) {
      record("breakout_retest", "rejected", `nessuna candela shock (> ${shockThreshold.toFixed(2)}$) nelle ultime ${retestMaxBars} candele M1`);
    } else {
      const shock = m1[shockIdx];
      const direction: "BUY" | "SELL" | null = bullish(shock) ? "BUY" : bearish(shock) ? "SELL" : null;
      const windowStart = Math.max(0, shockIdx - breakoutLookback);
      const window = m1.slice(windowStart, shockIdx);
      const retest = m1.slice(shockIdx + 1, entryIdx);
      if (!direction || window.length < 3 || retest.length < 1) {
        record("breakout_retest", "rejected", "candela shock senza direzione o storico di retest insufficiente");
      } else {
        const level = direction === "BUY" ? Math.max(...window.map(c => c.high)) : Math.min(...window.map(c => c.low));
        const ema9 = fast1Series[entryIdx - 1] ?? fast1!;
        // Zona di retest: il livello rotto oppure l'EMA9 M1, quella piu' vicina al prezzo.
        const anchor = direction === "BUY" ? Math.max(level, ema9) : Math.min(level, ema9);
        const zone = atr1 * retestZoneAtr;
        const retestLow = Math.min(...retest.map(c => c.low));
        const retestHigh = Math.max(...retest.map(c => c.high));
        const broke = direction === "BUY" ? shock.close > level : shock.close < level;
        const pulled = direction === "BUY" ? retestLow <= anchor + zone : retestHigh >= anchor - zone;
        const heldLevel = direction === "BUY"
          ? retest.every(c => c.close > level) && last.close > level
          : retest.every(c => c.close < level) && last.close < level;
        // Riavvio: candela d'ingresso nella direzione della shock, con corpo pieno,
        // che recupera oltre la chiusura del retest e resta dal lato giusto dell'EMA9 M1.
        const restartBody = envN("RETEST_BODY_RATIO", 0.5);
        const restart = bodyRatio(last) >= restartBody && (direction === "BUY"
          ? bullish(last) && last.close > prev.close && last.close > ema9
          : bearish(last) && last.close < prev.close && last.close < ema9);
        const missing: string[] = [];
        if (!broke) missing.push(`la shock non ha rotto il livello ${level.toFixed(2)}$`);
        if (!pulled) missing.push(`nessun ritracciamento verso ${anchor.toFixed(2)}$ (min/max retest ${(direction === "BUY" ? retestLow : retestHigh).toFixed(2)}$)`);
        if (!heldLevel) missing.push(`livello ${level.toFixed(2)}$ chiuso dall'altra parte durante il retest`);
        if (!restart) missing.push(`nessun riavvio ${direction} oltre ${prev.close.toFixed(2)}$ con corpo pieno dal lato giusto dell'EMA9`);
        const blocked = m5Gate(direction, "libera");
        if (blocked) missing.push(blocked);
        if (missing.length > 0) record("breakout_retest", "rejected", missing.join("; "), direction);
        else {
          const structureStop = direction === "BUY"
            ? Math.min(retestLow, last.low) - 0.25
            : Math.max(retestHigh, last.high) + 0.25;
          candidates.push({ setup: "breakout_retest", direction, structureStop });
          record("breakout_retest", "triggered",
            `retest del livello ${level.toFixed(2)}$ dopo shock ${(shock.high - shock.low).toFixed(2)}$ e riavvio ${direction} (M5 ${m5Label})`,
            direction);
        }
      }
    }
  }

  // 4) Micro-pullback sull'EMA9 M1.
  {
    const buy = prev.low <= fast1! && last.close > fast1! && bullish(last) && last.close > prev.close;
    const sell = prev.high >= fast1! && last.close < fast1! && bearish(last) && last.close < prev.close;
    if (!buy && !sell) {
      record("micro_pullback", "rejected", `nessun rientro su EMA9 M1 ${fast1!.toFixed(2)}$ con candela di ripartenza`);
    } else {
      const direction = buy ? "BUY" : "SELL";
      const blocked = m5Gate(direction, "accelerata");
      if (blocked) record("micro_pullback", "rejected", blocked, direction);
      else {
        const structureStop = direction === "BUY" ? Math.min(prev.low, last.low) - 0.25 : Math.max(prev.high, last.high) + 0.25;
        candidates.push({ setup: "micro_pullback", direction, structureStop });
        record("micro_pullback", "triggered", `rientro su EMA9 M1 e ripartenza ${direction} (M5 ${m5Label})`, direction);
      }
    }
  }

  const chosen = candidates[0];
  if (!chosen) {
    return no(
      `Nessun trigger scalper M1. Contesto M5 ${m5Label}; ATR M1 ${atr1.toFixed(2)}$. `
      + evaluations.map(e => `${e.setup}${e.direction ? ` ${e.direction}` : ""}: ${e.reason}`).join(" | "),
      evaluations,
    );
  }

  const { direction, setup, structureStop } = chosen;
  const entry = direction === "BUY" ? quote.ask : quote.bid;

  // --- Stop dimensionato sull'ATR, mai stretto per rientrare nel massimo. ---
  // La distanza e' il massimo fra struttura del setup, SL_ATR_MULT * ATR M1 e SL_MIN_USD:
  // se il risultato supera SL_MAX_USD il trade viene scartato invece di essere stretto sul rumore.
  const structuralRisk = Math.abs(entry - structureStop);
  const slAtrMult = envN("SL_ATR_MULT", 1.3);
  const slMinUsd = envN("SL_MIN_USD", 3);
  const slMaxUsd = envN("SL_MAX_USD", 8);
  const atrRisk = atr1 * slAtrMult;
  const risk = Math.max(structuralRisk, atrRisk, slMinUsd);
  const rr = envN("TP_RR", 1.5);
  if (risk > slMaxUsd) {
    const detail = `SL troppo ampio: servono ${risk.toFixed(2)}$ (struttura ${structuralRisk.toFixed(2)}$, ATR ${atrRisk.toFixed(2)}$, minimo ${slMinUsd.toFixed(2)}$)`
      + ` sopra il massimo ${slMaxUsd.toFixed(2)}$`;
    const chosenIndex = evaluations.findIndex((item) => item.setup === setup && item.status === "triggered");
    if (chosenIndex >= 0) {
      evaluations[chosenIndex] = { ...evaluations[chosenIndex], status: "rejected", reason: `${evaluations[chosenIndex].reason} — ${detail}` };
    }
    return no(`${detail}. Setup ${setup} ${direction} scartato.`, evaluations);
  }
  const stopLoss = direction === "BUY" ? entry - risk : entry + risk;
  const takeProfit = direction === "BUY" ? entry + risk * rr : entry - risk * rr;
  const slPlan = {
    structural: Number(structuralRisk.toFixed(2)),
    atr: Number(atrRisk.toFixed(2)),
    applied: Number(risk.toFixed(2)),
    minUsd: slMinUsd,
    maxUsd: slMaxUsd,
    rr,
  };

  // Shadow score 0-100: viene registrato ma NON blocca mai un trade.
  const alignedTrend = (direction === "BUY" && trendUp) || (direction === "SELL" && trendDown);
  const trendScore = alignedTrend ? 20 : 12;
  const lastBody = bodyRatio(last);
  const moveAtr = Math.abs(last.close - prev.close) / atr1;
  const triggerScore = setup === "liquidity_sweep"
    ? Math.min(25, 20 + Math.round(Math.min(1, lastBody) * 5))
    : setup === "momentum_breakout"
      ? Math.min(25, 18 + Math.round(Math.min(1, breakoutBody) * 7))
      : setup === "breakout_retest"
        ? Math.min(25, 18 + Math.round(Math.min(1, lastBody) * 7))
        : Math.min(25, 15 + Math.round(Math.min(0.5, moveAtr) * 20));
  const accumulationScore = rangeCompressed ? 10 : 15;
  const atrScore = atr1 >= 1.2 && atr1 <= 3.5 ? 10 : atr1 >= 1.0 && atr1 <= 4.5 ? 8 : 5;
  const spreadRatio = maxSpread > 0 ? quote.spread / maxSpread : 1;
  const spreadScore = spreadRatio <= 0.35 ? 10 : spreadRatio <= 0.6 ? 8 : spreadRatio <= 0.8 ? 6 : 4;
  const structureScore = structuralRisk >= atrRisk
    ? 10
    : structuralRisk >= atrRisk * 0.6 ? 8 : 5;
  const candleScore = lastBody >= 0.65 ? 10 : lastBody >= 0.45 ? 8 : lastBody >= 0.3 ? 6 : 4;
  const qualityScore = Math.min(100, Math.max(0,
    trendScore + triggerScore + accumulationScore + atrScore + spreadScore + structureScore + candleScore,
  ));
  const scoreBreakdown = `trend ${trendScore}, trigger ${triggerScore}, accumulo ${accumulationScore}, ATR ${atrScore}, spread ${spreadScore}, SL ${structureScore}, candela ${candleScore}`;

  return {
    direction, setup, slPlan,
    entry: Number(entry.toFixed(2)), stopLoss: Number(stopLoss.toFixed(2)), takeProfit: Number(takeProfit.toFixed(2)), riskReward: Number(rr.toFixed(2)),
    evaluations,
    reasoning: `${setupLabel(setup)} M1 ${direction}. Contesto M5 ${m5Label}; ATR M1 ${atr1.toFixed(2)}$, spread ${quote.spread.toFixed(2)}$.`
      + ` SL ${risk.toFixed(2)}$ (struttura ${structuralRisk.toFixed(2)}$, ATR x${slAtrMult} ${atrRisk.toFixed(2)}$), TP ${(risk * rr).toFixed(2)}$ a ${rr}R.`
      + ` Shadow score ${qualityScore}/100 (${scoreBreakdown}). [shadow-score:${qualityScore}]`
  };
}

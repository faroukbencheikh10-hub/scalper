// Pure paper/backtest model for dynamic protection in super-scalper mode.
// IMPORTANT: this module performs no MetaApi calls, no broker orders and no database writes.

export type TradeDirection = "BUY" | "SELL";

export type DynamicProtectionConfig = {
  slAtrMult: number;
  slMinUsd: number;
  slMaxUsd: number;
  tpAtrMult: number;
  tpMinUsd: number;
  tpMaxUsd: number;
  spreadMult: number;
  protectAtEur: number;
  trailAtEur: number;
  trailAtrMult: number;
  trailMinUsd: number;
  trailMaxUsd: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function envNumber(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function dynamicProtectionConfig(): DynamicProtectionConfig {
  return {
    slAtrMult: envNumber("QUICK_SL_ATR_MULT", 1.3, 0.1, 10),
    slMinUsd: envNumber("QUICK_SL_MIN_USD", 3, 0.1, 100),
    slMaxUsd: envNumber("QUICK_SL_MAX_USD", 8, 0.1, 100),
    tpAtrMult: envNumber("QUICK_TP_ATR_MULT", 0.8, 0.1, 10),
    tpMinUsd: envNumber("QUICK_TP_MIN_USD", 1.5, 0.1, 100),
    tpMaxUsd: envNumber("QUICK_TP_MAX_USD", 4, 0.1, 100),
    spreadMult: envNumber("QUICK_SPREAD_MULT", 3, 1, 20),
    protectAtEur: envNumber("QUICK_PROTECT_AT_EUR", 2, 0, 1000),
    trailAtEur: envNumber("QUICK_TRAIL_AT_EUR", 3, 0, 1000),
    trailAtrMult: envNumber("QUICK_TRAIL_ATR_MULT", 0.35, 0.05, 5),
    trailMinUsd: envNumber("QUICK_TRAIL_MIN_USD", 0.3, 0.05, 50),
    trailMaxUsd: envNumber("QUICK_TRAIL_MAX_USD", 1.2, 0.05, 50),
  };
}

export function dynamicDistances(
  atrM1: number,
  spreadUsd: number,
  config = dynamicProtectionConfig(),
) {
  const atr = Number.isFinite(atrM1) && atrM1 > 0 ? atrM1 : config.slMinUsd / config.slAtrMult;
  const spread = Number.isFinite(spreadUsd) && spreadUsd >= 0 ? spreadUsd : 0;

  const slDistanceUsd = clamp(
    Math.max(atr * config.slAtrMult, spread * config.spreadMult, config.slMinUsd),
    config.slMinUsd,
    config.slMaxUsd,
  );
  const tpDistanceUsd = clamp(
    Math.max(atr * config.tpAtrMult, spread * config.spreadMult, config.tpMinUsd),
    config.tpMinUsd,
    config.tpMaxUsd,
  );
  const trailDistanceUsd = clamp(
    atr * config.trailAtrMult,
    config.trailMinUsd,
    config.trailMaxUsd,
  );

  return { slDistanceUsd, tpDistanceUsd, trailDistanceUsd };
}

export function initialDynamicLevels(input: {
  direction: TradeDirection;
  entry: number;
  atrM1: number;
  spreadUsd: number;
  config?: DynamicProtectionConfig;
}) {
  const config = input.config ?? dynamicProtectionConfig();
  const distances = dynamicDistances(input.atrM1, input.spreadUsd, config);
  const stopLoss = input.direction === "BUY"
    ? input.entry - distances.slDistanceUsd
    : input.entry + distances.slDistanceUsd;
  const takeProfit = input.direction === "BUY"
    ? input.entry + distances.tpDistanceUsd
    : input.entry - distances.tpDistanceUsd;

  return { ...distances, stopLoss, takeProfit };
}

export type ProfitProtectionAction =
  | { kind: "hold"; stopLoss: number }
  | { kind: "protect"; stopLoss: number }
  | { kind: "trail"; stopLoss: number };

/**
 * Paper/backtest-only SL movement model.
 * - profit < protectAtEur: keep the existing SL.
 * - profit >= protectAtEur (default +2 EUR): move SL immediately to at least breakeven.
 * - profit >= trailAtEur (default +3 EUR): trail behind the live price using ATR, never loosening SL.
 *
 * profitEur is the actual position P&L supplied by the simulator/test harness. This avoids assuming
 * that a fixed XAUUSD price move always equals the same euro profit when lots change.
 */
export function dynamicProfitProtection(input: {
  direction: TradeDirection;
  entry: number;
  currentPrice: number;
  currentStopLoss: number;
  profitEur: number;
  atrM1: number;
  spreadUsd: number;
  config?: DynamicProtectionConfig;
}): ProfitProtectionAction {
  const config = input.config ?? dynamicProtectionConfig();
  const { trailDistanceUsd } = dynamicDistances(input.atrM1, input.spreadUsd, config);

  if (!(input.profitEur >= config.protectAtEur)) {
    return { kind: "hold", stopLoss: input.currentStopLoss };
  }

  if (input.profitEur < config.trailAtEur) {
    const breakeven = input.entry;
    const next = input.direction === "BUY"
      ? Math.max(input.currentStopLoss, breakeven)
      : Math.min(input.currentStopLoss, breakeven);
    return { kind: "protect", stopLoss: next };
  }

  const candidate = input.direction === "BUY"
    ? input.currentPrice - trailDistanceUsd
    : input.currentPrice + trailDistanceUsd;
  const protectedCandidate = input.direction === "BUY"
    ? Math.max(input.entry, candidate)
    : Math.min(input.entry, candidate);
  const next = input.direction === "BUY"
    ? Math.max(input.currentStopLoss, protectedCandidate)
    : Math.min(input.currentStopLoss, protectedCandidate);

  return { kind: "trail", stopLoss: next };
}

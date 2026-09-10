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
    Math.max(atr * config.trailAtrMult, spread * config.spreadMult),
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

export type DynamicStopAction = {
  kind: "trail";
  stopLoss: number;
};

/**
 * Paper/backtest-only dynamic SL model with NO minimum profit objective.
 *
 * The SL is recalculated on every price update from ATR M1 + spread and can tighten immediately.
 * It never loosens: a BUY stop can only move upward; a SELL stop can only move downward.
 * There is no +2 EUR / +3 EUR activation threshold and no fixed profit target required before
 * protection begins. If the computed trailing level is not better than the existing SL, it stays put.
 */
export function dynamicProfitProtection(input: {
  direction: TradeDirection;
  entry: number;
  currentPrice: number;
  currentStopLoss: number;
  atrM1: number;
  spreadUsd: number;
  config?: DynamicProtectionConfig;
}): DynamicStopAction {
  const config = input.config ?? dynamicProtectionConfig();
  const { trailDistanceUsd } = dynamicDistances(input.atrM1, input.spreadUsd, config);

  const candidate = input.direction === "BUY"
    ? input.currentPrice - trailDistanceUsd
    : input.currentPrice + trailDistanceUsd;

  const next = input.direction === "BUY"
    ? Math.max(input.currentStopLoss, candidate)
    : Math.min(input.currentStopLoss, candidate);

  return { kind: "trail", stopLoss: next };
}

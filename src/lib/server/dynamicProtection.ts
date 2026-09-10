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

  const requiredSlDistanceUsd = Math.max(
    atr * config.slAtrMult,
    spread * config.spreadMult,
    config.slMinUsd,
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

  return {
    requiredSlDistanceUsd,
    slDistanceUsd: Math.min(requiredSlDistanceUsd, config.slMaxUsd),
    tpDistanceUsd,
    trailDistanceUsd,
  };
}

export type InitialDynamicLevels = {
  valid: boolean;
  rejectReason: "sl_distance_above_max" | null;
  requiredSlDistanceUsd: number;
  slDistanceUsd: number;
  tpDistanceUsd: number;
  trailDistanceUsd: number;
  stopLoss: number | null;
  takeProfit: number | null;
};

/**
 * Paper/backtest initial plan.
 * SL is the widest requirement from structure + ATR M1 + spread + configured minimum.
 * If that required SL exceeds slMaxUsd the setup is rejected instead of silently tightening risk.
 * TP is calculated once at entry from ATR M1 + spread and is not moved by the trailing model.
 */
export function initialDynamicLevels(input: {
  direction: TradeDirection;
  entry: number;
  atrM1: number;
  spreadUsd: number;
  structuralDistanceUsd?: number | null;
  config?: DynamicProtectionConfig;
}): InitialDynamicLevels {
  const config = input.config ?? dynamicProtectionConfig();
  const base = dynamicDistances(input.atrM1, input.spreadUsd, config);
  const structural = Number(input.structuralDistanceUsd);
  const structuralDistanceUsd = Number.isFinite(structural) && structural > 0 ? structural : 0;
  const requiredSlDistanceUsd = Math.max(base.requiredSlDistanceUsd, structuralDistanceUsd);

  if (requiredSlDistanceUsd > config.slMaxUsd) {
    return {
      valid: false,
      rejectReason: "sl_distance_above_max",
      requiredSlDistanceUsd,
      slDistanceUsd: requiredSlDistanceUsd,
      tpDistanceUsd: base.tpDistanceUsd,
      trailDistanceUsd: base.trailDistanceUsd,
      stopLoss: null,
      takeProfit: null,
    };
  }

  const stopLoss = input.direction === "BUY"
    ? input.entry - requiredSlDistanceUsd
    : input.entry + requiredSlDistanceUsd;
  const takeProfit = input.direction === "BUY"
    ? input.entry + base.tpDistanceUsd
    : input.entry - base.tpDistanceUsd;

  return {
    valid: true,
    rejectReason: null,
    requiredSlDistanceUsd,
    slDistanceUsd: requiredSlDistanceUsd,
    tpDistanceUsd: base.tpDistanceUsd,
    trailDistanceUsd: base.trailDistanceUsd,
    stopLoss,
    takeProfit,
  };
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
 *
 * Deliberately this function does not return or alter takeProfit: TP is fixed at the level calculated
 * at entry, so a favourable move cannot keep pushing the target farther away.
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

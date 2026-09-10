// Pure paper/backtest model for dynamic protection.
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

export type DynamicRejectReason =
  | "invalid_market_data"
  | "invalid_config"
  | "sl_distance_above_max"
  | "tp_distance_above_max";

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

export function validDynamicProtectionConfig(config: DynamicProtectionConfig) {
  const values = Object.values(config);
  return values.every(value => Number.isFinite(value) && value > 0)
    && config.slMinUsd <= config.slMaxUsd
    && config.tpMinUsd <= config.tpMaxUsd
    && config.trailMinUsd <= config.trailMaxUsd;
}

function validMarketData(atrM1: number, spreadUsd: number) {
  return Number.isFinite(atrM1) && atrM1 > 0
    && Number.isFinite(spreadUsd) && spreadUsd >= 0;
}

export type DynamicDistances = {
  valid: boolean;
  rejectReason: "invalid_market_data" | "invalid_config" | null;
  requiredSlDistanceUsd: number | null;
  tpDistanceUsd: number | null;
  trailDistanceUsd: number | null;
};

/**
 * Calculates all distances from live market inputs. Invalid ATR/spread/config never fall back to
 * invented values: the caller must reject/hold instead.
 */
export function dynamicDistances(
  atrM1: number,
  spreadUsd: number,
  config = dynamicProtectionConfig(),
): DynamicDistances {
  if (!validDynamicProtectionConfig(config)) {
    return {
      valid: false,
      rejectReason: "invalid_config",
      requiredSlDistanceUsd: null,
      tpDistanceUsd: null,
      trailDistanceUsd: null,
    };
  }
  if (!validMarketData(atrM1, spreadUsd)) {
    return {
      valid: false,
      rejectReason: "invalid_market_data",
      requiredSlDistanceUsd: null,
      tpDistanceUsd: null,
      trailDistanceUsd: null,
    };
  }

  const requiredSlDistanceUsd = Math.max(
    atrM1 * config.slAtrMult,
    spreadUsd * config.spreadMult,
    config.slMinUsd,
  );
  const tpDistanceUsd = clamp(
    Math.max(atrM1 * config.tpAtrMult, spreadUsd * config.spreadMult, config.tpMinUsd),
    config.tpMinUsd,
    config.tpMaxUsd,
  );
  const trailDistanceUsd = clamp(
    Math.max(atrM1 * config.trailAtrMult, spreadUsd * config.spreadMult),
    config.trailMinUsd,
    config.trailMaxUsd,
  );

  return {
    valid: true,
    rejectReason: null,
    requiredSlDistanceUsd,
    tpDistanceUsd,
    trailDistanceUsd,
  };
}

export type InitialDynamicLevels = {
  valid: boolean;
  rejectReason: DynamicRejectReason | null;
  requiredSlDistanceUsd: number | null;
  slDistanceUsd: number | null;
  tpDistanceUsd: number | null;
  trailDistanceUsd: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
};

/**
 * Paper/backtest initial plan.
 * SL is the widest requirement from structure + ATR M1 + spread + configured minimum.
 * TP is calculated by code from ATR M1 + spread and is fixed after entry.
 * If inputs/config are invalid, or required SL exceeds its maximum, no plan is produced.
 */
export function initialDynamicLevels(input: {
  direction: TradeDirection;
  entry: number;
  atrM1: number;
  spreadUsd: number;
  structuralDistanceUsd?: number | null;
  brokerMinDistanceUsd?: number;
  config?: DynamicProtectionConfig;
}): InitialDynamicLevels {
  const config = input.config ?? dynamicProtectionConfig();
  const base = dynamicDistances(input.atrM1, input.spreadUsd, config);
  const empty = (rejectReason: DynamicRejectReason): InitialDynamicLevels => ({
    valid: false,
    rejectReason,
    requiredSlDistanceUsd: base.requiredSlDistanceUsd,
    slDistanceUsd: null,
    tpDistanceUsd: base.tpDistanceUsd,
    trailDistanceUsd: base.trailDistanceUsd,
    stopLoss: null,
    takeProfit: null,
  });

  if (!Number.isFinite(input.entry) || input.entry <= 0) return empty("invalid_market_data");
  if (!base.valid) return empty(base.rejectReason!);

  const structuralRaw = input.structuralDistanceUsd;
  if (structuralRaw !== undefined && structuralRaw !== null
    && (!Number.isFinite(structuralRaw) || structuralRaw < 0)) return empty("invalid_market_data");
  const structuralDistanceUsd = structuralRaw ?? 0;

  const brokerMinRaw = input.brokerMinDistanceUsd ?? 0;
  if (!Number.isFinite(brokerMinRaw) || brokerMinRaw < 0) return empty("invalid_market_data");

  const requiredSlDistanceUsd = Math.max(base.requiredSlDistanceUsd!, structuralDistanceUsd, brokerMinRaw);
  if (requiredSlDistanceUsd > config.slMaxUsd) {
    return {
      ...empty("sl_distance_above_max"),
      requiredSlDistanceUsd,
    };
  }

  const tpDistanceUsd = Math.max(base.tpDistanceUsd!, brokerMinRaw);
  if (tpDistanceUsd > config.tpMaxUsd) {
    return {
      ...empty("tp_distance_above_max"),
      requiredSlDistanceUsd,
      tpDistanceUsd,
    };
  }

  const stopLoss = input.direction === "BUY"
    ? input.entry - requiredSlDistanceUsd
    : input.entry + requiredSlDistanceUsd;
  const takeProfit = input.direction === "BUY"
    ? input.entry + tpDistanceUsd
    : input.entry - tpDistanceUsd;

  return {
    valid: true,
    rejectReason: null,
    requiredSlDistanceUsd,
    slDistanceUsd: requiredSlDistanceUsd,
    tpDistanceUsd,
    trailDistanceUsd: base.trailDistanceUsd,
    stopLoss,
    takeProfit,
  };
}

export type DynamicStopAction =
  | { kind: "trail"; stopLoss: number }
  | { kind: "hold"; stopLoss: number; reason: "invalid_market_data" | "invalid_config" | "not_improved" };

/**
 * Paper/backtest-only dynamic SL with no minimum profit objective.
 * The SL can tighten immediately and never loosens. TP is deliberately absent from this function:
 * it remains fixed at the code-calculated entry level.
 */
export function dynamicProfitProtection(input: {
  direction: TradeDirection;
  entry: number;
  currentPrice: number;
  currentStopLoss: number;
  atrM1: number;
  spreadUsd: number;
  brokerMinDistanceUsd?: number;
  minImprovementUsd?: number;
  config?: DynamicProtectionConfig;
}): DynamicStopAction {
  const config = input.config ?? dynamicProtectionConfig();
  const distances = dynamicDistances(input.atrM1, input.spreadUsd, config);
  if (!distances.valid) {
    return { kind: "hold", stopLoss: input.currentStopLoss, reason: distances.rejectReason! };
  }
  if (![input.entry, input.currentPrice, input.currentStopLoss].every(Number.isFinite)
    || input.entry <= 0 || input.currentPrice <= 0 || input.currentStopLoss <= 0) {
    return { kind: "hold", stopLoss: input.currentStopLoss, reason: "invalid_market_data" };
  }

  const brokerMinRaw = input.brokerMinDistanceUsd ?? 0;
  const minImprovementRaw = input.minImprovementUsd ?? 0.01;
  if (!Number.isFinite(brokerMinRaw) || brokerMinRaw < 0
    || !Number.isFinite(minImprovementRaw) || minImprovementRaw < 0) {
    return { kind: "hold", stopLoss: input.currentStopLoss, reason: "invalid_market_data" };
  }

  const trailDistanceUsd = Math.max(distances.trailDistanceUsd!, brokerMinRaw);
  const candidate = input.direction === "BUY"
    ? input.currentPrice - trailDistanceUsd
    : input.currentPrice + trailDistanceUsd;
  const improvement = input.direction === "BUY"
    ? candidate - input.currentStopLoss
    : input.currentStopLoss - candidate;

  if (improvement < minImprovementRaw) {
    return { kind: "hold", stopLoss: input.currentStopLoss, reason: "not_improved" };
  }

  return { kind: "trail", stopLoss: candidate };
}

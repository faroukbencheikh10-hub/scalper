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

function validNonNegative(value: number) {
  return Number.isFinite(value) && value >= 0;
}

function validPositive(value: number) {
  return Number.isFinite(value) && value > 0;
}

function decimalPlaces(step: number) {
  const text = step.toString().toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1] ?? 0);
  return (text.split(".")[1] ?? "").length;
}

function normalizeFloat(value: number, tickSizeUsd: number) {
  return Number(value.toFixed(Math.min(12, Math.max(0, decimalPlaces(tickSizeUsd) + 2))));
}

/**
 * Directional tick normalization. Levels are rounded away from entry/current price so
 * quantization never makes the requested protection distance artificially smaller.
 */
export function normalizeLevelToTick(input: {
  direction: TradeDirection;
  kind: "stopLoss" | "takeProfit";
  value: number;
  tickSizeUsd: number;
}) {
  if (!validPositive(input.value) || !validPositive(input.tickSizeUsd)) return null;
  const scaled = input.value / input.tickSizeUsd;
  const roundUp = (input.direction === "BUY" && input.kind === "takeProfit")
    || (input.direction === "SELL" && input.kind === "stopLoss");
  const ticks = roundUp ? Math.ceil(scaled - 1e-10) : Math.floor(scaled + 1e-10);
  return normalizeFloat(ticks * input.tickSizeUsd, input.tickSizeUsd);
}

export function adaptiveMinImprovementUsd(input: {
  spreadUsd: number;
  tickSizeUsd: number;
  floorUsd?: number;
}) {
  const floorUsd = input.floorUsd ?? 0.05;
  if (!validNonNegative(input.spreadUsd) || !validPositive(input.tickSizeUsd) || !validNonNegative(floorUsd)) {
    return null;
  }
  return Math.max(input.tickSizeUsd, input.spreadUsd * 0.25, floorUsd);
}

export type DynamicDistances = {
  valid: boolean;
  rejectReason: "invalid_market_data" | "invalid_config" | null;
  requiredSlDistanceUsd: number | null;
  tpDistanceUsd: number | null;
  trailDistanceUsd: number | null;
};

/**
 * Calculates distances from market inputs. Invalid ATR/spread/config never fall back to
 * invented values: the caller must reject or hold instead.
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
 * SL is the widest requirement from structure + ATR M1 + spread + broker minimum.
 * TP is calculated by code from ATR M1 + spread and is fixed after entry.
 * Levels are quantized to tick size in the safe direction. Maxima are strict even after quantization.
 */
export function initialDynamicLevels(input: {
  direction: TradeDirection;
  entry: number;
  atrM1: number;
  spreadUsd: number;
  structuralDistanceUsd?: number | null;
  brokerMinDistanceUsd?: number;
  tickSizeUsd?: number;
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

  if (!validPositive(input.entry)) return empty("invalid_market_data");
  if (!base.valid) return empty(base.rejectReason!);

  const structuralRaw = input.structuralDistanceUsd;
  if (structuralRaw !== undefined && structuralRaw !== null && !validNonNegative(structuralRaw)) {
    return empty("invalid_market_data");
  }
  const structuralDistanceUsd = structuralRaw ?? 0;

  const brokerMinRaw = input.brokerMinDistanceUsd ?? 0;
  const tickSizeUsd = input.tickSizeUsd ?? 0.01;
  if (!validNonNegative(brokerMinRaw) || !validPositive(tickSizeUsd)) return empty("invalid_market_data");

  const requiredSlDistanceUsd = Math.max(base.requiredSlDistanceUsd!, structuralDistanceUsd, brokerMinRaw);
  if (requiredSlDistanceUsd > config.slMaxUsd) {
    return { ...empty("sl_distance_above_max"), requiredSlDistanceUsd };
  }

  const requestedTpDistanceUsd = Math.max(base.tpDistanceUsd!, brokerMinRaw);
  if (requestedTpDistanceUsd > config.tpMaxUsd) {
    return {
      ...empty("tp_distance_above_max"),
      requiredSlDistanceUsd,
      tpDistanceUsd: requestedTpDistanceUsd,
    };
  }

  const rawStopLoss = input.direction === "BUY"
    ? input.entry - requiredSlDistanceUsd
    : input.entry + requiredSlDistanceUsd;
  const rawTakeProfit = input.direction === "BUY"
    ? input.entry + requestedTpDistanceUsd
    : input.entry - requestedTpDistanceUsd;

  const stopLoss = normalizeLevelToTick({
    direction: input.direction,
    kind: "stopLoss",
    value: rawStopLoss,
    tickSizeUsd,
  });
  const takeProfit = normalizeLevelToTick({
    direction: input.direction,
    kind: "takeProfit",
    value: rawTakeProfit,
    tickSizeUsd,
  });
  if (stopLoss === null || takeProfit === null) return empty("invalid_market_data");

  const slDistanceUsd = input.direction === "BUY" ? input.entry - stopLoss : stopLoss - input.entry;
  const tpDistanceUsd = input.direction === "BUY" ? takeProfit - input.entry : input.entry - takeProfit;
  if (slDistanceUsd < brokerMinRaw || tpDistanceUsd < brokerMinRaw) return empty("invalid_market_data");

  // Strict means strict: tick normalization must not be allowed to push either level past its max.
  if (slDistanceUsd > config.slMaxUsd + 1e-9) {
    return { ...empty("sl_distance_above_max"), requiredSlDistanceUsd, slDistanceUsd };
  }
  if (tpDistanceUsd > config.tpMaxUsd + 1e-9) {
    return { ...empty("tp_distance_above_max"), requiredSlDistanceUsd, tpDistanceUsd };
  }

  return {
    valid: true,
    rejectReason: null,
    requiredSlDistanceUsd,
    slDistanceUsd,
    tpDistanceUsd,
    trailDistanceUsd: base.trailDistanceUsd,
    stopLoss,
    takeProfit,
  };
}

export type DynamicStopAction =
  | { kind: "trail"; stopLoss: number; minImprovementUsd: number }
  | {
      kind: "hold";
      stopLoss: number;
      reason: "invalid_market_data" | "invalid_config" | "not_improved" | "rate_limited";
      minImprovementUsd?: number;
    };

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
  tickSizeUsd?: number;
  minImprovementUsd?: number;
  minImprovementFloorUsd?: number;
  nowMs?: number;
  lastUpdateAtMs?: number | null;
  minUpdateIntervalMs?: number;
  config?: DynamicProtectionConfig;
}): DynamicStopAction {
  const config = input.config ?? dynamicProtectionConfig();
  const distances = dynamicDistances(input.atrM1, input.spreadUsd, config);
  if (!distances.valid) {
    return { kind: "hold", stopLoss: input.currentStopLoss, reason: distances.rejectReason! };
  }
  if (![input.entry, input.currentPrice, input.currentStopLoss].every(validPositive)) {
    return { kind: "hold", stopLoss: input.currentStopLoss, reason: "invalid_market_data" };
  }

  const brokerMinRaw = input.brokerMinDistanceUsd ?? 0;
  const tickSizeUsd = input.tickSizeUsd ?? 0.01;
  const intervalMs = input.minUpdateIntervalMs ?? 350;
  if (!validNonNegative(brokerMinRaw) || !validPositive(tickSizeUsd) || !validNonNegative(intervalMs)) {
    return { kind: "hold", stopLoss: input.currentStopLoss, reason: "invalid_market_data" };
  }

  const adaptive = adaptiveMinImprovementUsd({
    spreadUsd: input.spreadUsd,
    tickSizeUsd,
    floorUsd: input.minImprovementFloorUsd ?? 0.05,
  });
  const minImprovementUsd = input.minImprovementUsd ?? adaptive;
  if (minImprovementUsd === null || !validNonNegative(minImprovementUsd)) {
    return { kind: "hold", stopLoss: input.currentStopLoss, reason: "invalid_market_data" };
  }

  if (input.lastUpdateAtMs !== undefined && input.lastUpdateAtMs !== null) {
    const nowMs = input.nowMs ?? Date.now();
    if (!Number.isFinite(nowMs) || !Number.isFinite(input.lastUpdateAtMs) || nowMs < input.lastUpdateAtMs) {
      return { kind: "hold", stopLoss: input.currentStopLoss, reason: "invalid_market_data", minImprovementUsd };
    }
    if (nowMs - input.lastUpdateAtMs < intervalMs) {
      return { kind: "hold", stopLoss: input.currentStopLoss, reason: "rate_limited", minImprovementUsd };
    }
  }

  const trailDistanceUsd = Math.max(distances.trailDistanceUsd!, brokerMinRaw);
  const rawCandidate = input.direction === "BUY"
    ? input.currentPrice - trailDistanceUsd
    : input.currentPrice + trailDistanceUsd;
  const candidate = normalizeLevelToTick({
    direction: input.direction,
    kind: "stopLoss",
    value: rawCandidate,
    tickSizeUsd,
  });
  if (candidate === null) {
    return { kind: "hold", stopLoss: input.currentStopLoss, reason: "invalid_market_data", minImprovementUsd };
  }

  const actualDistance = input.direction === "BUY"
    ? input.currentPrice - candidate
    : candidate - input.currentPrice;
  if (actualDistance + 1e-9 < brokerMinRaw) {
    return { kind: "hold", stopLoss: input.currentStopLoss, reason: "invalid_market_data", minImprovementUsd };
  }

  const improvement = input.direction === "BUY"
    ? candidate - input.currentStopLoss
    : input.currentStopLoss - candidate;
  if (improvement + 1e-9 < minImprovementUsd) {
    return { kind: "hold", stopLoss: input.currentStopLoss, reason: "not_improved", minImprovementUsd };
  }

  return { kind: "trail", stopLoss: candidate, minImprovementUsd };
}

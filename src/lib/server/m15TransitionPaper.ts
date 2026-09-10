export type BiasM5 = "up" | "down" | "flat";
export type M15Structure = "trend_up" | "trend_down" | "unclear";
export type M15PaperRegime = "trend_up" | "trend_down" | "true_range" | "transition" | "invalid";

export type M15PaperInput = {
  biasM5: BiasM5;
  structure: M15Structure;
  m15BandAtr: number;
  maxBandAtr: number;
  priceInsideRangeBand: boolean;
  breakoutRecent: boolean;
};

export type PaperGateDecision = {
  allowed: "BUY" | "SELL" | null;
  regime: M15PaperRegime;
  reason: string;
};

/**
 * Paper/backtest-only model for the M5/M15 grey zone.
 *
 * Current live code collapses two different situations into m15_state=range:
 * 1) a genuinely compressed M15 range;
 * 2) a wide M15 band with no confirmed HH/HL or LL/LH structure yet.
 *
 * This model keeps them separate. It is intentionally NOT wired into the
 * production strategy, worker, MetaApi or Railway execution path.
 */
export function classifyM15PaperRegime(input: Pick<M15PaperInput,
  "structure" | "m15BandAtr" | "maxBandAtr" | "priceInsideRangeBand">): M15PaperRegime {
  if (!Number.isFinite(input.m15BandAtr) || input.m15BandAtr < 0
    || !Number.isFinite(input.maxBandAtr) || input.maxBandAtr <= 0) return "invalid";

  const compressed = input.m15BandAtr <= input.maxBandAtr;

  // A real compressed range has priority over apparent swing structure while price remains inside.
  // This preserves the anti-range protection instead of allowing a directional setup inside compression.
  if (compressed && input.priceInsideRangeBand) return "true_range";

  if (input.structure === "trend_up") return "trend_up";
  if (input.structure === "trend_down") return "trend_down";
  return "transition";
}

/**
 * Proposed paper gate for m1_short:
 * - invalid M15 metrics: fail closed;
 * - flat M5: no directional short setup;
 * - true M15 range: keep blocking m1_short;
 * - confirmed M15 trend opposite M5: block;
 * - recent M15 breakout: keep the existing anti-chase block;
 * - transition: M5 directional bias is allowed to carry the setup.
 */
export function evaluateShortContextPaper(input: M15PaperInput): PaperGateDecision {
  const regime = classifyM15PaperRegime(input);
  const allowed = input.biasM5 === "up" ? "BUY" : input.biasM5 === "down" ? "SELL" : null;

  if (regime === "invalid") return { allowed: null, regime, reason: "m15 metrics invalid" };
  if (!allowed) return { allowed: null, regime, reason: "bias_m5=flat" };
  if (regime === "true_range") return { allowed: null, regime, reason: "m15=true_range" };
  if (allowed === "BUY" && regime === "trend_down") {
    return { allowed: null, regime, reason: "m15 trend_down contrario al bias M5 BUY" };
  }
  if (allowed === "SELL" && regime === "trend_up") {
    return { allowed: null, regime, reason: "m15 trend_up contrario al bias M5 SELL" };
  }
  if (input.breakoutRecent) return { allowed: null, regime, reason: "m15_breakout_recent=true" };

  return {
    allowed,
    regime,
    reason: regime === "transition"
      ? `M15 transition: bias M5 ${allowed} ammesso`
      : `M15 ${regime}: bias M5 ${allowed} confermato`,
  };
}

/** Paper model for m1_range: only a real compressed range with flat M5 qualifies. */
export function evaluateRangeContextPaper(input: M15PaperInput): PaperGateDecision {
  const regime = classifyM15PaperRegime(input);
  if (regime === "invalid") return { allowed: null, regime, reason: "m15 metrics invalid" };
  if (input.breakoutRecent) return { allowed: null, regime, reason: "m15_breakout_recent=true" };
  if (input.biasM5 !== "flat") return { allowed: null, regime, reason: `bias_m5=${input.biasM5}` };
  if (regime !== "true_range") return { allowed: null, regime, reason: `m15=${regime}, non true_range` };
  return { allowed: null, regime, reason: "m1_range context ok" };
}

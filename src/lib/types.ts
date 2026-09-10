export type Direction = "BUY" | "SELL" | "NO_TRADE";

export type Candle = {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type Quote = {
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  quotedAt: number | null;
};

export type ScalperSetup = "liquidity_sweep" | "momentum_breakout" | "breakout_retest" | "micro_pullback" | "m1_short" | "m1_range";

/** Diagnostica di un singolo tick: cosa e' stato valutato e perche' e' stato scartato. */
export type SetupEvaluation = {
  /**
   * Setup valutato, "m15_gate" per il contesto M15/M5 della mtf, "context_gate" per il contesto
   * M5/M15 di m1_short e m1_range o "filtri" per i blocchi di protezione a monte.
   */
  setup: ScalperSetup | "filtri" | "m15_gate" | "m1_gate" | "range_gate" | "context_gate";
  status: "triggered" | "rejected";
  direction?: "BUY" | "SELL";
  reason: string;
};

/** Bias M5 e stato M15 letti a ogni tick prima di valutare m1_short e m1_range. */
export type MarketContext = {
  biasM5: "up" | "down" | "flat";
  m15State: "trend_up" | "trend_down" | "range";
  m15BreakoutRecent: boolean;
  /** EMA20 M5 sull'ultima M5 chiusa e cinque candele prima. */
  ema20M5: number;
  ema20M5Before: number;
  closeM5: number;
  m15BandWidth: number;
  m15BandAtr: number;
  atr15: number;
  /** Riassunto numerico riportato nella voce context_gate. */
  detail: string;
};

/** Come e' stata costruita la distanza di stop del segnale. */
export type ScalperSlPlan = {
  estimatedCostPrice?: number;
  /** R:R netto minimo richiesto. Assente sui setup con TP fisso, indipendente dallo SL. */
  minNetR?: number;
  /** Limiti del TP quando e' dimensionato a se' (setup m1_short). */
  tpMinUsd?: number;
  tpMaxUsd?: number;
  /** Distanza SL richiesta dalla struttura del setup. */
  structural: number;
  /** Distanza SL richiesta dall'ATR M1 (SL_ATR_MULT * ATR). */
  atr: number;
  /** Distanza SL effettivamente applicata. */
  applied: number;
  minUsd: number;
  maxUsd: number;
  rr: number;
};

export type ScalperSignal = {
  /** Stable identity of the M5 impulse and pullback; only execution reserves it. */
  setupKey: string | null;
  direction: Direction;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  setup: ScalperSetup | null;
  slPlan: ScalperSlPlan | null;
  reasoning: string;
  /** Elenco completo dei setup valutati nel tick, con il motivo dello scarto. */
  evaluations: SetupEvaluation[];
};

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

export type ScalperSetup = "liquidity_sweep" | "momentum_breakout" | "breakout_retest" | "micro_pullback" | "m1_short";

/** Diagnostica di un singolo tick: cosa e' stato valutato e perche' e' stato scartato. */
export type SetupEvaluation = {
  /** Setup valutato, "m15_gate" per il contesto M15/M5 o "filtri" per i blocchi di protezione a monte. */
  setup: ScalperSetup | "filtri" | "m15_gate" | "m1_gate";
  status: "triggered" | "rejected";
  direction?: "BUY" | "SELL";
  reason: string;
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

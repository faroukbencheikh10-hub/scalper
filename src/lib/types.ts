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

export type ScalperSetup = "liquidity_sweep" | "momentum_breakout" | "breakout_retest" | "micro_pullback";

/** Diagnostica di un singolo tick: cosa e' stato valutato e perche' e' stato scartato. */
export type SetupEvaluation = {
  /** Nome del setup valutato oppure "filtri" per i blocchi di protezione a monte. */
  setup: ScalperSetup | "filtri";
  status: "triggered" | "rejected";
  direction?: "BUY" | "SELL";
  reason: string;
};

/** Come e' stata costruita la distanza di stop del segnale. */
export type ScalperSlPlan = {
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

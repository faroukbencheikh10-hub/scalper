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

export type ScalperSetup = "micro_pullback" | "liquidity_sweep" | "momentum_breakout";

/** Diagnostica di un singolo tick: cosa e' stato valutato e perche' e' stato scartato. */
export type SetupEvaluation = {
  /** Nome del setup valutato oppure "filtri" per i blocchi di protezione a monte. */
  setup: ScalperSetup | "filtri";
  status: "triggered" | "rejected";
  direction?: "BUY" | "SELL";
  reason: string;
};

export type ScalperSignal = {
  direction: Direction;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  setup: ScalperSetup | null;
  reasoning: string;
  /** Elenco completo dei setup valutati nel tick, con il motivo dello scarto. */
  evaluations: SetupEvaluation[];
};

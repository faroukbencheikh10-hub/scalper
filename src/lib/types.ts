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

export type ScalperSignal = {
  direction: Direction;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  setup: "micro_pullback" | "liquidity_sweep" | null;
  reasoning: string;
};

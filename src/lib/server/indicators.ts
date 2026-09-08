import type { Candle } from "@/lib/types";

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

export function emaClose(candles: Candle[], period: number): number | null {
  if (candles.length < period) return null;
  const k = 2 / (period + 1);
  let value = 0;
  for (let i = 0; i < period; i++) value += candles[i].close;
  value /= period;
  for (let i = period; i < candles.length; i++) value = candles[i].close * k + value * (1 - k);
  return value;
}

export function atr(candles: Candle[], period = 14, ordered = false): number | null {
  if (candles.length < period + 1) return null;
  const bars = ordered ? candles : [...candles].sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
  let out = 0;
  for (let i = 1; i <= period; i++) {
    const c = bars[i], p = bars[i - 1];
    out += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  out /= period;
  for (let i = period + 1; i < bars.length; i++) {
    const c = bars[i], p = bars[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    out = (out * (period - 1) + tr) / period;
  }
  return Number(out.toFixed(3));
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

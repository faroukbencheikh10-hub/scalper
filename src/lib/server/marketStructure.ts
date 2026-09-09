import type { Candle } from "../types";

export const MINUTE = 60_000;

/** Never fill gaps or accept duplicate, unordered, malformed or off-grid bars. */
export function closedBars(bars: Candle[], minutes: number, nowMs: number): Candle[] | null {
  const size = minutes * MINUTE;
  let previous = -Infinity;
  const result: Candle[] = [];
  for (const bar of bars) {
    const time = Date.parse(bar.datetime);
    if (!Number.isFinite(time) || time <= previous || time % size !== 0
      || ![bar.open, bar.high, bar.low, bar.close].every(v => Number.isFinite(v) && v > 0)
      || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)
      || bar.high < bar.low || time > nowMs) return null;
    previous = time;
    if (time + size <= nowMs) result.push(bar);
  }
  return result;
}

/** Three consecutive closed M5 candles form one complete M15. */
export function aggregateM15(m5: Candle[]): Candle[] {
  const result: Candle[] = [];
  for (let i = 0; i + 2 < m5.length; i++) {
    const a = m5[i], b = m5[i + 1], c = m5[i + 2];
    const start = Date.parse(a.datetime);
    if (start % (15 * MINUTE) !== 0 || Date.parse(b.datetime) !== start + 5 * MINUTE
      || Date.parse(c.datetime) !== start + 10 * MINUTE) continue;
    result.push({ datetime: a.datetime, open: a.open, high: Math.max(a.high, b.high, c.high),
      low: Math.min(a.low, b.low, c.low), close: c.close });
    i += 2;
  }
  return result;
}

export function recentBarsReady(bars: Candle[], minutes: number, count: number, nowMs: number) {
  const recent = bars.slice(-count), size = minutes * MINUTE;
  if (recent.length < count || Date.parse(recent.at(-1)!.datetime) + size !== Math.floor(nowMs / size) * size) return false;
  return recent.every((bar, i) => i === 0 || Date.parse(bar.datetime) - Date.parse(recent[i - 1].datetime) === size);
}

/** Two closed bars on either side: no pivot using future/unclosed prices. */
export function swingLevels(bars: Candle[], direction: "BUY" | "SELL") {
  const levels: number[] = [];
  for (let i = 2; i < bars.length - 2; i++) {
    const nearby = [...bars.slice(i - 2, i), ...bars.slice(i + 1, i + 3)];
    if (direction === "BUY" && nearby.every(b => bars[i].high > b.high)) levels.push(bars[i].high);
    if (direction === "SELL" && nearby.every(b => bars[i].low < b.low)) levels.push(bars[i].low);
  }
  return levels;
}

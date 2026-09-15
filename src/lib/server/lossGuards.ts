// Blocchi da perdita per strumento: LOSS_LOCK_MINUTES sulla direzione e la pausa dopo
// CONSEC_LOSS_COUNT perdite consecutive. Una serie di perdite su uno strumento non deve fermare
// l'altro, quindi il calcolo e' per simbolo e i gruppi non si parlano mai.
//
// Funzione pura: il worker le passa le chiusure gia' lette dal database, gli scenari offline le
// passano righe costruite a mano.
import { countsAsLoss } from "./positionManager";
import { resolveTradedSymbol, type TradedSymbol } from "../symbols";

export type ClosureRow = {
  symbol?: string | null;
  direction?: string | null;
  outcome?: string | null;
  close_reason?: string | null;
  mt5_profit?: unknown;
  closed_at?: unknown;
};

export type DirectionLocks = Record<"BUY" | "SELL", number>;
export type SymbolLossGuards = { locks: DirectionLocks; pauseUntil: number };

function closedAtMs(value: unknown) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Chiusure ordinate dalla piu' recente alla piu' vecchia, come le restituisce la query del worker.
 * Solo sl_initial in perdita conta: breakeven, trailing, flatten, stop e watchdog non bloccano nulla.
 */
export function lossGuardsFromClosures(
  rows: ClosureRow[],
  options: { lossLockMs: number; consecLossPauseMs: number; consecLossCount: number },
): Map<TradedSymbol, SymbolLossGuards> {
  const bySymbol = new Map<TradedSymbol, ClosureRow[]>();
  for (const row of rows) {
    const target = resolveTradedSymbol(row.symbol);
    const bucket = bySymbol.get(target) ?? [];
    bucket.push(row);
    bySymbol.set(target, bucket);
  }

  const out = new Map<TradedSymbol, SymbolLossGuards>();
  for (const [target, symbolRows] of bySymbol) {
    const locks: DirectionLocks = { BUY: 0, SELL: 0 };
    for (const row of symbolRows) {
      if (!countsAsLoss(row.outcome ?? undefined, row.close_reason ?? undefined, row.mt5_profit)) continue;
      const direction = row.direction === "BUY" || row.direction === "SELL" ? row.direction : null;
      if (!direction || locks[direction] > 0) continue;
      locks[direction] = closedAtMs(row.closed_at) + options.lossLockMs;
    }
    let pauseUntil = 0, streak = 0;
    for (const row of symbolRows) {
      if (!countsAsLoss(row.outcome ?? undefined, row.close_reason ?? undefined, row.mt5_profit)) break;
      streak += 1;
      if (streak >= options.consecLossCount) {
        pauseUntil = closedAtMs(symbolRows[0]?.closed_at) + options.consecLossPauseMs;
        break;
      }
    }
    out.set(target, { locks, pauseUntil });
  }
  return out;
}

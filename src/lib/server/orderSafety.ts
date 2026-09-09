export type RecoveryPosition = { id: string; symbol: string; clientId?: string; openPrice: number; volume?: number };
export type RecoveryDeal = { clientId?: string; symbol?: string; positionId?: string; orderId?: string; price?: number; volume?: number; entryType?: string };

export function recoverOrder(clientId: string, symbol: string, positions: RecoveryPosition[], deals: RecoveryDeal[]) {
  const position = positions.find(p => p.clientId === clientId && p.symbol === symbol);
  if (position) return { positionId: position.id, openPrice: position.openPrice, volume: position.volume ?? null, orderId: null };
  const deal = deals.find(d => d.clientId === clientId && d.symbol === symbol && d.positionId && d.entryType === "DEAL_ENTRY_IN");
  return deal ? { positionId: deal.positionId!, openPrice: deal.price ?? null, volume: deal.volume ?? null, orderId: deal.orderId ?? null } : null;
}

/** A timeout is ambiguous: keep the setup reserved until broker state reconciles it. */
export function definitelyRejected(error: unknown) {
  const code = Number((error as { numericCode?: number })?.numericCode);
  return [10004, 10006, 10007, 10013, 10014, 10015, 10016, 10017, 10018, 10019, 10020,
    10021, 10022, 10026, 10027, 10030, 10032, 10033, 10034, 10035].includes(code);
}

/** Same tick-value formula used by the SDK for unrealized P/L, in the account currency. */
export function riskPerLot(stopDistance: number, tickSize: number, lossTickValue: number) {
  return [stopDistance, tickSize, lossTickValue].every(v => Number.isFinite(v) && v > 0)
    ? stopDistance / tickSize * lossTickValue : null;
}

export type StaleQuoteAction = "idle" | "reconnect" | "exit";

export type StaleQuoteDecisionInput = {
  active: boolean;
  nowMs: number;
  lastQuoteReceivedAtMs: number | null;
  sessionStartAtMs: number | null;
  fallbackStartAtMs: number;
  staleQuoteSec: number;
  staleQuoteExitSec: number;
};

function finiteMs(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function effectiveQuoteAgeSec(
  nowMs: number,
  lastQuoteReceivedAtMs: number | null,
  sessionStartAtMs: number | null,
  fallbackStartAtMs: number,
) {
  const refs = [
    finiteMs(lastQuoteReceivedAtMs),
    finiteMs(sessionStartAtMs),
    finiteMs(fallbackStartAtMs),
  ].filter((value): value is number => value !== null);
  if (refs.length === 0) return null;
  return Math.max(0, Math.floor((nowMs - Math.max(...refs)) / 1000));
}

export function staleQuoteDecision(input: StaleQuoteDecisionInput): {
  action: StaleQuoteAction;
  quoteAgeSec: number | null;
} {
  if (!input.active) return { action: "idle", quoteAgeSec: null };
  const quoteAgeSec = effectiveQuoteAgeSec(
    input.nowMs,
    input.lastQuoteReceivedAtMs,
    input.sessionStartAtMs,
    input.fallbackStartAtMs,
  );
  if (quoteAgeSec === null) return { action: "idle", quoteAgeSec: null };
  if (quoteAgeSec > input.staleQuoteExitSec) return { action: "exit", quoteAgeSec };
  if (quoteAgeSec > input.staleQuoteSec) return { action: "reconnect", quoteAgeSec };
  return { action: "idle", quoteAgeSec };
}

export type ParsedWorkerHeartbeat = {
  at: string | null;
  atMs: number | null;
  quoteAgeSec: number | null;
};

function finiteQuoteAge(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

export function encodeWorkerHeartbeat(at: Date, quoteAgeSec: unknown) {
  return JSON.stringify({
    at: at.toISOString(),
    quoteAgeSec: finiteQuoteAge(quoteAgeSec),
  });
}

/** Accepts the new JSON payload and the legacy ISO string during rolling deploys. */
export function parseWorkerHeartbeat(value: string | undefined): ParsedWorkerHeartbeat {
  if (!value) return { at: null, atMs: null, quoteAgeSec: null };
  let at = value;
  let quoteAgeSec: number | null = null;
  try {
    const parsed = JSON.parse(value) as { at?: unknown; quoteAgeSec?: unknown };
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.at === "string") at = parsed.at;
      quoteAgeSec = finiteQuoteAge(parsed.quoteAgeSec);
    }
  } catch {
    // Legacy heartbeat was a plain ISO timestamp.
  }
  const parsedAt = Date.parse(at);
  return {
    at: Number.isFinite(parsedAt) ? new Date(parsedAt).toISOString() : null,
    atMs: Number.isFinite(parsedAt) ? parsedAt : null,
    quoteAgeSec,
  };
}

export type OperationalState = "LIVE" | "WAITING" | "STOP" | "OFFLINE";

export type OperationalStateInput = {
  systemStopped?: boolean;
  session?: { weekendClosed?: boolean; inFlattenWindow?: boolean };
  stream?: { heartbeat?: string | null };
};

/**
 * WAITING copre solo weekend/flatten (chiusure reali di calendario), mai la sola ora del giorno:
 * SCALPER_HOURS_UTC non gating l'operativita', quindi non deve gating nemmeno questo badge.
 */
export function currentOperationalState(data: OperationalStateInput | null, now: number): OperationalState {
  if (!data) return "OFFLINE";
  if (data.systemStopped) return "STOP";
  const heartbeatMs = data.stream?.heartbeat ? Date.parse(data.stream.heartbeat) : Number.NaN;
  if (!Number.isFinite(heartbeatMs) || now - heartbeatMs >= 60_000) return "OFFLINE";
  if (data.session?.weekendClosed || data.session?.inFlattenWindow) return "WAITING";
  return "LIVE";
}

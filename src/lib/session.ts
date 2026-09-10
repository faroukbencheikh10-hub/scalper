export type SessionConfig = {
  hoursUtc: string;
  flattenBeforeEndMin: number;
  fridayCloseUtc: string;
};

export type SessionStatus = {
  inside: boolean;
  weekendClosed: boolean;
  inFlattenWindow: boolean;
  minutesUntilEnd: number | null;
  sessionStartAt: string | null;
  sessionEndAt: string | null;
  flattenAt: string | null;
  nextStartAt: string | null;
  nextFlattenAt: string | null;
  blockReason: string | null;
};

type ParsedHours = { start: number; end: number; from: string; to: string };
type Occurrence = { start: Date; end: Date; flattenAt: Date };

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseClockMinutes(value: string) {
  const [h, m] = value.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

export function parseSessionHours(raw: string): ParsedHours | null {
  const [from, to] = raw.split("-").map((part) => part.trim());
  if (!from || !to) return null;
  const start = parseClockMinutes(from);
  const end = parseClockMinutes(to);
  if (start === null || end === null) return null;
  return { start, end, from, to };
}

function envInt(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function sessionConfigFromEnv(): SessionConfig {
  return {
    hoursUtc: process.env.SCALPER_HOURS_UTC?.trim() || "06:30-20:30",
    flattenBeforeEndMin: envInt("SCALPER_FLATTEN_BEFORE_END_MIN", 5, 0, 120),
    fridayCloseUtc: process.env.SCALPER_FRIDAY_CLOSE_UTC?.trim() || "20:30",
  };
}

function utcDayStart(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function atUtcMinutes(day: Date, minutes: number) {
  return new Date(day.getTime() + minutes * 60_000);
}

function sundayReopenMinutes(hours: ParsedHours) {
  return hours.start > hours.end ? hours.start : 22 * 60;
}

function weekendClosedAt(now: Date, hours: ParsedHours, fridayCloseMin: number) {
  const day = now.getUTCDay();
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (day === 5 && minute >= fridayCloseMin) return true;
  if (day === 6) return true;
  if (day === 0 && minute < sundayReopenMinutes(hours)) return true;
  return false;
}

function capAtFridayClose(start: Date, end: Date, fridayCloseMin: number) {
  let capped = new Date(end);
  const startDay = utcDayStart(start);
  for (let offset = 0; offset <= 1; offset++) {
    const day = new Date(startDay.getTime() + offset * DAY_MS);
    if (day.getUTCDay() !== 5) continue;
    const fridayClose = atUtcMinutes(day, fridayCloseMin);
    if (fridayClose > start && fridayClose < capped) capped = fridayClose;
  }
  return capped;
}

function occurrenceForStartDay(day: Date, hours: ParsedHours, config: SessionConfig): Occurrence | null {
  const fridayCloseMin = parseClockMinutes(config.fridayCloseUtc) ?? 20 * 60 + 30;
  const start = atUtcMinutes(day, hours.start);
  const endDayOffset = hours.end > hours.start ? 0 : 1;
  let end = atUtcMinutes(new Date(day.getTime() + endDayOffset * DAY_MS), hours.end);

  const startDay = start.getUTCDay();
  const startMinute = start.getUTCHours() * 60 + start.getUTCMinutes();
  if (startDay === 5 && startMinute >= fridayCloseMin) return null;
  if (startDay === 6) return null;
  if (startDay === 0 && startMinute < sundayReopenMinutes(hours)) return null;

  end = capAtFridayClose(start, end, fridayCloseMin);
  if (end <= start) return null;

  const flattenAt = new Date(end.getTime() - config.flattenBeforeEndMin * 60_000);
  return { start, end, flattenAt };
}

function occurrencesAround(now: Date, config: SessionConfig) {
  const hours = parseSessionHours(config.hoursUtc);
  if (!hours) return { hours: null, occurrences: [] as Occurrence[] };
  const base = utcDayStart(now);
  const occurrences: Occurrence[] = [];
  for (let offset = -1; offset <= 8; offset++) {
    const day = new Date(base.getTime() + offset * DAY_MS);
    const occurrence = occurrenceForStartDay(day, hours, config);
    if (occurrence) occurrences.push(occurrence);
  }
  return { hours, occurrences };
}

export function getSessionStatus(now = new Date(), config = sessionConfigFromEnv()): SessionStatus {
  const { hours, occurrences } = occurrencesAround(now, config);
  if (!hours) {
    return {
      inside: true,
      weekendClosed: false,
      inFlattenWindow: false,
      minutesUntilEnd: null,
      sessionStartAt: null,
      sessionEndAt: null,
      flattenAt: null,
      nextStartAt: null,
      nextFlattenAt: null,
      blockReason: null,
    };
  }

  const fridayCloseMin = parseClockMinutes(config.fridayCloseUtc) ?? 20 * 60 + 30;
  const weekendClosed = weekendClosedAt(now, hours, fridayCloseMin);
  const current = occurrences.find((item) => now >= item.start && now < item.end) ?? null;
  const next = occurrences.find((item) => item.start > now) ?? null;
  const inFlattenWindow = Boolean(current && now >= current.flattenAt && now < current.end);
  const minutesUntilEnd = current ? Math.max(0, Math.ceil((current.end.getTime() - now.getTime()) / 60_000)) : null;

  let blockReason: string | null = null;
  if (weekendClosed) blockReason = "Mercato chiuso (weekend)";
  else if (inFlattenWindow) blockReason = `Chiusura sessione tra ${minutesUntilEnd ?? 0} min`;

  return {
    inside: Boolean(current) && !weekendClosed,
    weekendClosed,
    inFlattenWindow,
    minutesUntilEnd,
    sessionStartAt: current?.start.toISOString() ?? null,
    sessionEndAt: current?.end.toISOString() ?? null,
    flattenAt: current?.flattenAt.toISOString() ?? null,
    nextStartAt: current ? null : next?.start.toISOString() ?? null,
    nextFlattenAt: current?.flattenAt.toISOString() ?? next?.flattenAt.toISOString() ?? null,
    blockReason,
  };
}

/**
 * Inizio della sessione operativa corrente: ultima occorrenza dell'orario di
 * apertura di SCALPER_HOURS_UTC. Con "22:00-20:30" la sessione va dalle 22:00
 * alle 22:00 del giorno dopo. Senza fascia valida ricade sul giorno UTC.
 */
export function sessionWindowStart(now = new Date(), config = sessionConfigFromEnv()) {
  const hours = parseSessionHours(config.hoursUtc);
  const day = utcDayStart(now);
  if (!hours) return day;
  const candidate = atUtcMinutes(day, hours.start);
  return candidate <= now ? candidate : new Date(candidate.getTime() - DAY_MS);
}

export function sessionAllowsEntry(now = new Date(), config = sessionConfigFromEnv()) {
  const status = getSessionStatus(now, config);
  return !status.inFlattenWindow && !status.weekendClosed;
}

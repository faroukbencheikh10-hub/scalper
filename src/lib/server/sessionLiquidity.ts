/**
 * Sessioni forex reali (Sydney/Tokyo/Londra/New York) e livello di liquidita' del momento, dentro
 * la fascia oraria esistente (SCALPER_HOURS_UTC). Modulo puro: nessuna dipendenza da stato esterno
 * o database, solo l'ora UTC del tick in ingresso. Non tocca SCALPER_HOURS_UTC ne' il flatten di
 * fine fascia (session.ts): serve solo a scegliere quali setup valutare e quanti lotti usare
 * DENTRO la fascia gia' esistente, mai a decidere se il worker e' dentro o fuori sessione.
 */

export type LiquidityLevel = "LOW" | "MEDIUM" | "HIGH";
export type ForexSession = "sydney" | "tokyo" | "london" | "new_york";

/** Orari UTC di apertura/chiusura di ciascuna piazza. end < start significa che attraversa la mezzanotte. */
const SESSION_HOURS_UTC: Record<ForexSession, { startUtc: number; endUtc: number }> = {
  sydney: { startUtc: 21, endUtc: 6 },
  tokyo: { startUtc: 0, endUtc: 9 },
  london: { startUtc: 7, endUtc: 16 },
  new_york: { startUtc: 12, endUtc: 21 },
};

function normalizeHour(utcHour: number) {
  if (!Number.isFinite(utcHour)) return 0;
  return ((Math.floor(utcHour) % 24) + 24) % 24;
}

/** true se l'ora UTC (0-23) cade dentro [start, end), gestendo l'attraversamento della mezzanotte. */
function hourInSession(hour: number, startUtc: number, endUtc: number) {
  if (startUtc === endUtc) return true; // sessione 24h, non usato oggi ma corretto per costruzione
  if (startUtc < endUtc) return hour >= startUtc && hour < endUtc;
  return hour >= startUtc || hour < endUtc;
}

/** Piazze forex realmente aperte all'ora UTC data. */
export function activeSessions(utcHour: number): ForexSession[] {
  const hour = normalizeHour(utcHour);
  return (Object.keys(SESSION_HOURS_UTC) as ForexSession[])
    .filter((session) => hourInSession(hour, SESSION_HOURS_UTC[session].startUtc, SESSION_HOURS_UTC[session].endUtc));
}

/**
 * Livello di liquidita' per ora UTC, calcolato dentro la fascia operativa 06:00-20:30:
 * LOW 06:00-07:00 (coda Tokyo, Londra non ancora aperta), MEDIUM 07:00-12:00 e 16:00-20:30 (una
 * sola piazza attiva), HIGH 12:00-16:00 (overlap Londra-New York). Fuori da quella fascia (21:00-
 * 06:00, dove il worker non opera comunque per SCALPER_HOURS_UTC) il mercato e' sottile quanto o
 * meno della coda Tokyo: si ripiega su LOW come default piu' prudente.
 */
export function getLiquidityLevel(utcHour: number): LiquidityLevel {
  const hour = normalizeHour(utcHour);
  if (hour === 6) return "LOW";
  if (hour >= 7 && hour < 12) return "MEDIUM";
  if (hour >= 12 && hour < 16) return "HIGH";
  if (hour >= 16 && hour < 21) return "MEDIUM";
  return "LOW";
}

function envMultiplier(name: string, fallback: number) {
  const raw = process.env[name];
  const value = raw !== undefined && raw.trim() !== "" ? parseFloat(raw) : NaN;
  return Number.isFinite(value) && value > 0 && value <= 2 ? value : fallback;
}

/** Moltiplicatore lotti per livello: 1 in HIGH (nessuna modifica), configurabile per MEDIUM/LOW. */
export function sessionLotMultiplier(level: LiquidityLevel): number {
  if (level === "LOW") return envMultiplier("SESSION_LOT_MULT_LOW", 0.5);
  if (level === "MEDIUM") return envMultiplier("SESSION_LOT_MULT_MEDIUM", 0.7);
  return 1;
}

export type LiquiditySnapshot = {
  level: LiquidityLevel;
  activeSessions: ForexSession[];
  lotMultiplier: number;
  /** true solo in LOW: m1_short e m1_range escono dalla valutazione, resta solo mtf. */
  disableShort: boolean;
  disableRange: boolean;
  reason: string;
};

/** Riassunto completo per un tick, dato l'orario (epoch ms) del tick: un'unica lettura dell'ora. */
export function sessionLiquiditySnapshot(nowMs: number): LiquiditySnapshot {
  const utcHour = new Date(nowMs).getUTCHours();
  const level = getLiquidityLevel(utcHour);
  const sessions = activeSessions(utcHour);
  const lotMultiplier = sessionLotMultiplier(level);
  const disableShort = level === "LOW";
  const disableRange = level === "LOW";
  const reason = `Liquidita' ${level} (${String(utcHour).padStart(2, "0")}:00 UTC, sessioni attive: ${sessions.length ? sessions.join(", ") : "nessuna"})`
    + `: lotti x${lotMultiplier}${disableShort || disableRange ? ", solo mtf attivo (m1_short/m1_range esclusi)" : ", tutti i setup attivi"}.`;
  return { level, activeSessions: sessions, lotMultiplier, disableShort, disableRange, reason };
}

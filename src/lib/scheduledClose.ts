/**
 * Chiusura programmata: finestra oraria in cui il worker non apre NUOVI ordini.
 *
 * Blocco indipendente da tutto il resto (system_stop, AUTO_EXEC, exec_lots, fascia oraria della
 * sessione, liquidita', setup e context_gate restano quello che sono): qui si decide soltanto se
 * una nuova apertura e' consentita in questo momento. Le posizioni gia' aperte non c'entrano mai:
 * chi gestisce breakeven, trailing, target1 e SL non passa da questo modulo.
 *
 * Modulo puro come lots.ts/exitMode.ts: nessun process.env, nessun database, nessuna dipendenza da
 * Next o dal worker. Lo usano *entrambi* — la dashboard (via /api/state) e il worker Railway — con
 * le stesse chiavi di scalper_settings, cosi' non possono divergere.
 *
 * L'offset UTC non viene MAI congelato: in scalper_settings si salva solo l'orario di parete
 * ("HH:MM") piu' il nome del fuso, e l'offset reale viene ricalcolato ad ogni controllo con Intl.
 * Cosi' la finestra resta alla stessa ora locale passando da CET (+01) a CEST (+02) e viceversa.
 */

export const SCHEDULED_CLOSE_ENABLED_KEY = "scheduled_close_enabled";
export const SCHEDULED_CLOSE_START_KEY = "scheduled_close_start_local";
export const SCHEDULED_CLOSE_END_KEY = "scheduled_close_end_local";
export const SCHEDULED_CLOSE_TIMEZONE_KEY = "scheduled_close_timezone";

/** Fuso di riferimento della finestra. Salvato per esteso, mai come offset numerico. */
export const SCHEDULED_CLOSE_TIMEZONE = "Europe/Paris";

/** Motivo dedicato, riconoscibile nei log del worker, in dashboard e su Telegram. */
export const SCHEDULED_CLOSE_REASON = "Chiusura programmata";

export type ScheduledCloseConfig = {
  enabled: boolean;
  /** Orario di parete nel fuso di riferimento, "HH:MM". null se non ancora impostato. */
  startLocal: string | null;
  endLocal: string | null;
  timeZone: string;
};

export type ScheduledCloseStatus = ScheduledCloseConfig & {
  /** true solo con entrambi gli orari validi e diversi fra loro. */
  configured: boolean;
  /** true = siamo dentro la finestra: nessun NUOVO ordine. Falso sempre, se enabled e' false. */
  active: boolean;
  /** La finestra scavalca la mezzanotte (es. 22:00 -> 07:00). */
  crossesMidnight: boolean;
  /** Ora corrente nel fuso di riferimento, "HH:MM": quella su cui e' stata presa la decisione. */
  nowLocal: string;
  reason: string | null;
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" -> minuti dalla mezzanotte, oppure null se il formato non e' valido. */
export function parseHhMm(value: string | null | undefined): number | null {
  const match = typeof value === "string" ? value.trim().match(HHMM) : null;
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatHhMm(minutes: number): string {
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function zoneParts(instantMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Fuso valido per Intl? Un nome sbagliato in scalper_settings non deve far esplodere il worker. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Offset reale del fuso in quell'istante (ms, positivo a est). Ricalcolato ogni volta: e' questo
 * che fa funzionare la stessa finestra sia in CET sia in CEST senza toccare nulla.
 */
export function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const p = zoneParts(instantMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instantMs;
}

/** Minuti dalla mezzanotte nel fuso indicato. */
export function zoneMinutes(now: Date, timeZone: string): number {
  const p = zoneParts(now.getTime(), timeZone);
  return p.hour * 60 + p.minute;
}

export function zoneHhMm(now: Date, timeZone: string): string {
  return formatHhMm(zoneMinutes(now, timeZone));
}

/**
 * Istante in cui, nel fuso indicato, l'orologio segna hhmm nella stessa data di `reference`.
 * Due passate perche' nei giorni di cambio ora la prima stima puo' cadere sull'offset sbagliato.
 */
export function zonedWallTimeToInstant(hhmm: string, timeZone: string, reference: Date): number | null {
  const minutes = parseHhMm(hhmm);
  if (minutes === null) return null;
  const day = zoneParts(reference.getTime(), timeZone);
  const asUtc = Date.UTC(day.year, day.month - 1, day.day, Math.floor(minutes / 60), minutes % 60);
  const firstPass = asUtc - zoneOffsetMs(asUtc, timeZone);
  return asUtc - zoneOffsetMs(firstPass, timeZone);
}

/** Ora scritta nelle caselle del browser -> ora di parete nel fuso di riferimento. */
export function localInputToZone(hhmm: string, timeZone: string, reference: Date = new Date()): string | null {
  const minutes = parseHhMm(hhmm);
  if (minutes === null) return null;
  const local = new Date(reference.getTime());
  local.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return zoneHhMm(local, timeZone);
}

/** Inverso: ora di parete nel fuso di riferimento -> ora da mostrare nelle caselle del browser. */
export function zoneToLocalInput(hhmm: string, timeZone: string, reference: Date = new Date()): string | null {
  const instant = zonedWallTimeToInstant(hhmm, timeZone, reference);
  if (instant === null) return null;
  const local = new Date(instant);
  return `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
}

/**
 * Dentro la finestra [start, end)? start incluso, end escluso. Con end < start la finestra
 * scavalca la mezzanotte. start === end e' una finestra vuota: non blocca mai (mai 24h per sbaglio).
 */
export function insideWindow(nowMinutes: number, startMinutes: number, endMinutes: number): boolean {
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

function readBoolean(value: string | null | undefined) {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

function readHhMm(value: string | null | undefined) {
  return parseHhMm(value) === null ? null : value!.trim();
}

/** Config dalle chiavi di scalper_settings. Stessa lettura per dashboard e worker. */
export function resolveScheduledCloseConfig(read: (key: string) => string | null | undefined): ScheduledCloseConfig {
  const timeZone = read(SCHEDULED_CLOSE_TIMEZONE_KEY)?.trim();
  return {
    enabled: readBoolean(read(SCHEDULED_CLOSE_ENABLED_KEY)),
    startLocal: readHhMm(read(SCHEDULED_CLOSE_START_KEY)),
    endLocal: readHhMm(read(SCHEDULED_CLOSE_END_KEY)),
    timeZone: timeZone && isValidTimeZone(timeZone) ? timeZone : SCHEDULED_CLOSE_TIMEZONE,
  };
}

/**
 * L'unica funzione che decide. La chiamano sia /api/state (dashboard) sia il worker ad ogni tick,
 * con le stesse chiavi lette dallo stesso database: non possono dare risposte diverse.
 */
export function scheduledCloseStatus(now: Date, config: ScheduledCloseConfig): ScheduledCloseStatus {
  const start = parseHhMm(config.startLocal);
  const end = parseHhMm(config.endLocal);
  const configured = start !== null && end !== null && start !== end;
  const nowMinutes = zoneMinutes(now, config.timeZone);
  const active = config.enabled && configured && insideWindow(nowMinutes, start!, end!);
  return {
    ...config,
    configured,
    active,
    crossesMidnight: configured && start! > end!,
    nowLocal: formatHhMm(nowMinutes),
    reason: active
      ? `${SCHEDULED_CLOSE_REASON}: nessun nuovo ordine dalle ${config.startLocal} alle ${config.endLocal} (${config.timeZone}).`
      : null,
  };
}

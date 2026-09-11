// Deterministic scenarios per la chiusura programmata: blocca SOLO le nuove aperture, dentro una
// finestra oraria di parete nel fuso salvato (Europe/Paris), con l'offset ricalcolato ogni volta.
// Nessun broker, nessun database, nessuna dipendenza dall'orologio della macchina che li esegue.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  insideWindow, localInputToZone, parseHhMm, resolveScheduledCloseConfig, scheduledCloseStatus,
  zoneMinutes, zoneOffsetMs, zoneToLocalInput, zonedWallTimeToInstant,
  SCHEDULED_CLOSE_ENABLED_KEY, SCHEDULED_CLOSE_END_KEY, SCHEDULED_CLOSE_START_KEY,
  SCHEDULED_CLOSE_TIMEZONE, SCHEDULED_CLOSE_TIMEZONE_KEY, SCHEDULED_CLOSE_REASON,
} from "../src/lib/scheduledClose";

let passed = 0;
function check(name: string, test: () => void) {
  try { test(); passed++; console.log("OK " + name); }
  catch (error) { console.error("FAIL " + name); throw error; }
}

const PARIS = SCHEDULED_CLOSE_TIMEZONE;
const config = (over: Partial<ReturnType<typeof resolveScheduledCloseConfig>> = {}) => ({
  enabled: true, startLocal: "22:00", endLocal: "07:00", timeZone: PARIS, ...over,
});
/** Stato calcolato in un preciso istante UTC: e' cosi' che lo chiamano worker e /api/state. */
const at = (iso: string, over = {}) => scheduledCloseStatus(new Date(iso), config(over));

// --- interruttore spento: non deve mai avere effetto ------------------------------------------

check("spenta: enabled=false non blocca mai, nemmeno in mezzo alla finestra", () => {
  for (const iso of ["2026-01-15T23:00:00Z", "2026-07-15T01:00:00Z", "2026-03-29T01:30:00Z"]) {
    const status = scheduledCloseStatus(new Date(iso), config({ enabled: false }));
    assert.equal(status.active, false, iso);
    assert.equal(status.reason, null, iso);
  }
});

check("spenta: gli orari restano nella config, pronti per la riaccensione", () => {
  const status = scheduledCloseStatus(new Date("2026-01-15T23:00:00Z"), config({ enabled: false }));
  assert.equal(status.startLocal, "22:00");
  assert.equal(status.endLocal, "07:00");
  assert.equal(status.configured, true, "la finestra resta valida anche da spenta");
});

// --- finestra che attraversa la mezzanotte ------------------------------------------------------

check("mezzanotte: 22:00→07:00 blocca 22:00, 23:59, 00:00, 03:00 e 06:59", () => {
  // Gennaio = CET (+01): l'ora di Parigi e' UTC+1.
  assert.equal(at("2026-01-15T21:00:00Z").nowLocal, "22:00");
  for (const [iso, local] of [
    ["2026-01-15T21:00:00Z", "22:00"], ["2026-01-15T22:59:00Z", "23:59"],
    ["2026-01-15T23:00:00Z", "00:00"], ["2026-01-16T02:00:00Z", "03:00"],
    ["2026-01-16T05:59:00Z", "06:59"],
  ] as const) {
    const status = at(iso);
    assert.equal(status.nowLocal, local, iso);
    assert.equal(status.active, true, `${iso} (${local}) deve essere dentro la finestra`);
    assert.match(status.reason ?? "", new RegExp(SCHEDULED_CLOSE_REASON));
  }
  assert.equal(at("2026-01-15T21:00:00Z").crossesMidnight, true);
});

check("mezzanotte: fuori finestra a 07:00 (escluso) e alle 21:59", () => {
  assert.equal(at("2026-01-16T06:00:00Z").nowLocal, "07:00");
  assert.equal(at("2026-01-16T06:00:00Z").active, false, "end e' escluso");
  assert.equal(at("2026-01-15T20:59:00Z").nowLocal, "21:59");
  assert.equal(at("2026-01-15T20:59:00Z").active, false);
});

check("finestra normale 09:00→17:00: start incluso, end escluso, niente wrap", () => {
  const diurna = { startLocal: "09:00", endLocal: "17:00" };
  assert.equal(at("2026-01-15T08:00:00Z", diurna).active, true, "09:00 incluso");
  assert.equal(at("2026-01-15T15:59:00Z", diurna).active, true, "16:59 dentro");
  assert.equal(at("2026-01-15T16:00:00Z", diurna).active, false, "17:00 escluso");
  assert.equal(at("2026-01-15T07:59:00Z", diurna).active, false, "08:59 fuori");
  assert.equal(at("2026-01-15T08:00:00Z", diurna).crossesMidnight, false);
});

// --- CET / CEST: l'offset non e' mai congelato --------------------------------------------------

check("CET/CEST: l'offset di Europe/Paris e' ricalcolato, +01 a gennaio e +02 a luglio", () => {
  assert.equal(zoneOffsetMs(Date.UTC(2026, 0, 15, 12), PARIS), 3600000, "gennaio = CET");
  assert.equal(zoneOffsetMs(Date.UTC(2026, 6, 15, 12), PARIS), 7200000, "luglio = CEST");
});

check("CET/CEST: lo STESSO istante UTC cade dentro o fuori a seconda della stagione", () => {
  // 20:30 UTC: a gennaio sono le 21:30 a Parigi (fuori), a luglio le 22:30 (dentro).
  const inverno = at("2026-01-15T20:30:00Z");
  const estate = at("2026-07-15T20:30:00Z");
  assert.equal(inverno.nowLocal, "21:30");
  assert.equal(inverno.active, false);
  assert.equal(estate.nowLocal, "22:30");
  assert.equal(estate.active, true);
  // Un offset fisso congelato al salvataggio avrebbe dato la stessa risposta a entrambi: e' il bug
  // che questa coppia di casi impedisce di reintrodurre.
  assert.notEqual(inverno.active, estate.active);
});

check("CET/CEST: la finestra resta alla stessa ora di parete prima e dopo il cambio ora", () => {
  // Ultimo weekend di marzo 2026: il cambio scatta domenica 29 alle 02:00 locali.
  assert.equal(at("2026-03-28T21:00:00Z").nowLocal, "22:00", "sabato, ancora CET");
  assert.equal(at("2026-03-28T21:00:00Z").active, true);
  assert.equal(at("2026-03-30T20:00:00Z").nowLocal, "22:00", "lunedi', ormai CEST");
  assert.equal(at("2026-03-30T20:00:00Z").active, true);
});

// --- finestra non utilizzabile ------------------------------------------------------------------

check("start === end: finestra vuota, non blocca mai (mai 24h per sbaglio)", () => {
  const status = at("2026-01-15T23:00:00Z", { startLocal: "22:00", endLocal: "22:00" });
  assert.equal(status.configured, false);
  assert.equal(status.active, false);
});

check("orari mancanti o malformati: configured=false e nessun blocco", () => {
  assert.equal(at("2026-01-15T23:00:00Z", { startLocal: null }).active, false);
  assert.equal(at("2026-01-15T23:00:00Z", { endLocal: "25:00" as unknown as string }).active, false);
  assert.equal(parseHhMm("7:30"), null, "serve lo zero iniziale");
  assert.equal(parseHhMm("07:30"), 7 * 60 + 30);
  assert.equal(parseHhMm("24:00"), null);
});

check("insideWindow: confini espliciti nelle due forme di finestra", () => {
  assert.equal(insideWindow(540, 540, 1020), true);
  assert.equal(insideWindow(1020, 540, 1020), false);
  assert.equal(insideWindow(1320, 1320, 420), true);
  assert.equal(insideWindow(420, 1320, 420), false);
  assert.equal(insideWindow(0, 1320, 420), true);
});

// --- lettura delle chiavi: la stessa per dashboard e worker -------------------------------------

check("resolveScheduledCloseConfig: stesse chiavi, default prudenti, fuso non valido ignorato", () => {
  const values: Record<string, string> = {
    [SCHEDULED_CLOSE_ENABLED_KEY]: "true",
    [SCHEDULED_CLOSE_START_KEY]: "22:00",
    [SCHEDULED_CLOSE_END_KEY]: "07:00",
    [SCHEDULED_CLOSE_TIMEZONE_KEY]: PARIS,
  };
  const parsed = resolveScheduledCloseConfig((key) => values[key]);
  assert.deepEqual(parsed, { enabled: true, startLocal: "22:00", endLocal: "07:00", timeZone: PARIS });

  const vuoto = resolveScheduledCloseConfig(() => undefined);
  assert.deepEqual(vuoto, { enabled: false, startLocal: null, endLocal: null, timeZone: PARIS });

  const fusoRotto = resolveScheduledCloseConfig((key) => (key === SCHEDULED_CLOSE_TIMEZONE_KEY ? "Non/Esiste" : values[key]));
  assert.equal(fusoRotto.timeZone, PARIS, "un fuso non valido ricade su Europe/Paris");
});

// --- conversione caselle del browser <-> fuso di riferimento ------------------------------------

check("conversione: andata e ritorno fra ora del browser e ora di Parigi", () => {
  for (const hhmm of ["22:00", "07:00", "00:30", "13:45"]) {
    const paris = localInputToZone(hhmm, PARIS, new Date("2026-07-15T12:00:00Z"));
    assert.ok(paris, hhmm);
    const back = zoneToLocalInput(paris!, PARIS, new Date("2026-07-15T12:00:00Z"));
    assert.equal(back, hhmm, `${hhmm} -> ${paris} -> ${back}`);
  }
});

check("conversione: l'istante di parete a Parigi rispetta l'offset stagionale", () => {
  const inverno = zonedWallTimeToInstant("22:00", PARIS, new Date("2026-01-15T12:00:00Z"));
  assert.equal(new Date(inverno!).toISOString(), "2026-01-15T21:00:00.000Z", "22:00 CET = 21:00Z");
  const estate = zonedWallTimeToInstant("22:00", PARIS, new Date("2026-07-15T12:00:00Z"));
  assert.equal(new Date(estate!).toISOString(), "2026-07-15T20:00:00.000Z", "22:00 CEST = 20:00Z");
  assert.equal(zoneMinutes(new Date("2026-07-15T20:00:00Z"), PARIS), 22 * 60);
});

// --- invarianti sul codice: il blocco tocca solo le APERTURE ------------------------------------

const workerSource = readFileSync(new URL("../worker/streaming.ts", import.meta.url), "utf8");
const controlSource = readFileSync(new URL("../src/app/api/control/route.ts", import.meta.url), "utf8");

check("worker: il ramo della chiusura programmata non chiude ne' modifica posizioni", () => {
  const blocks = workerSource.split("scheduledCloseNow.active").slice(1)
    .concat(workerSource.split("scheduledCloseBeforeOrder.active").slice(1))
    .map((chunk) => chunk.slice(0, 400));
  assert.equal(blocks.length, 2, "attesi i due punti di controllo (tick e pre-ordine)");
  for (const block of blocks) {
    for (const vietato of ["flattenSymbol", "closePosition", "modifyPosition", "system_stop", "setSystemStop"]) {
      assert.ok(!block.includes(vietato), `il blocco non deve chiamare ${vietato}: ${block.slice(0, 120)}`);
    }
    assert.ok(/return;/.test(block), "il blocco si limita a non aprire l'ordine");
  }
});

check("worker: la guardia sta dopo la valutazione dei setup, che restano attivi", () => {
  const guardIndex = workerSource.indexOf("scheduledCloseNow.active");
  const evaluateIndex = workerSource.indexOf("withLiquidityEvaluation(evaluateScalper(");
  assert.ok(evaluateIndex > 0 && guardIndex > evaluateIndex, "i setup vengono valutati prima del blocco");
});

check("api/control: spegnere non cancella gli orari salvati", () => {
  assert.ok(
    controlSource.includes("if (body.startLocal !== undefined) await setSetting(SCHEDULED_CLOSE_START_KEY"),
    "gli orari si scrivono solo se presenti nel body",
  );
  assert.ok(
    controlSource.includes("if (body.endLocal !== undefined) await setSetting(SCHEDULED_CLOSE_END_KEY"),
    "gli orari si scrivono solo se presenti nel body",
  );
});

console.log(`${passed} scenari superati.`);

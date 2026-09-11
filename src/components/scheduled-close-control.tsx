"use client";

import { useEffect, useMemo, useState } from "react";
import {
  localInputToZone, zoneToLocalInput, SCHEDULED_CLOSE_TIMEZONE, type ScheduledCloseStatus,
} from "@/lib/scheduledClose";

type Props = {
  status?: ScheduledCloseStatus | null;
  onChanged?: (status: ScheduledCloseStatus) => void;
};

const EMPTY = "";

export function ScheduledCloseControl({ status, onChanged }: Props) {
  const timeZone = status?.timeZone ?? SCHEDULED_CLOSE_TIMEZONE;
  const enabled = status?.enabled ?? false;
  const active = status?.active ?? false;

  // Le caselle lavorano nell'ora locale del browser; su scalper_settings finisce sempre l'ora di
  // parete del fuso di riferimento, mai un offset numerico.
  const [startInput, setStartInput] = useState(EMPTY);
  const [endInput, setEndInput] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setStartInput(status?.startLocal ? zoneToLocalInput(status.startLocal, timeZone) ?? EMPTY : EMPTY);
    setEndInput(status?.endLocal ? zoneToLocalInput(status.endLocal, timeZone) ?? EMPTY : EMPTY);
  }, [status?.startLocal, status?.endLocal, timeZone]);

  const bothValid = startInput.length === 5 && endInput.length === 5 && startInput !== endInput;
  const zoneWindow = useMemo(() => {
    if (!bothValid) return null;
    const start = localInputToZone(startInput, timeZone);
    const end = localInputToZone(endInput, timeZone);
    return start && end ? { start, end } : null;
  }, [bothValid, startInput, endInput, timeZone]);

  async function save(payload: Record<string, unknown>, fallbackNote: string) {
    setBusy(true);
    setMsg(null);
    try {
      const response = await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_scheduled_close", ...payload }),
      });
      const data = await response.json();
      if (!data.ok) { setMsg(data.error || "Errore"); return; }
      if (data.scheduledClose) onChanged?.(data.scheduledClose as ScheduledCloseStatus);
      setMsg(data.note || fallbackNote);
    } catch {
      setMsg("Errore di rete");
    } finally {
      setBusy(false);
    }
  }

  /** Un orario completo si salva subito, senza toccare acceso/spento. */
  function saveTimes(nextStart: string, nextEnd: string) {
    if (nextStart.length !== 5 || nextEnd.length !== 5) return;
    const start = localInputToZone(nextStart, timeZone);
    const end = localInputToZone(nextEnd, timeZone);
    if (!start || !end) return;
    void save({ startLocal: start, endLocal: end }, "Orari salvati.");
  }

  /**
   * Tapparella: da spenta accende la programmazione (serve una finestra valida), da accesa la
   * spegne sempre — qualunque posizione stia mostrando in quel momento. Gli orari restano.
   */
  function toggle() {
    if (busy) return;
    if (enabled) { void save({ enabled: false }, "Chiusura programmata spenta."); return; }
    if (!zoneWindow) { setMsg("Imposta prima due orari validi e diversi fra loro."); return; }
    void save({ enabled: true, startLocal: zoneWindow.start, endLocal: zoneWindow.end }, "Chiusura programmata accesa.");
  }

  // Spenta: sempre giu'. Accesa: segue lo stato calcolato dal server, e cambia da sola ogni giorno.
  const knobOn = enabled && active;
  const stateLabel = !enabled ? "Spenta" : active ? "In chiusura" : "In attesa";
  const stateColor = !enabled ? "#72809d" : active ? "#ffc18c" : "#8fffc5";

  return <article className="rules-card" aria-label="Chiusura programmata" style={{ marginBottom: 18 }}>
    <div className="card-heading rules-heading">
      <div><span className="card-index">C</span><h3>Chiusura programmata</h3></div>
      <span className="rainbow-label">SOLO NUOVE APERTURE</span>
    </div>

    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 18 }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ color: "#8f9bb8", font: "800 11px ui-monospace, monospace", letterSpacing: ".1em", textTransform: "uppercase" }}>Chiusura</span>
        <input
          type="time"
          value={startInput}
          disabled={busy}
          onChange={(event) => { setStartInput(event.target.value); saveTimes(event.target.value, endInput); }}
          aria-label="Ora di chiusura (ora locale del browser)"
          style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid rgba(255,255,255,.18)", background: "rgba(8,12,26,.75)", color: "#e9eefc", font: "700 15px ui-monospace, monospace" }}
        />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ color: "#8f9bb8", font: "800 11px ui-monospace, monospace", letterSpacing: ".1em", textTransform: "uppercase" }}>Apertura</span>
        <input
          type="time"
          value={endInput}
          disabled={busy}
          onChange={(event) => { setEndInput(event.target.value); saveTimes(startInput, event.target.value); }}
          aria-label="Ora di riapertura (ora locale del browser)"
          style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid rgba(255,255,255,.18)", background: "rgba(8,12,26,.75)", color: "#e9eefc", font: "700 15px ui-monospace, monospace" }}
        />
      </label>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" }}>
        <span style={{ color: stateColor, font: "800 11px ui-monospace, monospace", letterSpacing: ".1em", textTransform: "uppercase" }}>{stateLabel}</span>
        <button
          type="button"
          role="switch"
          aria-checked={knobOn}
          aria-label="Interruttore chiusura programmata"
          onClick={toggle}
          disabled={busy}
          style={{
            position: "relative",
            width: 62,
            height: 32,
            padding: 0,
            borderRadius: 999,
            cursor: busy ? "default" : "pointer",
            border: enabled ? "1px solid rgba(96,247,170,.6)" : "1px solid rgba(255,255,255,.18)",
            background: knobOn ? "rgba(160,82,22,.5)" : enabled ? "rgba(39,145,101,.25)" : "rgba(255,255,255,.06)",
            transition: "background .2s ease",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              top: 3,
              left: knobOn ? 33 : 3,
              width: 24,
              height: 24,
              borderRadius: "50%",
              background: knobOn ? "#ffc18c" : enabled ? "#8fffc5" : "#64708c",
              transition: "left .2s ease",
            }}
          />
        </button>
      </div>
    </div>

    <p style={{ marginTop: 14 }}>
      {enabled && status?.startLocal && status?.endLocal
        ? <>Nessuna nuova apertura dalle <strong>{status.startLocal}</strong> alle <strong>{status.endLocal}</strong> ({timeZone}){status.crossesMidnight ? " · la finestra passa la mezzanotte" : ""}. Le posizioni già aperte restano gestite normalmente.</>
        : status?.startLocal && status?.endLocal
          ? <>Programmazione spenta. Orari pronti: <strong>{status.startLocal}</strong> → <strong>{status.endLocal}</strong> ({timeZone}).</>
          : <>Imposta l&apos;ora di chiusura e quella di riapertura, poi accendi l&apos;interruttore.</>}
    </p>

    <p className="heartbeat">
      <span>Ora {timeZone} <strong>{status?.nowLocal ?? "—"}</strong>{zoneWindow ? ` · finestra salvata ${zoneWindow.start}→${zoneWindow.end}` : ""}</span>
      <span>{msg ?? "Indipendente da STOP TUTTO, lotti e modalità di uscita."}</span>
    </p>
  </article>;
}

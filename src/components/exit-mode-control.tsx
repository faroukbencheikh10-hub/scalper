"use client";

import { useEffect, useState } from "react";
import { DEFAULT_FAST_TP_USD, FAST_TP_STEP_USD, MIN_FAST_TP_USD, type ExitMode } from "@/lib/exitMode";

type Props = {
  exitMode: ExitMode;
  fastTpUsd: number;
  fastTpUsdMin?: number;
  onChanged?: (exitMode: ExitMode, fastTpUsd: number) => void;
};

const CARDS: Array<{ value: ExitMode; title: string; description: string }> = [
  { value: "normal", title: "Scalper normale", description: "Nessun TP al broker sui setup gestiti: breakeven a target1, poi trailing sulla struttura M5. Nessun limite di durata." },
  { value: "fast", title: "Scalper veloce", description: "TP fisso mandato al broker, chiusura immediata al target. Nessun breakeven, nessun trailing." },
];

export function ExitModeControl({ exitMode, fastTpUsd, fastTpUsdMin, onChanged }: Props) {
  const [selected, setSelected] = useState<ExitMode>(exitMode);
  const [target, setTarget] = useState(Number.isFinite(fastTpUsd) ? fastTpUsd : DEFAULT_FAST_TP_USD);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const min = fastTpUsdMin ?? MIN_FAST_TP_USD;

  useEffect(() => setSelected(exitMode), [exitMode]);
  useEffect(() => { if (Number.isFinite(fastTpUsd)) setTarget(fastTpUsd); }, [fastTpUsd]);

  async function apply() {
    setBusy(true);
    setMsg(null);
    try {
      const response = await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_exit_mode", exitMode: selected, fastTpUsd: target }),
      });
      const data = await response.json();
      if (!data.ok) {
        setMsg(data.error || "Errore");
      } else {
        const appliedMode: ExitMode = data.exitMode === "fast" ? "fast" : "normal";
        const appliedTp = Number.isFinite(data.fastTpUsd) ? Number(data.fastTpUsd) : target;
        setSelected(appliedMode);
        setTarget(appliedTp);
        onChanged?.(appliedMode, appliedTp);
        setMsg(data.note || "Fatto");
      }
    } catch {
      setMsg("Errore di rete");
    } finally {
      setBusy(false);
    }
  }

  const dirty = selected !== exitMode || (selected === "fast" && target !== fastTpUsd);

  return <article className="rules-card" aria-label="Modalità di uscita" style={{ marginBottom: 18 }}>
    <div className="card-heading rules-heading">
      <div><span className="card-index">M</span><h3>Modalità</h3></div>
      <span className="rainbow-label">SOLO NUOVE POSIZIONI</span>
    </div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 4 }}>
      {CARDS.map((card) => {
        const active = selected === card.value;
        const isCurrent = exitMode === card.value;
        return (
          <button
            key={card.value}
            type="button"
            onClick={() => setSelected(card.value)}
            disabled={busy}
            style={{
              flex: "1 1 220px",
              textAlign: "left",
              cursor: busy ? "default" : "pointer",
              padding: "12px 14px",
              borderRadius: 12,
              border: active ? "2px solid rgba(96,247,170,.75)" : "1px solid rgba(255,255,255,.12)",
              background: active ? "rgba(39,145,101,.15)" : "rgba(255,255,255,.02)",
              color: "inherit",
              font: "inherit",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <strong style={{ color: active ? "#8fffc5" : undefined }}>{card.title}</strong>
              {isCurrent ? (
                <span className="state-badge" style={{ color: "#8fffc5", background: "rgba(39,145,101,.15)", borderColor: "rgba(96,247,170,.55)", padding: "2px 8px", fontSize: 10 }}>Attiva</span>
              ) : null}
            </div>
            <p style={{ margin: "6px 0 0", color: "#9aa7c7", fontSize: 13 }}>{card.description}</p>
          </button>
        );
      })}
    </div>
    {selected === "fast" ? (
      <label style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
        <span>Target ($)</span>
        <input
          type="number"
          min={min}
          step={FAST_TP_STEP_USD}
          value={target}
          onChange={(event) => setTarget(Number(event.target.value))}
          disabled={busy}
          aria-label="Target in dollari per la modalità fast"
          style={{ width: 90, padding: "6px 8px", borderRadius: 8, border: "1px solid rgba(255,255,255,.18)", background: "rgba(0,0,0,.25)", color: "inherit" }}
        />
      </label>
    ) : null}
    <div style={{ marginTop: 14 }}>
      <button type="button" className="resume-button" onClick={apply} disabled={busy || !dirty}>
        {busy ? "Attendi…" : "Applica modalità"}
      </button>
    </div>
    {msg ? <p className="heartbeat" style={{ marginTop: 10 }}>{msg}</p> : null}
  </article>;
}

"use client";

import { useEffect, useState } from "react";
import { LOT_CHOICES, lossAtStop, requiredMargin, stopDistanceFrom } from "@/lib/lots";

type Account = { balance?: number | null; equity?: number | null; freeMargin?: number | null; currency?: string | null } | null;

type Props = {
  stopped: boolean;
  lots?: number | null;
  lotChoices?: number[];
  price?: number | null;
  entry?: number | null;
  stopLoss?: number | null;
  account?: Account;
  onChanged?: (stopped: boolean) => void;
  onLotsChanged?: (lots: number) => void;
};

function amount(value: number | null | undefined, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "—";
}

export function SystemControl({ stopped, lots, lotChoices, price, entry, stopLoss, account, onChanged, onLotsChanged }: Props) {
  const [isStopped, setIsStopped] = useState(stopped);
  const [busy, setBusy] = useState(false);
  const [lotsBusy, setLotsBusy] = useState(false);
  const [activeLots, setActiveLots] = useState<number | null>(lots ?? null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => setIsStopped(stopped), [stopped]);
  useEffect(() => { if (Number.isFinite(lots)) setActiveLots(Number(lots)); }, [lots]);

  async function toggle() {
    const next = !isStopped;
    const ok = window.confirm(next
      ? "STOP TUTTO? Blocca nuove aperture e ordina al worker di chiudere a mercato TUTTE le posizioni XAUUSD e cancellare gli ordini pendenti XAUUSD."
      : "RIATTIVARE TUTTO? Riprenderanno dati, analisi e possibili nuove esecuzioni MT5 secondo fascia e regole operative.");
    if (!ok) return;

    setBusy(true);
    setMsg(null);
    try {
      const response = await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stopped: next }),
      });
      const data = await response.json();
      if (!data.ok) setMsg(data.error || "Errore");
      else {
        const resolved = typeof data.stopped === "boolean" ? data.stopped : next;
        setIsStopped(resolved);
        onChanged?.(resolved);
        setMsg(data.note || "Fatto");
      }
    } catch {
      setMsg("Errore di rete");
    } finally {
      setBusy(false);
    }
  }

  async function changeLots(next: number) {
    const previous = activeLots;
    setActiveLots(next);
    setLotsBusy(true);
    setMsg(null);
    try {
      const response = await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_lots", lots: next }),
      });
      const data = await response.json();
      if (!data.ok) {
        setActiveLots(previous);
        setMsg(data.error || "Errore");
      } else {
        const applied = Number.isFinite(data.lots) ? Number(data.lots) : next;
        setActiveLots(applied);
        onLotsChanged?.(applied);
        setMsg(data.note || `Lotti impostati a ${applied.toFixed(2)}`);
      }
    } catch {
      setActiveLots(previous);
      setMsg("Errore di rete");
    } finally {
      setLotsBusy(false);
    }
  }

  const active = !isStopped;
  const choices = lotChoices && lotChoices.length > 0 ? lotChoices : LOT_CHOICES;
  const selected = Number.isFinite(activeLots) ? Number(activeLots) : null;
  const options = selected !== null && !choices.includes(selected) ? [...choices, selected].sort((a, b) => a - b) : choices;
  const margin = selected !== null && Number.isFinite(price) ? requiredMargin(selected, Number(price)) : null;
  const distance = stopDistanceFrom(entry, stopLoss);
  const risk = selected !== null ? lossAtStop(selected, distance) : null;
  const currency = account?.currency ?? "USD";
  const freeMargin = Number.isFinite(account?.freeMargin) ? Number(account?.freeMargin) : null;
  const marginShort = margin !== null && freeMargin !== null && margin > freeMargin;

  return <div
    className={`system-control ${isStopped ? "stopped" : "running"}`}
    style={{
      border: active ? "2px solid rgba(96,247,170,.75)" : "2px solid rgba(255,155,74,.8)",
      background: active ? "linear-gradient(135deg, rgba(13,72,51,.78), rgba(7,25,27,.92))" : "linear-gradient(135deg, rgba(91,51,16,.82), rgba(29,18,7,.94))",
      boxShadow: active ? "0 0 34px rgba(96,247,170,.18), inset 0 0 28px rgba(96,247,170,.05)" : "0 0 34px rgba(255,155,74,.18), inset 0 0 28px rgba(255,155,74,.05)",
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <span aria-hidden="true" style={{ width: 16, height: 16, borderRadius: "50%", flex: "0 0 auto", background: active ? "#60f7aa" : "#ff9b4a", boxShadow: active ? "0 0 20px #60f7aa" : "0 0 20px #ff9b4a" }} />
      <div>
        <strong style={{ fontSize: 22, letterSpacing: ".08em", color: active ? "#8fffc5" : "#ffc18c" }}>{active ? "ATTIVATO" : "DISATTIVATO"}</strong>
        <span style={{ color: active ? "#c6ffe1" : "#ffddbf" }}>{active ? "Scalper abilitato · session guard e flatten automatico attivi" : "STOP TUTTO · posizioni XAUUSD portate a zero e nuove aperture bloccate"}</span>
      </div>
    </div>

    <div className="control-actions">
      <button type="button" className={isStopped ? "resume-button" : "stop-button"} onClick={toggle} disabled={busy}>{busy ? "Attendi…" : isStopped ? "RIATTIVA TUTTO" : "STOP TUTTO"}</button>
      <label className="lot-picker">
        <span>Lotti</span>
        <select
          value={selected ?? ""}
          onChange={(event) => void changeLots(Number(event.target.value))}
          disabled={lotsBusy}
          aria-label="Lotti per ogni apertura"
        >
          {selected === null ? <option value="">—</option> : null}
          {options.map((value) => <option key={value} value={value}>{value.toFixed(2)}</option>)}
        </select>
      </label>
    </div>

    <p className="lot-metrics">
      Margine richiesto <strong className={marginShort ? "negative" : undefined}>≈ {amount(margin)} {currency}</strong>
      {" · "}Perdita a SL <strong className="negative">≈ {amount(risk)} {currency}</strong>
      <span className="lot-note"> (SL {amount(distance)} $ {Number.isFinite(entry) && Number.isFinite(stopLoss) ? "ultimo segnale" : "stima 2 $"})</span>
      {" · "}Saldo <strong>{amount(account?.balance)} {currency}</strong>
      {" · "}Margine libero <strong>{amount(account?.freeMargin)} {currency}</strong>
      {marginShort ? <span className="negative"> · margine insufficiente: l&apos;ordine verrà bloccato dal worker</span> : null}
    </p>
    {msg ? <p>{msg}</p> : null}
  </div>;
}

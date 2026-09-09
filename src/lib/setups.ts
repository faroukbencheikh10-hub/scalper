import type { ScalperSetup } from "@/lib/types";

/** Setup M1 riconosciuti dalla strategia, in ordine di priorità di valutazione. */
export const SCALPER_SETUPS: ScalperSetup[] = ["liquidity_sweep", "momentum_breakout", "breakout_retest", "micro_pullback"];

/** Etichetta leggibile del setup, usata da log, Telegram e dashboard. */
export function setupLabel(setup: string | null | undefined) {
  const raw = String(setup ?? "").trim();
  const manual = raw.startsWith("manual:");
  const key = manual ? raw.slice("manual:".length) : raw;
  const label = key === "micro_pullback" ? "Micro-pullback"
    : key === "liquidity_sweep" ? "Sweep di liquidità"
      : key === "momentum_breakout" ? "Momentum breakout"
        : key === "breakout_retest" ? "Breakout retest"
          : key === "filtri" ? "Filtri di protezione"
            : key && key !== "none" ? key : "—";
  return manual && label !== "—" ? `${label} (manuale)` : label;
}

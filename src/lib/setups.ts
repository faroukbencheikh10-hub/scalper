import type { ScalperSetup } from "@/lib/types";

/** Setup M1 riconosciuti dalla strategia, in ordine di priorità di valutazione. */
export const SCALPER_SETUPS: ScalperSetup[] = ["breakout_retest", "micro_pullback", "m1_short", "m1_range"];

/** Etichetta leggibile del setup, usata da log, Telegram e dashboard. */
export function setupLabel(setup: string | null | undefined) {
  const raw = String(setup ?? "").trim();
  const manual = raw.startsWith("manual:");
  const key = manual ? raw.slice("manual:".length) : raw;
  const label = key === "micro_pullback" ? "Pullback M5 → M1"
    : key === "liquidity_sweep" ? "Sweep di liquidità"
      : key === "momentum_breakout" ? "Momentum breakout"
        : key === "breakout_retest" ? "Breakout retest"
          : key === "m1_short" ? "Breakout range M1"
            : key === "m1_range" ? "Rientro dal bordo (range M1)"
              : key === "range_gate" ? "Range M1 (contesto)"
                : key === "m15_gate" ? "Contesto M15/M5"
                  : key === "m1_gate" ? "Breakout M1 (contesto)"
                    : key === "filtri" ? "Filtri di protezione"
                      : key && key !== "none" ? key : "—";
  return manual && label !== "—" ? `${label} (manuale)` : label;
}

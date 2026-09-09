import { clampLotsWithin, roundLots } from "@/lib/lots";

function envN(name: string, fallback: number, min = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

export function autoExecEnabled() {
  return process.env.AUTO_EXEC === "true";
}

export function lotsMin() {
  return roundLots(envN("SCALPER_LOTS_MIN", 0.01, 0.01));
}

export function lotsMax() {
  return Math.max(lotsMin(), roundLots(envN("SCALPER_LOTS_MAX", 0.1, 0.01)));
}

/** Applica l'intervallo consentito e arrotonda a 0.01. */
export function clampLots(value: number) {
  return clampLotsWithin(value, lotsMin(), lotsMax());
}

/** Lotti da EXEC_LOTS, dentro l'intervallo consentito. */
export function lots() {
  return clampLots(envN("EXEC_LOTS", 0.05, 0.01));
}

/** Lotti attivi: valore scelto dalla dashboard, con fallback su EXEC_LOTS. */
export function resolveLots(setting: string | null | undefined) {
  const parsed = Number(String(setting ?? "").trim());
  if (Number.isFinite(parsed) && parsed > 0) return clampLots(parsed);
  return lots();
}

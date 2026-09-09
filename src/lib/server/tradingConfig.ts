function envN(name: string, fallback: number, min = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

export function autoExecEnabled() {
  return process.env.AUTO_EXEC === "true";
}

export function lots() {
  return envN("EXEC_LOTS", 0.05, 0.01);
}

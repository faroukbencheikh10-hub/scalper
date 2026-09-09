// Modulo MetaApi REST minimo: SOLO lettura posizioni e chiusura a mercato.
// Usato esclusivamente da worker/watchdog.ts quando il worker streaming e' morto.
// Il percorso normale di trading resta la connessione streaming del worker.

const TIMEOUT_MS = 15_000;

export type WatchdogPosition = {
  id: string;
  symbol: string;
  openPrice?: number;
  volume?: number;
  type?: string;
  time?: string;
};

type TradeResponse = { numericCode?: number; stringCode?: string; message?: string };

function token() {
  const value = process.env.METAAPI_TOKEN?.trim();
  if (!value) throw new Error("METAAPI_TOKEN non impostato");
  return value;
}

function accountId() {
  const value = process.env.METAAPI_ACCOUNT_ID?.trim();
  if (!value) throw new Error("METAAPI_ACCOUNT_ID non impostato");
  return value;
}

function regions() {
  const region = process.env.METAAPI_REGION?.trim().toLowerCase();
  return region ? [region] : ["backup-new-york", "new-york", "london"];
}

function clientBase(region: string) {
  return `https://mt-client-api-v1.${region}.agiliumtrade.ai`;
}

function regionMismatch(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ENOTFOUND") || message.includes("fetch failed") || (message.includes("404") && message.includes("not found"));
}

async function request(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "auth-token": token(),
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`MetaApi HTTP ${response.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

async function withRegion<T>(fn: (region: string) => Promise<T>): Promise<T> {
  let last: unknown = null;
  for (const region of regions()) {
    try {
      return await fn(region);
    } catch (error) {
      last = error;
      if (regionMismatch(error)) continue;
      throw error;
    }
  }
  throw last ?? new Error("MetaApi: nessuna regione valida");
}

export async function watchdogPositions(): Promise<WatchdogPosition[]> {
  return withRegion(async (region) => {
    const data = await request(`${clientBase(region)}/users/current/accounts/${accountId()}/positions?refreshTerminalState=true`);
    return Array.isArray(data) ? data as WatchdogPosition[] : [];
  });
}

export async function watchdogClosePosition(positionId: string) {
  const result = await withRegion(async (region) => request(
    `${clientBase(region)}/users/current/accounts/${accountId()}/trade`,
    { method: "POST", body: JSON.stringify({ actionType: "POSITION_CLOSE_ID", positionId }) },
  ) as Promise<TradeResponse>);

  const accepted = [10008, 10009, 10010].includes(Number(result.numericCode))
    || ["TRADE_RETCODE_PLACED", "TRADE_RETCODE_DONE", "TRADE_RETCODE_DONE_PARTIAL"].includes(result.stringCode ?? "");
  if (!accepted) {
    throw new Error(`Chiusura MT5 rifiutata: ${result.stringCode ?? result.numericCode ?? "?"} ${result.message ?? ""}`.trim());
  }
  return result;
}

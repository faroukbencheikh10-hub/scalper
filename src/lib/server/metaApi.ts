import type { Candle, Quote } from "@/lib/types";
import { getSetting, setSetting } from "./db";

const TIMEOUT_MS = 12_000;
let confirmedRegion: string | null = null;

function token() {
  const v = process.env.METAAPI_TOKEN?.trim();
  if (!v) throw new Error("METAAPI_TOKEN non impostato");
  return v;
}
function accountId() {
  const v = process.env.METAAPI_ACCOUNT_ID?.trim();
  if (!v) throw new Error("METAAPI_ACCOUNT_ID non impostato");
  return v;
}
export function symbol() { return process.env.METAAPI_SYMBOL_XAUUSD?.trim() || "XAUUSD"; }
function regions() {
  const r = process.env.METAAPI_REGION?.trim().toLowerCase();
  return r ? [r] : ["backup-new-york", "new-york", "london"];
}
function clientBase(region: string) { return `https://mt-client-api-v1.${region}.agiliumtrade.ai`; }
function marketBase(region: string) { return `https://mt-market-data-client-api-v1.${region}.agiliumtrade.ai`; }
function mismatch(err: unknown) {
  const m = err instanceof Error ? err.message : String(err);
  return m.includes("ENOTFOUND") || m.includes("fetch failed") || (m.includes("404") && m.includes("not found"));
}
function historyRateLimit(err: unknown) {
  const m = err instanceof Error ? err.message : String(err);
  return m.includes("429") || m.includes("TooManyRequestsError") || m.includes("cpu credits per 6h");
}
function historyBackoffMinutes() {
  const value = Number(process.env.SCALPER_HISTORY_BACKOFF_MIN);
  return Number.isFinite(value) && value >= 1 ? value : 15;
}
async function activeHistoryBackoff() {
  const raw = await getSetting("metaapi_history_backoff_until");
  if (!raw) return null;
  const until = Date.parse(raw);
  return Number.isFinite(until) && until > Date.now() ? raw : null;
}
async function persistHistoryBackoff() {
  const until = new Date(Date.now() + historyBackoffMinutes() * 60_000).toISOString();
  const at = new Date().toISOString();
  await Promise.all([
    setSetting("metaapi_history_backoff_until", until),
    setSetting("stream_last_error", `${at} MetaApi storico in pausa fino a ${until}: 429 getDealsByPosition`),
  ]);
  return until;
}
async function request(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "auth-token": token(),
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`MetaApi HTTP ${res.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : null;
  } finally { clearTimeout(timer); }
}
async function withRegion<T>(fn: (region: string) => Promise<T>): Promise<T> {
  const candidates = confirmedRegion ? [confirmedRegion] : regions();
  let last: unknown = null;
  for (const region of candidates) {
    try {
      const data = await fn(region);
      confirmedRegion = region;
      return data;
    } catch (err) {
      last = err;
      if (mismatch(err)) { if (confirmedRegion === region) confirmedRegion = null; continue; }
      throw err;
    }
  }
  throw last ?? new Error("MetaApi: nessuna regione valida");
}

export async function fetchQuote(): Promise<Quote> {
  return withRegion(async region => {
    const d = await request(`${clientBase(region)}/users/current/accounts/${accountId()}/symbols/${symbol()}/current-price`) as { bid?: number; ask?: number; time?: string };
    if (!Number.isFinite(d.bid) || !Number.isFinite(d.ask)) throw new Error("Quote MetaApi incompleta");
    const bid = Number(d.bid), ask = Number(d.ask);
    return { bid, ask, mid: Number(((bid + ask) / 2).toFixed(2)), spread: Number((ask - bid).toFixed(2)), quotedAt: d.time ? Date.parse(d.time) : null };
  });
}

export async function fetchCandles(timeframe: "1m" | "5m", limit: number): Promise<Candle[]> {
  return withRegion(async region => {
    const d = await request(`${marketBase(region)}/users/current/accounts/${accountId()}/historical-market-data/symbols/${symbol()}/timeframes/${timeframe}/candles?limit=${limit}`) as Array<{ time?: string; open?: number; high?: number; low?: number; close?: number }>;
    if (!Array.isArray(d)) return [];
    return d.flatMap(c => {
      const t = String(c.time ?? "");
      const open = Number(c.open), high = Number(c.high), low = Number(c.low), close = Number(c.close);
      if (!t || ![open, high, low, close].every(Number.isFinite)) return [];
      return [{ datetime: new Date(t).toISOString(), open, high, low, close }];
    }).sort((a,b) => Date.parse(a.datetime)-Date.parse(b.datetime));
  });
}

type Deal = { price?: number; profit?: number; volume?: number; entryType?: string; time?: string };

export async function deals(positionId: string): Promise<Deal[]> {
  const pausedUntil = await activeHistoryBackoff();
  if (pausedUntil) throw new Error(`MetaApi history backoff active until ${pausedUntil}`);
  try {
    return await withRegion(async region => {
      const d = await request(`${clientBase(region)}/users/current/accounts/${accountId()}/history-deals/position/${encodeURIComponent(positionId)}`);
      return Array.isArray(d) ? d as Deal[] : [];
    });
  } catch (error) {
    if (historyRateLimit(error)) {
      const until = await persistHistoryBackoff();
      throw new Error(`MetaApi history backoff active until ${until}`);
    }
    throw error;
  }
}

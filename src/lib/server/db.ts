import { Pool } from "pg";

let pool: Pool | null = null;
function databaseUrl() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL scalper non impostata");
  return url;
}
function getPool() {
  if (!pool) pool = new Pool({ connectionString: databaseUrl(), max: 3 });
  return pool;
}
export async function dbQuery(text: string, params: unknown[] = []) {
  return getPool().query(text, params);
}

export async function ensureSchema() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS scalper_signals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      direction text NOT NULL,
      setup text,
      entry numeric,
      stop_loss numeric,
      take_profit numeric,
      risk_reward numeric,
      reasoning text NOT NULL DEFAULT '',
      outcome text,
      result_r numeric,
      mt5_order_id text,
      mt5_position_id text,
      mt5_open_price numeric,
      mt5_close_price numeric,
      mt5_profit numeric,
      mt5_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      closed_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS scalper_signals_created_at_idx ON scalper_signals(created_at DESC);
    CREATE TABLE IF NOT EXISTS scalper_settings (
      key text PRIMARY KEY,
      value text NOT NULL DEFAULT ''
    );
  `);
}

export async function getSetting(key: string) {
  const r = await dbQuery(`SELECT value FROM scalper_settings WHERE key=$1`, [key]);
  return r.rows[0]?.value as string | undefined;
}
export async function setSetting(key: string, value: string) {
  await dbQuery(`INSERT INTO scalper_settings(key,value) VALUES($1,$2)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [key, value]);
}

export async function systemStopActive() {
  return (await getSetting("system_stop")) === "true";
}

export async function setSystemStop(stopped: boolean) {
  await setSetting("system_stop", stopped ? "true" : "false");
  await setSetting("system_stop_changed_at", new Date().toISOString());
}

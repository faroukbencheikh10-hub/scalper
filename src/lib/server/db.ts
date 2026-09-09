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
      quality_score integer,
      outcome text,
      result_r numeric,
      mt5_order_id text,
      mt5_position_id text,
      mt5_open_price numeric,
      mt5_close_price numeric,
      mt5_volume numeric,
      mt5_profit numeric,
      mt5_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      closed_at timestamptz
    );
    ALTER TABLE scalper_signals ADD COLUMN IF NOT EXISTS quality_score integer;
    ALTER TABLE scalper_signals ADD COLUMN IF NOT EXISTS mt5_volume numeric;
    CREATE INDEX IF NOT EXISTS scalper_signals_created_at_idx ON scalper_signals(created_at DESC);
    CREATE INDEX IF NOT EXISTS scalper_signals_open_idx ON scalper_signals(created_at DESC)
      WHERE outcome IS NULL AND direction IN ('BUY','SELL');
    CREATE INDEX IF NOT EXISTS scalper_signals_closed_idx ON scalper_signals(closed_at DESC)
      WHERE outcome IS NOT NULL;
    CREATE INDEX IF NOT EXISTS scalper_signals_executed_today_idx ON scalper_signals(created_at DESC)
      WHERE mt5_order_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS scalper_signals_quality_score_idx ON scalper_signals(quality_score,closed_at DESC)
      WHERE quality_score IS NOT NULL;

    CREATE OR REPLACE FUNCTION capture_scalper_shadow_score() RETURNS trigger AS $$
    DECLARE score_match text[];
    BEGIN
      score_match := regexp_match(COALESCE(NEW.reasoning,''), '\\[shadow-score:([0-9]{1,3})\\]');
      IF score_match IS NULL THEN
        NEW.quality_score := NULL;
      ELSE
        NEW.quality_score := LEAST(100,GREATEST(0,score_match[1]::int));
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS scalper_shadow_score_capture ON scalper_signals;
    CREATE TRIGGER scalper_shadow_score_capture
      BEFORE INSERT OR UPDATE OF reasoning ON scalper_signals
      FOR EACH ROW EXECUTE FUNCTION capture_scalper_shadow_score();

    CREATE TABLE IF NOT EXISTS scalper_settings (
      key text PRIMARY KEY,
      value text NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS trades (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source text NOT NULL DEFAULT 'scalper',
      scalper_signal_id text,
      symbol text,
      mt5_position_id text,
      direction text,
      lot numeric,
      open_price numeric,
      close_price numeric,
      profit numeric,
      result_r numeric,
      reason text,
      opened_at timestamptz,
      closed_at timestamptz NOT NULL DEFAULT now(),
      payload jsonb
    );
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS source text DEFAULT 'scalper';
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS scalper_signal_id text;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS symbol text;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS mt5_position_id text;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS direction text;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS lot numeric;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS open_price numeric;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS close_price numeric;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS profit numeric;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS result_r numeric;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS reason text;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS opened_at timestamptz;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS closed_at timestamptz DEFAULT now();
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS payload jsonb;
    CREATE INDEX IF NOT EXISTS trades_closed_at_idx ON trades(closed_at DESC);

    CREATE OR REPLACE FUNCTION sync_scalper_signal_trade() RETURNS trigger AS $$
    BEGIN
      IF NEW.outcome IN ('WIN','LOSS','BREAKEVEN') AND NEW.mt5_position_id IS NOT NULL THEN
        UPDATE trades SET
          scalper_signal_id=NEW.id::text,
          symbol='XAUUSD',
          direction=NEW.direction,
          lot=COALESCE(NEW.mt5_volume,lot),
          open_price=COALESCE(NEW.mt5_open_price,open_price),
          close_price=NEW.mt5_close_price,
          profit=NEW.mt5_profit,
          result_r=NEW.result_r,
          opened_at=NEW.created_at,
          closed_at=COALESCE(NEW.closed_at,now()),
          payload=jsonb_build_object('setup',NEW.setup,'outcome',NEW.outcome,'qualityScore',NEW.quality_score)
        WHERE source='scalper' AND mt5_position_id=NEW.mt5_position_id;
        IF NOT FOUND THEN
          INSERT INTO trades(
            source,scalper_signal_id,symbol,mt5_position_id,direction,lot,open_price,close_price,
            profit,result_r,reason,opened_at,closed_at,payload
          ) VALUES (
            'scalper',NEW.id::text,'XAUUSD',NEW.mt5_position_id,NEW.direction,NEW.mt5_volume,NEW.mt5_open_price,
            NEW.mt5_close_price,NEW.mt5_profit,NEW.result_r,'normal',NEW.created_at,
            COALESCE(NEW.closed_at,now()),jsonb_build_object('setup',NEW.setup,'outcome',NEW.outcome,'qualityScore',NEW.quality_score)
          );
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS scalper_signal_trade_sync ON scalper_signals;
    CREATE TRIGGER scalper_signal_trade_sync
      AFTER INSERT OR UPDATE OF outcome,mt5_close_price,mt5_profit,result_r,closed_at ON scalper_signals
      FOR EACH ROW EXECUTE FUNCTION sync_scalper_signal_trade();

    INSERT INTO trades(
      source,scalper_signal_id,symbol,mt5_position_id,direction,lot,open_price,close_price,
      profit,result_r,reason,opened_at,closed_at,payload
    )
    SELECT
      'scalper',s.id::text,'XAUUSD',s.mt5_position_id,s.direction,s.mt5_volume,s.mt5_open_price,s.mt5_close_price,
      s.mt5_profit,s.result_r,'normal',s.created_at,COALESCE(s.closed_at,now()),
      jsonb_build_object('setup',s.setup,'outcome',s.outcome,'qualityScore',s.quality_score)
    FROM scalper_signals s
    WHERE s.outcome IN ('WIN','LOSS','BREAKEVEN') AND s.mt5_position_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM trades t WHERE t.source='scalper' AND t.mt5_position_id=s.mt5_position_id
      );
  `);
}

export async function getSetting(key: string) {
  const r = await dbQuery(`SELECT value FROM scalper_settings WHERE key=$1`, [key]);
  return r.rows[0]?.value as string | undefined;
}
export async function getSettings(keys: readonly string[]) {
  const r = await dbQuery(`SELECT key,value FROM scalper_settings WHERE key = ANY($1::text[])`, [keys]);
  const map = new Map<string, string>();
  for (const row of r.rows as Array<{ key: string; value: string }>) map.set(row.key, row.value);
  return map;
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

import pg from 'pg';

const { Pool, types } = pg;

// Records are typed with `string` timestamps (e.g. createdAt: string). By
// default node-postgres parses timestamp/timestamptz into JS Date objects, so
// register identity parsers to keep the raw string form flowing through.
types.setTypeParser(1114, (v) => v); // timestamp
types.setTypeParser(1184, (v) => v); // timestamptz

export type Db = pg.Pool;

/**
 * Anything we can run a parameterised query against. Both a pooled connection
 * (pg.Pool) and a single checked-out client (pg.PoolClient) satisfy this, which
 * is what lets Repository.transaction() rebind the repo to a transactional
 * client without changing any query code.
 */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/**
 * The full schema. Exported so production migration and the pg-mem test pool run
 * byte-for-byte the same DDL. `id` columns use `serial` (int4) on purpose: pg
 * returns bigint as a string, which would break the `id: number` record types.
 * `disabled` stays integer (0/1) to preserve the existing TS types and mappings.
 */
export const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS subscriptions (
    id              serial PRIMARY KEY,
    app_id          text NOT NULL,
    user_id         text,
    endpoint        text NOT NULL UNIQUE,
    p256dh          text NOT NULL,
    auth            text NOT NULL,
    user_agent      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_success_at timestamptz,
    failure_count   integer NOT NULL DEFAULT 0,
    disabled        integer NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_subscriptions_app  ON subscriptions(app_id);
  CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(app_id, user_id);

  CREATE TABLE IF NOT EXISTS notification_logs (
    id          serial PRIMARY KEY,
    app_id      text NOT NULL,
    user_id     text,
    endpoint    text NOT NULL,
    title       text,
    status      text NOT NULL,
    status_code integer,
    error       text,
    created_at  timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_logs_app ON notification_logs(app_id, created_at);

  CREATE TABLE IF NOT EXISTS apps (
    app_id     text PRIMARY KEY,
    name       text NOT NULL,
    disabled   integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id           serial PRIMARY KEY,
    app_id       text NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
    key_hash     text NOT NULL UNIQUE,
    key_prefix   text NOT NULL,
    label        text,
    created_by   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at   timestamptz
  );
  CREATE INDEX IF NOT EXISTS idx_api_keys_app ON api_keys(app_id);

  CREATE TABLE IF NOT EXISTS cors_origins (
    id         serial PRIMARY KEY,
    app_id     text NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
    origin     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(app_id, origin)
  );

  CREATE TABLE IF NOT EXISTS admins (
    address    text PRIMARY KEY,
    label      text,
    added_by   text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

/** Opens a pooled Postgres connection and ensures the schema exists. */
export async function openDatabase(connectionString: string): Promise<pg.Pool> {
  const pool = new Pool({ connectionString, max: 10 });
  await pool.query(MIGRATION_SQL);
  return pool;
}

import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Opens (and migrates) the SQLite database. SQLite keeps the service genuinely
 * self-contained — no external database process to run. The schema is small
 * enough that a Postgres adapter could be swapped in behind the repository
 * layer later without touching the rest of the code.
 */
export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id         TEXT    NOT NULL,
      user_id        TEXT,
      endpoint       TEXT    NOT NULL UNIQUE,
      p256dh         TEXT    NOT NULL,
      auth           TEXT    NOT NULL,
      user_agent     TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      last_success_at TEXT,
      failure_count  INTEGER NOT NULL DEFAULT 0,
      disabled       INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_subscriptions_app  ON subscriptions(app_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(app_id, user_id);

    CREATE TABLE IF NOT EXISTS notification_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id      TEXT    NOT NULL,
      user_id     TEXT,
      endpoint    TEXT    NOT NULL,
      title       TEXT,
      status      TEXT    NOT NULL,
      status_code INTEGER,
      error       TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_logs_app ON notification_logs(app_id, created_at);

    CREATE TABLE IF NOT EXISTS apps (
      app_id     TEXT    PRIMARY KEY,
      name       TEXT    NOT NULL,
      disabled   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id       TEXT    NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
      key_hash     TEXT    NOT NULL UNIQUE,
      key_prefix   TEXT    NOT NULL,
      label        TEXT,
      created_by   TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_app ON api_keys(app_id);

    CREATE TABLE IF NOT EXISTS cors_origins (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id     TEXT    NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
      origin     TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(app_id, origin)
    );

    CREATE TABLE IF NOT EXISTS admins (
      address    TEXT    PRIMARY KEY,
      label      TEXT,
      added_by   TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

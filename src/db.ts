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
  `);
}

import type Database from 'better-sqlite3';
import type { PushSubscriptionJSON, SubscriptionRecord } from './types.js';

interface SubscriptionRow {
  id: number;
  app_id: string;
  user_id: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  last_success_at: string | null;
  failure_count: number;
  disabled: number;
}

function toRecord(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    appId: row.app_id,
    userId: row.user_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSuccessAt: row.last_success_at,
    failureCount: row.failure_count,
    disabled: row.disabled,
  };
}

/**
 * Data access for subscriptions and delivery logs. All persistence lives here
 * so the HTTP and push layers stay storage-agnostic.
 */
export class Repository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert a subscription, or refresh it if the endpoint already exists. The
   * endpoint is the stable unique identifier of a browser push channel, so an
   * upsert keeps re-subscriptions (and re-enables previously dead ones) clean.
   */
  upsertSubscription(input: {
    appId: string;
    userId: string | null;
    subscription: PushSubscriptionJSON;
    userAgent: string | null;
  }): SubscriptionRecord {
    const { appId, userId, subscription, userAgent } = input;
    const row = this.db
      .prepare(
        `INSERT INTO subscriptions (app_id, user_id, endpoint, p256dh, auth, user_agent)
         VALUES (@appId, @userId, @endpoint, @p256dh, @auth, @userAgent)
         ON CONFLICT(endpoint) DO UPDATE SET
           app_id        = excluded.app_id,
           user_id       = excluded.user_id,
           p256dh        = excluded.p256dh,
           auth          = excluded.auth,
           user_agent    = excluded.user_agent,
           failure_count = 0,
           disabled      = 0
         RETURNING *`,
      )
      .get({
        appId,
        userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent,
      }) as SubscriptionRow;
    return toRecord(row);
  }

  deleteByEndpoint(endpoint: string): boolean {
    const info = this.db
      .prepare('DELETE FROM subscriptions WHERE endpoint = ?')
      .run(endpoint);
    return info.changes > 0;
  }

  /** Active subscriptions for a target. Pass userId=null to match an entire app. */
  findActive(appId: string, userId?: string | null): SubscriptionRecord[] {
    const base = 'SELECT * FROM subscriptions WHERE app_id = ? AND disabled = 0';
    const rows =
      userId === undefined
        ? (this.db.prepare(base).all(appId) as SubscriptionRow[])
        : (this.db
            .prepare(`${base} AND user_id IS ?`)
            .all(appId, userId) as SubscriptionRow[]);
    return rows.map(toRecord);
  }

  markSuccess(id: number): void {
    this.db
      .prepare(
        `UPDATE subscriptions
         SET last_success_at = datetime('now'), failure_count = 0
         WHERE id = ?`,
      )
      .run(id);
  }

  /** Records a failure; disables the subscription once maxFailures is reached. */
  markFailure(id: number, maxFailures: number): void {
    this.db
      .prepare(
        `UPDATE subscriptions
         SET failure_count = failure_count + 1,
             disabled = CASE WHEN failure_count + 1 >= ? THEN 1 ELSE disabled END
         WHERE id = ?`,
      )
      .run(maxFailures, id);
  }

  logDelivery(entry: {
    appId: string;
    userId: string | null;
    endpoint: string;
    title: string | null;
    status: 'sent' | 'failed' | 'expired';
    statusCode: number | null;
    error: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO notification_logs (app_id, user_id, endpoint, title, status, status_code, error)
         VALUES (@appId, @userId, @endpoint, @title, @status, @statusCode, @error)`,
      )
      .run(entry);
  }

  recentLogs(appId: string, limit: number): unknown[] {
    return this.db
      .prepare(
        `SELECT * FROM notification_logs
         WHERE app_id = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(appId, limit);
  }

  countSubscriptions(appId: string): { total: number; active: number } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN disabled = 0 THEN 1 ELSE 0 END) AS active
         FROM subscriptions WHERE app_id = ?`,
      )
      .get(appId) as { total: number; active: number | null };
    return { total: row.total, active: row.active ?? 0 };
  }
}

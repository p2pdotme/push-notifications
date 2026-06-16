import type Database from 'better-sqlite3';
import type {
  AdminRecord,
  ApiKeyRecord,
  AppRecord,
  CorsOriginRecord,
  PushSubscriptionJSON,
  SubscriptionRecord,
} from './types.js';

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

interface AppRow {
  app_id: string;
  name: string;
  disabled: number;
  created_at: string;
}

function toAppRecord(row: AppRow): AppRecord {
  return {
    appId: row.app_id,
    name: row.name,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
  };
}

interface ApiKeyRow {
  id: number;
  app_id: string;
  key_prefix: string;
  label: string | null;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function toApiKeyRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    appId: row.app_id,
    keyPrefix: row.key_prefix,
    label: row.label,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

interface CorsOriginRow {
  id: number;
  app_id: string;
  origin: string;
  created_at: string;
}

function toCorsOriginRecord(row: CorsOriginRow): CorsOriginRecord {
  return { id: row.id, appId: row.app_id, origin: row.origin, createdAt: row.created_at };
}

interface AdminRow {
  address: string;
  label: string | null;
  added_by: string | null;
  created_at: string;
}

function toAdminRecord(row: AdminRow): AdminRecord {
  return { address: row.address, label: row.label, addedBy: row.added_by, createdAt: row.created_at };
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

  // --- Apps -----------------------------------------------------------------

  createApp(input: { appId: string; name: string }): AppRecord {
    const row = this.db
      .prepare(
        `INSERT INTO apps (app_id, name) VALUES (@appId, @name) RETURNING *`,
      )
      .get(input) as AppRow;
    return toAppRecord(row);
  }

  listApps(): AppRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM apps ORDER BY created_at')
      .all() as AppRow[];
    return rows.map(toAppRecord);
  }

  getApp(appId: string): AppRecord | null {
    const row = this.db
      .prepare('SELECT * FROM apps WHERE app_id = ?')
      .get(appId) as AppRow | undefined;
    return row ? toAppRecord(row) : null;
  }

  updateApp(
    appId: string,
    patch: { name?: string; disabled?: boolean },
  ): AppRecord | null {
    const current = this.getApp(appId);
    if (!current) return null;
    const name = patch.name ?? current.name;
    const disabled = patch.disabled ?? current.disabled;
    this.db
      .prepare('UPDATE apps SET name = ?, disabled = ? WHERE app_id = ?')
      .run(name, disabled ? 1 : 0, appId);
    return this.getApp(appId);
  }

  deleteApp(appId: string): boolean {
    return this.db.prepare('DELETE FROM apps WHERE app_id = ?').run(appId).changes > 0;
  }

  // --- API keys -------------------------------------------------------------

  createApiKey(input: {
    appId: string;
    keyHash: string;
    keyPrefix: string;
    label: string | null;
    createdBy: string | null;
  }): ApiKeyRecord {
    const row = this.db
      .prepare(
        `INSERT INTO api_keys (app_id, key_hash, key_prefix, label, created_by)
         VALUES (@appId, @keyHash, @keyPrefix, @label, @createdBy)
         RETURNING id, app_id, key_prefix, label, created_by, created_at, last_used_at, revoked_at`,
      )
      .get(input) as ApiKeyRow;
    return toApiKeyRecord(row);
  }

  listApiKeys(appId: string): ApiKeyRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, app_id, key_prefix, label, created_by, created_at, last_used_at, revoked_at
         FROM api_keys WHERE app_id = ? ORDER BY created_at DESC`,
      )
      .all(appId) as ApiKeyRow[];
    return rows.map(toApiKeyRecord);
  }

  /** Active (non-revoked) key for a hash, joined with its app. Null if none. */
  findActiveApiKeyByHash(keyHash: string): ApiKeyRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, app_id, key_prefix, label, created_by, created_at, last_used_at, revoked_at
         FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`,
      )
      .get(keyHash) as ApiKeyRow | undefined;
    return row ? toApiKeyRecord(row) : null;
  }

  revokeApiKey(id: number): boolean {
    return (
      this.db
        .prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL")
        .run(id).changes > 0
    );
  }

  touchApiKey(id: number): void {
    this.db
      .prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?")
      .run(id);
  }

  // --- CORS origins ---------------------------------------------------------

  addCorsOrigin(input: { appId: string; origin: string }): CorsOriginRecord {
    const row = this.db
      .prepare(
        `INSERT INTO cors_origins (app_id, origin) VALUES (@appId, @origin)
         ON CONFLICT(app_id, origin) DO UPDATE SET origin = excluded.origin
         RETURNING *`,
      )
      .get(input) as CorsOriginRow;
    return toCorsOriginRecord(row);
  }

  listCorsOrigins(appId: string): CorsOriginRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM cors_origins WHERE app_id = ? ORDER BY origin')
      .all(appId) as CorsOriginRow[];
    return rows.map(toCorsOriginRecord);
  }

  deleteCorsOrigin(id: number): boolean {
    return this.db.prepare('DELETE FROM cors_origins WHERE id = ?').run(id).changes > 0;
  }

  isOriginAllowedForApp(appId: string, origin: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM cors_origins WHERE app_id = ? AND origin = ? LIMIT 1')
      .get(appId, origin);
    return row !== undefined;
  }

  isOriginAllowedForAny(origin: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM cors_origins WHERE origin = ? LIMIT 1')
      .get(origin);
    return row !== undefined;
  }

  // --- Admins ---------------------------------------------------------------

  addAdmin(input: { address: string; label: string | null; addedBy: string | null }): AdminRecord {
    const row = this.db
      .prepare(
        `INSERT INTO admins (address, label, added_by)
         VALUES (@address, @label, @addedBy)
         ON CONFLICT(address) DO UPDATE SET label = excluded.label
         RETURNING *`,
      )
      .get({ ...input, address: input.address.toLowerCase() }) as AdminRow;
    return toAdminRecord(row);
  }

  listAdmins(): AdminRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM admins ORDER BY created_at')
      .all() as AdminRow[];
    return rows.map(toAdminRecord);
  }

  removeAdmin(address: string): boolean {
    return (
      this.db.prepare('DELETE FROM admins WHERE address = ?').run(address.toLowerCase()).changes > 0
    );
  }

  isDbAdmin(address: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM admins WHERE address = ? LIMIT 1')
      .get(address.toLowerCase());
    return row !== undefined;
  }
}

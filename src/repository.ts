import type { Queryable } from './db.js';
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
  require_subscription_signature: number;
  created_at: string;
}

function toAppRecord(row: AppRow): AppRecord {
  return {
    appId: row.app_id,
    name: row.name,
    disabled: row.disabled === 1,
    requireSubscriptionSignature: row.require_subscription_signature === 1,
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
 * Rewrites `@name` placeholders into positional `$1..$n` and collects the values
 * in order, so queries stay readable while satisfying node-postgres (which has
 * no native named parameters).
 */
function sql(text: string, params: Record<string, unknown> = {}): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const out = text.replace(/@(\w+)/g, (_m, name: string) => {
    if (!(name in params)) throw new Error(`Missing SQL param: ${name}`);
    values.push(params[name]);
    return `$${values.length}`;
  });
  return { text: out, values };
}

/**
 * Data access for subscriptions, delivery logs, and the admin plane. All
 * persistence lives here so the HTTP and push layers stay storage-agnostic.
 */
export class Repository {
  constructor(private readonly db: Queryable) {}

  /** Run `fn` inside a single Postgres transaction on a dedicated client. */
  async transaction<T>(fn: (tx: Repository) => Promise<T>): Promise<T> {
    // db is a Pool at the top level; .connect() checks out one client so every
    // call inside the callback shares the same BEGIN/COMMIT scope.
    if (typeof (this.db as { connect?: unknown }).connect !== 'function') {
      throw new Error('transaction() must be called on a Pool-backed Repository, not inside another transaction');
    }
    const pool = this.db as unknown as import('pg').Pool;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new Repository(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async upsertSubscription(input: {
    appId: string;
    userId: string | null;
    subscription: PushSubscriptionJSON;
    userAgent: string | null;
  }): Promise<SubscriptionRecord> {
    const { appId, userId, subscription, userAgent } = input;
    const q = sql(
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
      { appId, userId, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, userAgent },
    );
    const { rows } = await this.db.query(q.text, q.values);
    return toRecord(rows[0] as SubscriptionRow);
  }

  async deleteByEndpoint(endpoint: string): Promise<boolean> {
    const res = await this.db.query('DELETE FROM subscriptions WHERE endpoint = $1', [endpoint]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Active subscriptions for a target. Pass userId=null to match a user with no id; omit it to match the whole app. */
  async findActive(appId: string, userId?: string | null): Promise<SubscriptionRecord[]> {
    if (userId === undefined) {
      const { rows } = await this.db.query(
        'SELECT * FROM subscriptions WHERE app_id = $1 AND disabled = 0',
        [appId],
      );
      return (rows as SubscriptionRow[]).map(toRecord);
    }
    // Null-safe equality: match rows where user_id equals $2, treating NULL = NULL.
    const { rows } = await this.db.query(
      userId == null
        ? 'SELECT * FROM subscriptions WHERE app_id = $1 AND disabled = 0 AND user_id IS NULL'
        : 'SELECT * FROM subscriptions WHERE app_id = $1 AND disabled = 0 AND user_id = $2',
      userId == null ? [appId] : [appId, userId],
    );
    return (rows as SubscriptionRow[]).map(toRecord);
  }

  async markSuccess(id: number): Promise<void> {
    await this.db.query(
      `UPDATE subscriptions SET last_success_at = now(), failure_count = 0 WHERE id = $1`,
      [id],
    );
  }

  /** Records a failure; disables the subscription once maxFailures is reached. */
  async markFailure(id: number, maxFailures: number): Promise<void> {
    await this.db.query(
      `UPDATE subscriptions
       SET failure_count = failure_count + 1,
           disabled = CASE WHEN failure_count + 1 >= $1 THEN 1 ELSE disabled END
       WHERE id = $2`,
      [maxFailures, id],
    );
  }

  async logDelivery(entry: {
    appId: string;
    userId: string | null;
    endpoint: string;
    title: string | null;
    status: 'sent' | 'failed' | 'expired';
    statusCode: number | null;
    error: string | null;
  }): Promise<void> {
    const q = sql(
      `INSERT INTO notification_logs (app_id, user_id, endpoint, title, status, status_code, error)
       VALUES (@appId, @userId, @endpoint, @title, @status, @statusCode, @error)`,
      entry,
    );
    await this.db.query(q.text, q.values);
  }

  async recentLogs(appId: string, limit: number): Promise<unknown[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM notification_logs WHERE app_id = $1 ORDER BY id DESC LIMIT $2`,
      [appId, limit],
    );
    return rows;
  }

  /** Delete logs older than `days`. No-op (returns 0) when days <= 0. */
  async pruneOldLogs(days: number): Promise<number> {
    if (days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const res = await this.db.query(
      `DELETE FROM notification_logs WHERE created_at < $1::timestamptz`,
      [cutoff],
    );
    return res.rowCount ?? 0;
  }

  async countSubscriptions(appId: string): Promise<{ total: number; active: number }> {
    const { rows } = await this.db.query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(CASE WHEN disabled = 0 THEN 1 ELSE 0 END), 0)::int AS active
       FROM subscriptions WHERE app_id = $1`,
      [appId],
    );
    return { total: rows[0].total, active: rows[0].active };
  }

  // --- Apps -----------------------------------------------------------------

  async createApp(input: { appId: string; name: string }): Promise<AppRecord> {
    const q = sql(`INSERT INTO apps (app_id, name) VALUES (@appId, @name) RETURNING *`, input);
    const { rows } = await this.db.query(q.text, q.values);
    return toAppRecord(rows[0] as AppRow);
  }

  async listApps(): Promise<AppRecord[]> {
    const { rows } = await this.db.query('SELECT * FROM apps ORDER BY created_at');
    return (rows as AppRow[]).map(toAppRecord);
  }

  async getApp(appId: string): Promise<AppRecord | null> {
    const { rows } = await this.db.query('SELECT * FROM apps WHERE app_id = $1', [appId]);
    return rows[0] ? toAppRecord(rows[0] as AppRow) : null;
  }

  async updateApp(
    appId: string,
    patch: { name?: string; disabled?: boolean; requireSubscriptionSignature?: boolean },
  ): Promise<AppRecord | null> {
    const current = await this.getApp(appId);
    if (!current) return null;
    const name = patch.name ?? current.name;
    const disabled = patch.disabled ?? current.disabled;
    const requireSig = patch.requireSubscriptionSignature ?? current.requireSubscriptionSignature;
    await this.db.query(
      'UPDATE apps SET name = $1, disabled = $2, require_subscription_signature = $3 WHERE app_id = $4',
      [name, disabled ? 1 : 0, requireSig ? 1 : 0, appId],
    );
    return this.getApp(appId);
  }

  async deleteApp(appId: string): Promise<boolean> {
    const res = await this.db.query('DELETE FROM apps WHERE app_id = $1', [appId]);
    return (res.rowCount ?? 0) > 0;
  }

  // --- API keys -------------------------------------------------------------

  async createApiKey(input: {
    appId: string;
    keyHash: string;
    keyPrefix: string;
    label: string | null;
    createdBy: string | null;
  }): Promise<ApiKeyRecord> {
    const q = sql(
      `INSERT INTO api_keys (app_id, key_hash, key_prefix, label, created_by)
       VALUES (@appId, @keyHash, @keyPrefix, @label, @createdBy)
       RETURNING id, app_id, key_prefix, label, created_by, created_at, last_used_at, revoked_at`,
      input,
    );
    const { rows } = await this.db.query(q.text, q.values);
    return toApiKeyRecord(rows[0] as ApiKeyRow);
  }

  async listApiKeys(appId: string): Promise<ApiKeyRecord[]> {
    const { rows } = await this.db.query(
      `SELECT id, app_id, key_prefix, label, created_by, created_at, last_used_at, revoked_at
       FROM api_keys WHERE app_id = $1 ORDER BY created_at DESC`,
      [appId],
    );
    return (rows as ApiKeyRow[]).map(toApiKeyRecord);
  }

  async findActiveApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const { rows } = await this.db.query(
      `SELECT k.id, k.app_id, k.key_prefix, k.label, k.created_by, k.created_at, k.last_used_at, k.revoked_at
       FROM api_keys k JOIN apps a ON a.app_id = k.app_id
       WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND a.disabled = 0`,
      [keyHash],
    );
    return rows[0] ? toApiKeyRecord(rows[0] as ApiKeyRow) : null;
  }

  async revokeApiKey(id: number): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async touchApiKey(id: number): Promise<void> {
    await this.db.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [id]);
  }

  // --- CORS origins ---------------------------------------------------------

  async addCorsOrigin(input: { appId: string; origin: string }): Promise<CorsOriginRecord> {
    const q = sql(
      `INSERT INTO cors_origins (app_id, origin) VALUES (@appId, @origin)
       ON CONFLICT(app_id, origin) DO UPDATE SET origin = excluded.origin
       RETURNING *`,
      input,
    );
    const { rows } = await this.db.query(q.text, q.values);
    return toCorsOriginRecord(rows[0] as CorsOriginRow);
  }

  async listCorsOrigins(appId: string): Promise<CorsOriginRecord[]> {
    const { rows } = await this.db.query('SELECT * FROM cors_origins WHERE app_id = $1 ORDER BY origin', [appId]);
    return (rows as CorsOriginRow[]).map(toCorsOriginRecord);
  }

  async deleteCorsOrigin(id: number): Promise<boolean> {
    const res = await this.db.query('DELETE FROM cors_origins WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async isOriginAllowedForApp(appId: string, origin: string): Promise<boolean> {
    const { rows } = await this.db.query(
      'SELECT 1 FROM cors_origins WHERE app_id = $1 AND origin = $2 LIMIT 1',
      [appId, origin],
    );
    return rows.length > 0;
  }

  async isOriginAllowedForAny(origin: string): Promise<boolean> {
    const { rows } = await this.db.query('SELECT 1 FROM cors_origins WHERE origin = $1 LIMIT 1', [origin]);
    return rows.length > 0;
  }

  // --- Admins ---------------------------------------------------------------

  async addAdmin(input: { address: string; label: string | null; addedBy: string | null }): Promise<AdminRecord> {
    const q = sql(
      `INSERT INTO admins (address, label, added_by)
       VALUES (@address, @label, @addedBy)
       ON CONFLICT(address) DO UPDATE SET label = excluded.label
       RETURNING *`,
      { ...input, address: input.address.toLowerCase() },
    );
    const { rows } = await this.db.query(q.text, q.values);
    return toAdminRecord(rows[0] as AdminRow);
  }

  async listAdmins(): Promise<AdminRecord[]> {
    const { rows } = await this.db.query('SELECT * FROM admins ORDER BY created_at');
    return (rows as AdminRow[]).map(toAdminRecord);
  }

  async removeAdmin(address: string): Promise<boolean> {
    const res = await this.db.query('DELETE FROM admins WHERE address = $1', [address.toLowerCase()]);
    return (res.rowCount ?? 0) > 0;
  }

  async isDbAdmin(address: string): Promise<boolean> {
    const { rows } = await this.db.query('SELECT 1 FROM admins WHERE address = $1 LIMIT 1', [address.toLowerCase()]);
    return rows.length > 0;
  }
}

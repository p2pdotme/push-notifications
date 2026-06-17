# Postgres Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the embedded SQLite store with managed PostgreSQL so the push service can run on Railway with automated backups and data decoupled from the compute instance.

**Architecture:** The data layer is already isolated behind `src/repository.ts`. We swap the synchronous `better-sqlite3` driver for asynchronous `pg` (node-postgres) with a connection `Pool`. Every `Repository` method becomes `async`; the ripple of `await` reaches all callers (routes, auth middleware, the push sender, the seeder, the composition root). SQL is translated from the SQLite dialect to PostgreSQL. Tests run against an in-memory `pg-mem` Pool that runs the exact same migration SQL, so `npm test` stays Docker-free.

**Tech Stack:** Node 20+, TypeScript (ESM, `tsx`), Express 4, `pg` ^8, `pg-mem` ^3 (test backend only), `node:test`.

## Global Constraints

- **ESM + NodeNext imports:** every relative import keeps its `.js` extension (e.g. `import { Repository } from './repository.js'`). Copy this exactly.
- **No new runtime services beyond Postgres.** `pg-mem` is a **devDependency** only.
- **Keep the existing public HTTP contract unchanged** — same routes, status codes, and JSON shapes. This is an internal storage swap, not an API change.
- **Integer ids stay JavaScript numbers.** Use `serial` (int4), never `bigserial`/`bigint` — node-postgres returns `int8` as a string, which would break `id: number` typing and `Number(req.params.id)` comparisons.
- **Timestamps stay strings.** Register `pg` type parsers for `timestamp`/`timestamptz` so records typed `createdAt: string` keep receiving strings, not `Date` objects.
- **`disabled` columns stay `integer` (0/1)**, not `boolean` — this preserves the existing `SubscriptionRecord.disabled: number` type and the `row.disabled === 1` mappings, minimizing churn. Deliberate, documented choice.
- Run the full suite with `npm test` and the type check with `npm run typecheck` at every "run tests" step.

---

## Design notes (read before starting)

### SQLite → PostgreSQL dialect mapping

| SQLite (today) | PostgreSQL (target) | Notes |
| --- | --- | --- |
| `@named` params via `.get({...})` | `$1, $2` positional | A small `sql()` helper (Task 1) converts `@name` + an object to positional, keeping queries readable. |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `serial PRIMARY KEY` | Keeps int4 → JS `number`. |
| `datetime('now')` | `now()` | In DEFAULTs and `markSuccess`/`touchApiKey`. |
| `WHERE user_id IS ?` (null-safe eq) | `WHERE user_id IS NOT DISTINCT FROM $n` | **Critical:** PG `IS` only accepts NULL/TRUE/FALSE literals; null-safe equality is `IS NOT DISTINCT FROM`. |
| `info.changes` | `result.rowCount` | For DELETE/UPDATE affected-row counts. |
| `RETURNING *` | `RETURNING *` | Identical — no change. |
| `ON CONFLICT(col) DO UPDATE SET x = excluded.x` | identical | PG uses the same `excluded` pseudo-table. |
| `COUNT(*)`, `SUM(...)` | `COUNT(*)::int`, `COALESCE(SUM(...),0)::int` | PG returns aggregates as `bigint` (string) without the cast. |
| `datetime('now', '-N days')` (prune) | compute cutoff `Date` in JS, `created_at < $1::timestamptz` | Avoids relying on interval arithmetic; engine-agnostic. |
| `db.pragma(...)` (WAL etc.) | removed | Not applicable to Postgres. |

### The `Queryable` abstraction & transactions

`Repository` is constructed with a `Queryable` — anything exposing `query(text, values)`. Both a `pg.Pool` and a `pg.PoolClient` satisfy it, which lets transactions work cleanly: `transaction()` acquires a dedicated client, wraps it in a **new `Repository`**, and passes that to the callback so every nested call runs on the same transactional connection.

```ts
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
```

`transaction<T>(fn: (tx: Repository) => Promise<T>): Promise<T>` replaces the old synchronous `transaction<T>(fn: () => T): T`. Only `seed.ts` uses it, so the blast radius is one file.

### Test backend decision: `pg-mem`

`npm test` must stay self-contained (no Docker), matching the current in-memory-SQLite ethos. We use **`pg-mem`**, which provides a node-postgres-compatible `Pool` and runs our real migration SQL. The migration SQL string is exported from `src/db.ts` (`MIGRATION_SQL`) so production and tests share one source of truth.

**Caveat (call out in the PR):** `pg-mem` is not a 100% faithful Postgres. It is excellent for the repository's CRUD but can differ on edge SQL. **Recommended follow-up (out of scope here):** add a CI job that re-runs the suite against a real Postgres service container by pointing a `createTestPool` variant at `TEST_DATABASE_URL`. The `createTestPool()` helper isolates this choice so swapping it later touches one file.

### File structure

| File | Change | Responsibility after change |
| --- | --- | --- |
| `src/db.ts` | Rewrite | Export `MIGRATION_SQL`; `openDatabase(connectionString)` → `Promise<pg.Pool>`; register timestamp parsers. |
| `src/repository.ts` | Rewrite | Async data access over a `Queryable`; `sql()` named-param helper; async `transaction()`. |
| `src/seed.ts` | Modify | `async`; use the transactional `tx` repo. |
| `src/webpush.ts` | Modify | `await` repo calls in `sendToOne`/`handleError`. |
| `src/auth.ts` | Modify | `apiKeyAuth` async; `isAdminAddress` async. |
| `src/routes/admin.ts` | Modify | All handlers `async` + `asyncHandler`; `await` repo. |
| `src/routes/subscriptions.ts` | Modify | Handlers `async` + `asyncHandler`; `await` repo. |
| `src/routes/notifications.ts` | Modify | `await` repo in send/logs; logs handler `async` + `asyncHandler`. |
| `src/routes/auth.ts` | Modify | `await isAdminAddress(...)`. |
| `src/server.ts` | Modify | `browserCors` async middleware (awaits `isOriginAllowedForAny`). |
| `src/config.ts` | Modify | `databasePath` → `databaseUrl` (`DATABASE_URL`, required). |
| `src/index.ts` | Modify | `async main()`; `await openDatabase`/`seedFromEnv`; `db.end()` on shutdown. |
| `src/types.ts` | No change | Types are preserved by the integer/string column choices. |
| `test/helpers/test-db.ts` | Create | `createTestPool()` → pg-mem Pool running `MIGRATION_SQL`. |
| `test/*.test.ts` | Modify | `await` repo calls; use `createTestPool()`; fix stale config. |
| `package.json` | Modify | Drop `better-sqlite3`/`@types/better-sqlite3`; add `pg`/`@types/pg`; add `pg-mem` (dev). |
| `Dockerfile` | Modify | Drop native-build toolchain and `VOLUME`. |
| `docker-compose.yml` | Modify | Add a `postgres` service; pass `DATABASE_URL`. |
| `.env.example` | Modify | `DATABASE_URL` replaces `DATABASE_PATH`. |
| `README.md` | Modify | Replace SQLite copy with Postgres + Railway. |
| `docs/railway-deployment.md` | Create | Railway + Netlify runbook. |

---

### Task 1: Postgres driver, `Queryable`, `sql()` helper, and schema

**Files:**
- Modify: `package.json` (dependencies)
- Rewrite: `src/db.ts`
- Test: `test/db.test.ts`
- Create: `test/helpers/test-db.ts`

**Interfaces:**
- Produces: `Queryable` interface; `MIGRATION_SQL: string`; `openDatabase(connectionString: string): Promise<import('pg').Pool>`; `createTestPool(): Promise<import('pg').Pool>`.

- [ ] **Step 1: Swap dependencies**

Run:
```bash
npm uninstall better-sqlite3 @types/better-sqlite3
npm install pg
npm install -D @types/pg pg-mem
```
Expected: `package.json` now lists `pg` under dependencies, `@types/pg` and `pg-mem` under devDependencies.

- [ ] **Step 2: Rewrite `src/db.ts`**

```ts
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
```

- [ ] **Step 3: Create `test/helpers/test-db.ts`**

```ts
import { newDb } from 'pg-mem';
import { MIGRATION_SQL } from '../../src/db.js';

/**
 * An in-memory Postgres-compatible Pool for tests. Runs the exact production
 * migration SQL so tests exercise the real schema without Docker. Swap the
 * body for a real `pg.Pool` against TEST_DATABASE_URL to run against true
 * Postgres in CI.
 */
export async function createTestPool() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await pool.query(MIGRATION_SQL);
  return pool as unknown as import('pg').Pool;
}
```

- [ ] **Step 4: Rewrite `test/db.test.ts` to assert the schema is queryable**

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPool } from './helpers/test-db.js';

describe('schema', () => {
  it('creates every admin-plane and core table', async () => {
    const pool = await createTestPool();
    for (const t of ['subscriptions', 'notification_logs', 'apps', 'api_keys', 'cors_origins', 'admins']) {
      // A SELECT that returns no rows still throws if the table is missing.
      await assert.doesNotReject(pool.query(`SELECT 1 FROM ${t} LIMIT 0`), `table ${t} should exist`);
    }
    await pool.end();
  });
});
```

- [ ] **Step 5: Run the schema test**

Run: `npm test`
Expected: the `schema` test passes. (Other suites will fail to compile/run until later tasks — that is expected mid-migration; confirm the `db.test.ts` assertions themselves pass.)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/db.ts test/db.test.ts test/helpers/test-db.ts
git commit -m "feat(db): add Postgres pool, shared migration SQL, pg-mem test pool"
```

---

### Task 2: Rewrite the Repository as async

**Files:**
- Rewrite: `src/repository.ts`
- Test: `test/repository.test.ts`

**Interfaces:**
- Consumes: `Queryable` from `src/db.js`.
- Produces: an async `Repository`. Every method returns a `Promise`; signatures otherwise match the old ones. New transaction signature: `transaction<T>(fn: (tx: Repository) => Promise<T>): Promise<T>`.

- [ ] **Step 1: Update `test/repository.test.ts` to async + pg-mem**

Replace the file with the async version (every `repo.x(...)` is awaited; `freshRepo` uses the test pool):

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../src/repository.js';
import { generateApiKey } from '../src/api-keys.js';
import { createTestPool } from './helpers/test-db.js';

async function freshRepo(): Promise<Repository> {
  return new Repository(await createTestPool());
}

describe('repository: apps', () => {
  it('creates, lists, gets, updates, and deletes apps', async () => {
    const repo = await freshRepo();
    await repo.createApp({ appId: 'user-app', name: 'User App' });
    assert.equal((await repo.listApps()).length, 1);

    const got = await repo.getApp('user-app');
    assert.equal(got?.name, 'User App');
    assert.equal(got?.disabled, false);

    await repo.updateApp('user-app', { name: 'Renamed', disabled: true });
    const updated = await repo.getApp('user-app');
    assert.equal(updated?.name, 'Renamed');
    assert.equal(updated?.disabled, true);

    await repo.deleteApp('user-app');
    assert.equal(await repo.getApp('user-app'), null);
  });
});

describe('repository: api keys', () => {
  it('creates, looks up by hash, lists, and revokes', async () => {
    const repo = await freshRepo();
    await repo.createApp({ appId: 'user-app', name: 'User App' });
    const k = generateApiKey();
    const rec = await repo.createApiKey({
      appId: 'user-app', keyHash: k.keyHash, keyPrefix: k.keyPrefix, label: 'ci', createdBy: '0xabc',
    });
    assert.equal((await repo.findActiveApiKeyByHash(k.keyHash))?.appId, 'user-app');
    assert.equal((await repo.listApiKeys('user-app')).length, 1);
    await repo.revokeApiKey(rec.id);
    assert.equal(await repo.findActiveApiKeyByHash(k.keyHash), null);
  });

  it('stops authenticating a key when its app is disabled', async () => {
    const repo = await freshRepo();
    await repo.createApp({ appId: 'user-app', name: 'User App' });
    const k = generateApiKey();
    await repo.createApiKey({ appId: 'user-app', keyHash: k.keyHash, keyPrefix: k.keyPrefix, label: null, createdBy: null });
    assert.equal((await repo.findActiveApiKeyByHash(k.keyHash))?.appId, 'user-app');
    await repo.updateApp('user-app', { disabled: true });
    assert.equal(await repo.findActiveApiKeyByHash(k.keyHash), null);
  });

  it('records last-used on touch', async () => {
    const repo = await freshRepo();
    await repo.createApp({ appId: 'user-app', name: 'User App' });
    const k = generateApiKey();
    const rec = await repo.createApiKey({ appId: 'user-app', keyHash: k.keyHash, keyPrefix: k.keyPrefix, label: null, createdBy: null });
    assert.equal((await repo.listApiKeys('user-app'))[0]?.lastUsedAt, null);
    await repo.touchApiKey(rec.id);
    assert.notEqual((await repo.listApiKeys('user-app'))[0]?.lastUsedAt, null);
  });
});

describe('repository: cors origins', () => {
  it('adds, lists, checks per-app and global, and deletes', async () => {
    const repo = await freshRepo();
    await repo.createApp({ appId: 'user-app', name: 'User App' });
    await repo.createApp({ appId: 'merchant-app', name: 'Merchant App' });
    const o = await repo.addCorsOrigin({ appId: 'user-app', origin: 'https://app.p2p.me' });
    assert.equal((await repo.listCorsOrigins('user-app')).length, 1);
    assert.equal(await repo.isOriginAllowedForApp('user-app', 'https://app.p2p.me'), true);
    assert.equal(await repo.isOriginAllowedForApp('merchant-app', 'https://app.p2p.me'), false);
    assert.equal(await repo.isOriginAllowedForAny('https://app.p2p.me'), true);
    assert.equal(await repo.isOriginAllowedForAny('https://evil.example'), false);
    await repo.deleteCorsOrigin(o.id);
    assert.equal(await repo.isOriginAllowedForAny('https://app.p2p.me'), false);
  });
});

describe('repository: admins', () => {
  it('adds (lowercased), lists, checks, and removes', async () => {
    const repo = await freshRepo();
    await repo.addAdmin({ address: '0xAbC', label: 'me', addedBy: '0xroot' });
    assert.equal(await repo.isDbAdmin('0xabc'), true);
    assert.equal(await repo.isDbAdmin('0xABC'), true);
    assert.equal((await repo.listAdmins()).length, 1);
    await repo.removeAdmin('0xabc');
    assert.equal(await repo.isDbAdmin('0xabc'), false);
  });
});

describe('pruneOldLogs', () => {
  it('deletes only rows older than the retention window', async () => {
    const pool = await createTestPool();
    const repo = new Repository(pool);
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const fresh = new Date().toISOString();
    await pool.query(
      `INSERT INTO notification_logs (app_id, endpoint, status, created_at) VALUES ($1,$2,$3,$4::timestamptz)`,
      ['a', 'e1', 'sent', old],
    );
    await pool.query(
      `INSERT INTO notification_logs (app_id, endpoint, status, created_at) VALUES ($1,$2,$3,$4::timestamptz)`,
      ['a', 'e2', 'sent', fresh],
    );
    assert.equal(await repo.pruneOldLogs(30), 1);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM notification_logs`);
    assert.equal(rows[0].n, 1);
    await pool.end();
  });

  it('is a no-op when days <= 0', async () => {
    const repo = new Repository(await createTestPool());
    assert.equal(await repo.pruneOldLogs(0), 0);
  });
});
```

- [ ] **Step 2: Run the repository test to verify it fails**

Run: `npm test`
Expected: FAIL — `Repository` methods still return non-Promises / `transaction` signature mismatch.

- [ ] **Step 3: Rewrite `src/repository.ts`**

The `toRecord`/`toAppRecord`/etc. mapper functions and the `*Row` interfaces are **unchanged** from the current file — keep them exactly as they are. Replace the class (and add the `sql` helper + `Queryable` import). Full new file:

```ts
import type { Queryable } from './db.js';
import type {
  AdminRecord,
  ApiKeyRecord,
  AppRecord,
  CorsOriginRecord,
  PushSubscriptionJSON,
  SubscriptionRecord,
} from './types.js';

// (Keep the existing SubscriptionRow/AppRow/ApiKeyRow/CorsOriginRow/AdminRow
//  interfaces and the toRecord/toAppRecord/toApiKeyRecord/toCorsOriginRecord/
//  toAdminRecord functions from the current file verbatim — omitted here only
//  for brevity. They do not change.)

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
    // IS NOT DISTINCT FROM is the null-safe equality SQLite expressed as `IS ?`.
    const { rows } = await this.db.query(
      'SELECT * FROM subscriptions WHERE app_id = $1 AND disabled = 0 AND user_id IS NOT DISTINCT FROM $2',
      [appId, userId],
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

  async updateApp(appId: string, patch: { name?: string; disabled?: boolean }): Promise<AppRecord | null> {
    const current = await this.getApp(appId);
    if (!current) return null;
    const name = patch.name ?? current.name;
    const disabled = patch.disabled ?? current.disabled;
    await this.db.query('UPDATE apps SET name = $1, disabled = $2 WHERE app_id = $3', [name, disabled ? 1 : 0, appId]);
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
```

- [ ] **Step 4: Run the repository test to verify it passes**

Run: `npm test`
Expected: every `repository`, `apps`, `api keys`, `cors origins`, `admins`, and `pruneOldLogs` test passes. (Suites in `webpush`/`api`/`seed` may still fail — fixed in later tasks.)

- [ ] **Step 5: Commit**

```bash
git add src/repository.ts test/repository.test.ts
git commit -m "feat(repository): async Postgres data access with named-param helper"
```

---

### Task 3: Async seed + transaction

**Files:**
- Modify: `src/seed.ts`
- Test: `test/seed.test.ts`

**Interfaces:**
- Consumes: `Repository.transaction((tx) => Promise<...>)`, async `Repository` methods.
- Produces: `seedFromEnv(repo, env): Promise<void>`.

- [ ] **Step 1: Read the current `test/seed.test.ts`** to learn its assertions, then update it so every `repo`/`seedFromEnv` call is awaited and the repo is built from `createTestPool()` (mirror the pattern from Task 2 Step 1). Keep the same assertions, just `await` them.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `seedFromEnv` is not awaited / `transaction` callback shape changed.

- [ ] **Step 3: Rewrite `src/seed.ts`**

```ts
import { hashApiKey } from './api-keys.js';
import type { Repository } from './repository.js';

/**
 * One-time migration of the legacy env config into the database. Runs only when
 * no apps exist yet, so the DB becomes the source of truth after first boot.
 * The `*` wildcard is skipped (per-app origins are explicit allow-list entries).
 */
export async function seedFromEnv(
  repo: Repository,
  env: { appKeys: Record<string, string>; corsOrigins: string[] },
): Promise<void> {
  if ((await repo.listApps()).length > 0) return;

  const origins = env.corsOrigins.filter((o) => o !== '*');

  // All-or-nothing: a crash mid-seed must not leave a partial state that the
  // `listApps().length > 0` guard would then refuse to re-seed.
  await repo.transaction(async (tx) => {
    for (const [appId, secret] of Object.entries(env.appKeys)) {
      await tx.createApp({ appId, name: appId });
      await tx.createApiKey({
        appId,
        keyHash: hashApiKey(secret),
        keyPrefix: secret.slice(0, 10),
        label: 'imported from APP_KEYS',
        createdBy: null,
      });
      for (const origin of origins) {
        await tx.addCorsOrigin({ appId, origin });
      }
    }
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test`
Expected: the `seed` suite passes.

> **Note for the implementer:** `pg-mem`'s pooled client must support `BEGIN`/`COMMIT`. If the transaction throws in pg-mem specifically (not real Postgres), fall back in `createTestPool` to a single shared client — but try the default first; pg-mem supports transactions.

- [ ] **Step 5: Commit**

```bash
git add src/seed.ts test/seed.test.ts
git commit -m "feat(seed): async env import inside a Postgres transaction"
```

---

### Task 4: Await repo in the push sender and auth middleware

**Files:**
- Modify: `src/webpush.ts`
- Modify: `src/auth.ts`
- Test: `test/api.test.ts` (and `test/admin.test.ts`, `test/api-keys.test.ts` if they touch these paths)

**Interfaces:**
- Consumes: async `Repository`.
- Produces: `apiKeyAuth` returns an async middleware; `isAdminAddress(address, config, repo): Promise<boolean>`.

- [ ] **Step 1: Update `src/webpush.ts`** — make `sendToOne` await the repo writes, and convert `handleError` to async:

In `sendToOne`, change the success branch to await:
```ts
      await this.repo.markSuccess(sub.id);
      await this.repo.logDelivery({
        appId: sub.appId,
        userId: sub.userId,
        endpoint: sub.endpoint,
        title: payload.title,
        status: 'sent',
        statusCode: res.statusCode,
        error: null,
      });
      return { endpoint: sub.endpoint, success: true, statusCode: res.statusCode };
    } catch (err) {
      return this.handleError(sub, payload, err);
    }
```
…and make the catch `return await this.handleError(...)` by changing the signature:
```ts
  private async handleError(
    sub: SubscriptionRecord,
    payload: NotificationPayload,
    err: unknown,
  ): Promise<SendResult> {
    const statusCode = err instanceof WebPushError ? err.statusCode : undefined;
    const expired = statusCode === 404 || statusCode === 410;

    if (expired) {
      await this.repo.deleteByEndpoint(sub.endpoint);
    } else {
      await this.repo.markFailure(sub.id, this.config.maxFailures);
    }

    const message = err instanceof Error ? err.message : String(err);
    await this.repo.logDelivery({
      appId: sub.appId,
      userId: sub.userId,
      endpoint: sub.endpoint,
      title: payload.title,
      status: expired ? 'expired' : 'failed',
      statusCode: statusCode ?? null,
      error: message,
    });

    return { endpoint: sub.endpoint, success: false, statusCode, expired, error: message };
  }
```
(`sendToOne` already returns `this.handleError(...)`; since it's now a Promise, the existing `return this.handleError(...)` resolves correctly — no further change needed there.)

- [ ] **Step 2: Update `src/auth.ts`** — async `apiKeyAuth` and async `isAdminAddress`:

```ts
export function apiKeyAuth(config: Config, repo: Repository) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const provided = req.header('x-api-key');
      if (!provided) {
        res.status(401).json({ error: 'Missing x-api-key header' });
        return;
      }
      if (safeEqual(provided, config.adminApiKey)) {
        req.auth = { isAdmin: true, appId: null };
        next();
        return;
      }
      const key = await repo.findActiveApiKeyByHash(hashApiKey(provided));
      if (key) {
        await repo.touchApiKey(key.id);
        req.auth = { isAdmin: false, appId: key.appId };
        next();
        return;
      }
      res.status(403).json({ error: 'Invalid API key' });
    } catch (err) {
      next(err);
    }
  };
}
```

```ts
/** True when an address is a bootstrap (env) admin or a DB-managed admin. */
export async function isAdminAddress(address: string, config: Config, repo: Repository): Promise<boolean> {
  const lower = address.toLowerCase();
  return config.adminWallets.includes(lower) || (await repo.isDbAdmin(lower));
}
```

And in `requireAdmin`, await the now-async check:
```ts
      if (!(await isAdminAddress(verified.address, config, repo))) {
        res.status(403).json({ error: 'Wallet not authorized' });
        return;
      }
```

- [ ] **Step 3: Update `test/api.test.ts`** — fix the stale config and async setup:

Replace the `config` object's auth fields and DB path (drop the obsolete `thirdweb` key; add the current fields) and build the server from a test pool:

```ts
import { createTestPool } from './helpers/test-db.js';
// ...
const config: Config = {
  port: 0,
  host: '127.0.0.1',
  corsOrigins: ['*'],
  vapid: { publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: 'mailto:test@p2p.me' },
  databaseUrl: 'postgres://test',           // unused: tests inject a pool directly
  adminApiKey: 'admin-key',
  appKeys: { 'user-app': 'user-key', 'merchant-app': 'merchant-key' },
  maxFailures: 5,
  adminWallets: [],
  dashboardOrigin: 'http://localhost:5173',
  authDomain: 'localhost',
  jwtSecret: 'test-secret-please-change-please-change',
  sendConcurrency: 25,
  logRetentionDays: 0,
};
// ...
before(async () => {
  const pool = await createTestPool();
  const repo = new Repository(pool);
  const sender = new PushSender(config, repo);
  await seedFromEnv(repo, { appKeys: config.appKeys, corsOrigins: [] });
  const app = createServer(config, repo, sender, new FakeAuthService());
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});
```
Replace the `openDatabase`/`Repository(db)` import usage accordingly (drop the `openDatabase` import; keep `Repository`).

- [ ] **Step 4: Audit `test/admin.test.ts` and `test/api-keys.test.ts`** for the same `openDatabase(':memory:')` + synchronous-repo patterns and the stale `thirdweb` config; apply the identical async + `createTestPool` + current-config updates. (Read each file first; mirror the transformations above.)

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: `api`, `admin`, `api-keys` suites pass. Compilation of `src/routes/*` and `src/server.ts` may still error because those callers aren't awaited yet — proceed to Task 5, then re-run.

- [ ] **Step 6: Commit**

```bash
git add src/webpush.ts src/auth.ts test/api.test.ts test/admin.test.ts test/api-keys.test.ts
git commit -m "feat(auth,webpush): await async repository in middleware and sender"
```

---

### Task 5: Await repo in routes and server middleware

**Files:**
- Modify: `src/routes/admin.ts`
- Modify: `src/routes/subscriptions.ts`
- Modify: `src/routes/notifications.ts`
- Modify: `src/routes/auth.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: async `Repository`, async `isAdminAddress`, `asyncHandler`.
- Produces: no new exports; all route handlers become async and are wrapped so rejections reach the error middleware.

- [ ] **Step 1: `src/routes/admin.ts`** — wrap every handler in `asyncHandler` and await repo calls. Add the import and convert each route. Full handler bodies:

```ts
import { Router } from 'express';
import { asyncHandler } from '../async-handler.js';
import { HttpError, requireAdmin } from '../auth.js';
import { generateApiKey } from '../api-keys.js';
import type { AuthService } from '../auth-service.js';
import type { Config } from '../config.js';
import type { Repository } from '../repository.js';
import {
  addAdminSchema,
  addOriginSchema,
  createAppSchema,
  createKeySchema,
  updateAppSchema,
} from '../schemas.js';

export function adminRouter(config: Config, repo: Repository, authService: AuthService): Router {
  const router = Router();
  router.use(requireAdmin(config, repo, authService));

  router.get('/apps', asyncHandler(async (_req, res) => {
    res.json(await repo.listApps());
  }));

  router.post('/apps', asyncHandler(async (req, res) => {
    const body = createAppSchema.parse(req.body);
    if (await repo.getApp(body.appId)) throw new HttpError(409, `App "${body.appId}" already exists`);
    res.status(201).json(await repo.createApp(body));
  }));

  router.patch('/apps/:appId', asyncHandler(async (req, res) => {
    const patch = updateAppSchema.parse(req.body);
    const updated = await repo.updateApp(req.params.appId as string, patch);
    if (!updated) throw new HttpError(404, 'App not found');
    res.json(updated);
  }));

  router.delete('/apps/:appId', asyncHandler(async (req, res) => {
    if (!(await repo.deleteApp(req.params.appId as string))) throw new HttpError(404, 'App not found');
    res.sendStatus(204);
  }));

  router.get('/apps/:appId/keys', asyncHandler(async (req, res) => {
    const appId = req.params.appId as string;
    if (!(await repo.getApp(appId))) throw new HttpError(404, 'App not found');
    res.json(await repo.listApiKeys(appId));
  }));

  router.post('/apps/:appId/keys', asyncHandler(async (req, res) => {
    const appId = req.params.appId as string;
    if (!(await repo.getApp(appId))) throw new HttpError(404, 'App not found');
    const body = createKeySchema.parse(req.body);
    const gen = generateApiKey();
    const rec = await repo.createApiKey({
      appId,
      keyHash: gen.keyHash,
      keyPrefix: gen.keyPrefix,
      label: body.label ?? null,
      createdBy: req.admin?.address ?? null,
    });
    res.status(201).json({ ...rec, secret: gen.secret });
  }));

  router.delete('/keys/:id', asyncHandler(async (req, res) => {
    if (!(await repo.revokeApiKey(Number(req.params.id)))) throw new HttpError(404, 'Key not found');
    res.sendStatus(204);
  }));

  router.get('/apps/:appId/origins', asyncHandler(async (req, res) => {
    const appId = req.params.appId as string;
    if (!(await repo.getApp(appId))) throw new HttpError(404, 'App not found');
    res.json(await repo.listCorsOrigins(appId));
  }));

  router.post('/apps/:appId/origins', asyncHandler(async (req, res) => {
    const appId = req.params.appId as string;
    if (!(await repo.getApp(appId))) throw new HttpError(404, 'App not found');
    const body = addOriginSchema.parse(req.body);
    res.status(201).json(await repo.addCorsOrigin({ appId, origin: body.origin }));
  }));

  router.delete('/origins/:id', asyncHandler(async (req, res) => {
    if (!(await repo.deleteCorsOrigin(Number(req.params.id)))) throw new HttpError(404, 'Origin not found');
    res.sendStatus(204);
  }));

  router.get('/admins', asyncHandler(async (_req, res) => {
    res.json({ bootstrap: config.adminWallets, managed: await repo.listAdmins() });
  }));

  router.post('/admins', asyncHandler(async (req, res) => {
    const body = addAdminSchema.parse(req.body);
    res.status(201).json(
      await repo.addAdmin({ address: body.address, label: body.label ?? null, addedBy: req.admin?.address ?? null }),
    );
  }));

  router.delete('/admins/:address', asyncHandler(async (req, res) => {
    if (!(await repo.removeAdmin(req.params.address as string))) throw new HttpError(404, 'Admin not found');
    res.sendStatus(204);
  }));

  return router;
}
```

- [ ] **Step 2: `src/routes/subscriptions.ts`** — wrap handlers, await repo:

```ts
import { Router } from 'express';
import { asyncHandler } from '../async-handler.js';
import { assertAppAccess, HttpError } from '../auth.js';
import { subscribeSchema, unsubscribeSchema } from '../schemas.js';
import type { AppContext } from '../server.js';

export function subscriptionsRouter(ctx: AppContext): Router {
  const router = Router();

  router.post('/', asyncHandler(async (req, res) => {
    const parsed = subscribeSchema.parse(req.body);
    const origin = req.header('origin');
    if (origin && !(await ctx.repo.isOriginAllowedForApp(parsed.appId, origin))) {
      throw new HttpError(403, `Origin ${origin} is not allowed for app "${parsed.appId}"`);
    }
    const record = await ctx.repo.upsertSubscription({
      appId: parsed.appId,
      userId: parsed.userId ?? null,
      subscription: parsed.subscription,
      userAgent: req.header('user-agent') ?? null,
    });
    res.status(201).json({ id: record.id, appId: record.appId });
  }));

  router.delete('/', asyncHandler(async (req, res) => {
    const parsed = unsubscribeSchema.parse(req.body);
    const removed = await ctx.repo.deleteByEndpoint(parsed.endpoint);
    res.json({ removed });
  }));

  router.get('/stats/:appId', ctx.requireApiKey, asyncHandler(async (req, res) => {
    const appId = req.params.appId as string;
    assertAppAccess(req.auth, appId);
    res.json(await ctx.repo.countSubscriptions(appId));
  }));

  return router;
}
```

- [ ] **Step 3: `src/routes/notifications.ts`** — await `findActive`; wrap the logs handler:

In the send handler, await the targeting queries:
```ts
    let targets: SubscriptionRecord[];
    if (body.broadcast) {
      targets = await ctx.repo.findActive(body.appId);
    } else {
      const userIds = body.userIds ?? (body.userId ? [body.userId] : []);
      targets = (await Promise.all(userIds.map((uid) => ctx.repo.findActive(body.appId, uid)))).flat();
    }
```
Replace the logs route with an async, wrapped version:
```ts
  router.get('/logs/:appId', asyncHandler(async (req, res) => {
    const appId = req.params.appId as string;
    assertAppAccess(req.auth, appId);
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    res.json(await ctx.repo.recentLogs(appId, limit));
  }));
```

- [ ] **Step 4: `src/routes/auth.ts`** — await the now-async `isAdminAddress` in both `/login` and `/me`:

```ts
    if (!(await isAdminAddress(result.address, config, repo))) {
      res.status(403).json({ error: 'Wallet not authorized', address: result.address });
      return;
    }
```
```ts
    res.json({ address: verified.address, isAdmin: await isAdminAddress(verified.address, config, repo) });
```

- [ ] **Step 5: `src/server.ts`** — make `browserCors` async so it can await the origin check:

```ts
function browserCors(repo: Repository) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const origin = req.header('origin');
      if (origin && (await repo.isOriginAllowedForAny(origin))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-api-key');
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
```
(`adminCors` uses only `config` — leave it unchanged.)

- [ ] **Step 6: Run the full suite and type check**

Run: `npm test && npm run typecheck`
Expected: all suites pass; `tsc` reports no errors.

- [ ] **Step 7: Commit**

```bash
git add src/routes/admin.ts src/routes/subscriptions.ts src/routes/notifications.ts src/routes/auth.ts src/server.ts
git commit -m "feat(routes): await async repository across all handlers and CORS"
```

---

### Task 6: Config + composition root

**Files:**
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `openDatabase(connectionString): Promise<Pool>`.
- Produces: `Config.databaseUrl: string` (replaces `databasePath`); async `main()`.

- [ ] **Step 1: Read `test/config.test.ts`** and update any reference to `databasePath`/`DATABASE_PATH` to `databaseUrl`/`DATABASE_URL`. If the test asserts required-var failures, add a case that `loadConfig()` throws when `DATABASE_URL` is missing. (Write the assertion to match the existing style in that file.)

- [ ] **Step 2: Run it to verify the new expectation fails**

Run: `npm test`
Expected: FAIL — `databaseUrl` not yet on `Config`.

- [ ] **Step 3: Update `src/config.ts`**

In the `Config` interface, replace:
```ts
  databasePath: string;
```
with:
```ts
  databaseUrl: string;
```
In `loadConfig()`, replace:
```ts
    databasePath: optional('DATABASE_PATH', './data/push.sqlite'),
```
with:
```ts
    databaseUrl: required('DATABASE_URL'),
```

- [ ] **Step 4: Update `src/index.ts`** to an async composition root:

```ts
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';
import { createServer } from './server.js';
import { PushSender } from './webpush.js';
import { createAuthService } from './auth-service.js';
import { seedFromEnv } from './seed.js';

/** Composition root: load config, wire dependencies, start listening. */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = await openDatabase(config.databaseUrl);
  const repo = new Repository(db);

  await seedFromEnv(repo, {
    appKeys: config.appKeys,
    corsOrigins: config.corsOrigins.filter((o) => o !== '*'),
  });

  if (config.logRetentionDays > 0) {
    const prune = () =>
      repo.pruneOldLogs(config.logRetentionDays).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('Log prune failed:', err);
      });
    await prune(); // prune once at startup
    const HOUR = 60 * 60 * 1000;
    const timer = setInterval(prune, HOUR);
    timer.unref();
  }

  if (!config.dashboardOrigin) {
    // eslint-disable-next-line no-console
    console.warn(
      'WARNING: DASHBOARD_ORIGIN is empty — browsers will be blocked by CORS from ' +
        'calling /auth and /admin, so the admin dashboard cannot work. Set it to the ' +
        'dashboard origin (e.g. https://admin.push.p2p.me).',
    );
  }

  const sender = new PushSender(config, repo);
  const authService = createAuthService(config);
  const app = createServer(config, repo, sender, authService);

  const server = app.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(`push-notifications listening on http://${config.host}:${config.port}`);
  });

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}, shutting down...`);
    server.close(() => {
      db.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
```

- [ ] **Step 5: Run the full suite + type check**

Run: `npm test && npm run typecheck`
Expected: all pass; no `tsc` errors. This is the green-bar checkpoint for the whole code migration.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/index.ts test/config.test.ts
git commit -m "feat(config): DATABASE_URL + async composition root"
```

---

### Task 7: Deployment artifacts (Docker, compose, env, docs)

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `README.md`
- Create: `docs/railway-deployment.md`

**Interfaces:** none (infra + docs only).

- [ ] **Step 1: Simplify the `Dockerfile`** — Postgres needs no native build toolchain and no data volume. Replace the file:

```dockerfile
# ---- build stage ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---- runtime stage ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
# Cap the V8 heap so RSS stays small on a low-traffic service; tune per host.
ENV NODE_OPTIONS="--max-old-space-size=128 --max-semi-space-size=2"
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/src/index.js"]
```

- [ ] **Step 2: Update `docker-compose.yml`** — add a Postgres service and wire `DATABASE_URL`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: push
      POSTGRES_PASSWORD: push
      POSTGRES_DB: push
    volumes:
      - push-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U push -d push']
      interval: 5s
      timeout: 5s
      retries: 10

  push:
    build: .
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - '4000:4000'
    environment:
      PORT: 4000
      HOST: 0.0.0.0
      DATABASE_URL: postgres://push:push@postgres:5432/push
      VAPID_PUBLIC_KEY: ${VAPID_PUBLIC_KEY}
      VAPID_PRIVATE_KEY: ${VAPID_PRIVATE_KEY}
      VAPID_SUBJECT: ${VAPID_SUBJECT:-mailto:dev@p2p.me}
      ADMIN_API_KEY: ${ADMIN_API_KEY}
      APP_KEYS: ${APP_KEYS}
      CORS_ORIGINS: ${CORS_ORIGINS:-*}
      AUTH_DOMAIN: ${AUTH_DOMAIN:-localhost}
      AUTH_JWT_SECRET: ${AUTH_JWT_SECRET}
      ADMIN_WALLETS: ${ADMIN_WALLETS:-}
      DASHBOARD_ORIGIN: ${DASHBOARD_ORIGIN:-http://localhost:5173}

volumes:
  push-pgdata:
```

- [ ] **Step 3: Update `.env.example`** — replace the storage block:

Change the storage section from the `DATABASE_PATH=./data/push.sqlite` lines to:
```bash
# ---------------------------------------------------------------------------
# Storage — PostgreSQL connection string. On Railway, reference the managed
# Postgres plugin variable: DATABASE_URL=${{Postgres.DATABASE_URL}}
# Locally, docker-compose provides: postgres://push:push@postgres:5432/push
# ---------------------------------------------------------------------------
DATABASE_URL=postgres://push:push@localhost:5432/push
```

- [ ] **Step 4: Update `README.md`** — replace SQLite-specific copy:
  - In "How it works": change "Subscriptions and a delivery audit log live in a local **SQLite** file — genuinely self-contained, nothing else to run." to describe PostgreSQL as the store.
  - In the Configuration table: replace the `DATABASE_PATH` row with `DATABASE_URL` — "PostgreSQL connection string (Railway: `${{Postgres.DATABASE_URL}}`)."
  - In "Notes & limits": replace the SQLite single-instance bullet with: "Postgres backs the store, so the service scales to multiple replicas and gets managed backups on Railway." Remove the "put the repository layer behind Postgres" sentence (now done).
  - Update the Docker quick-start note to mention the bundled `postgres` service.

- [ ] **Step 5: Create `docs/railway-deployment.md`** with the runbook:

```markdown
# Deploying on Railway (backend) + Netlify (dashboard)

## Backend (push API) on Railway

1. **Create the service** from this repo. Railway builds the `Dockerfile`
   automatically. No volume is needed — state lives in Postgres.
2. **Add Postgres**: in the Railway project, "New → Database → PostgreSQL".
3. **Wire the connection string**: on the push service, set
   `DATABASE_URL=${{Postgres.DATABASE_URL}}` (Railway reference variable). The
   service runs its own schema migration on boot.
4. **Set the remaining variables** (Service → Variables):
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
   - `ADMIN_API_KEY`
   - `AUTH_DOMAIN=push.p2p.me`
   - `AUTH_JWT_SECRET` (32+ random bytes)
   - `ADMIN_WALLETS` (bootstrap admin wallet address)
   - `DASHBOARD_ORIGIN=https://<your-netlify-domain>`
   - `PORT` is provided by Railway automatically; the app reads it.
5. **Health check**: set the Railway healthcheck path to `/health`.
6. **Custom domain**: map `push.p2p.me` to the service. Ensure `AUTH_DOMAIN`
   matches the host browsers see, or SIWE login will fail.

> VAPID keys are permanent — generate once with `npm run generate-vapid`, store
> them durably, and never rotate casually (rotation invalidates every existing
> subscription).

## Dashboard (admin SPA) on Netlify

The dashboard ships with `dashboard/netlify.toml` (base dir `dashboard`, SPA
fallback redirect). In Netlify:

1. New site from this repo; set **base directory = `dashboard`** (or rely on the
   committed `netlify.toml`).
2. Environment variables:
   - `VITE_API_BASE_URL=https://push.p2p.me`
   - `VITE_THIRDWEB_CLIENT_ID=<public thirdweb client id>`
3. Deploy, then set the backend's `DASHBOARD_ORIGIN` to the resulting Netlify
   origin (and re-deploy the backend). The admin plane only accepts that exact
   origin.

## First-admin bootstrap

Log in once via the dashboard to discover your embedded-wallet address (the UI
shows it when unauthorized), add it to `ADMIN_WALLETS` on Railway, and redeploy.
```

- [ ] **Step 6: Verify the local stack builds and boots**

Run:
```bash
docker compose up --build -d
sleep 8
curl -fsS http://localhost:4000/health
docker compose down
```
Expected: `{"status":"ok"}` from the health check.

- [ ] **Step 7: Commit**

```bash
git add Dockerfile docker-compose.yml .env.example README.md docs/railway-deployment.md
git commit -m "feat(deploy): Postgres-based Docker stack + Railway/Netlify runbook"
```

---

## Self-Review

**Spec coverage:**
- Driver swap, async repo, dialect translation → Tasks 1–2. ✅
- Transaction rewrite + seeder → Task 3. ✅
- All call sites awaited (sender, auth middleware, routes, server CORS) → Tasks 4–5. ✅
- Config + composition root + shutdown `db.end()` → Task 6. ✅
- Tests migrated to pg-mem; stale `thirdweb` config fixed → Tasks 1–6. ✅
- Docker/compose/env/README/Railway docs → Task 7. ✅
- Netlify dashboard config → already committed (`dashboard/netlify.toml`) before this plan; referenced in the runbook.

**Placeholder scan:** No `TODO`/`later`/"add error handling" left; every code step shows full code. The only intentional "read the file first" steps are for `test/seed.test.ts`, `test/config.test.ts`, `test/admin.test.ts`, `test/api-keys.test.ts`, and the README edits, where the exact current contents must be matched — each names the precise transformation to apply.

**Type consistency:** `Queryable` defined in Task 1, consumed in Task 2. `transaction((tx) => Promise<T>)` defined in Task 2, used in Task 3. `isAdminAddress(...) : Promise<boolean>` defined in Task 4, awaited in Tasks 4–5. `Config.databaseUrl` defined in Task 6, consumed by `openDatabase` (Task 1) via `index.ts` (Task 6). `id` columns are `serial` (int4 → JS `number`), preserving `id: number` and `Number(req.params.id)`. `disabled` stays integer, preserving `SubscriptionRecord.disabled: number` and the `row.disabled === 1` mappers.

## Open risk to watch during execution

`pg-mem` fidelity: if any test fails *only* under pg-mem (e.g. `IS NOT DISTINCT FROM`, `ON CONFLICT ... excluded`, transactions), the fastest resolution is to point `createTestPool()` at a real Postgres via `TEST_DATABASE_URL` (Testcontainers or a CI service container) rather than reshaping production SQL to satisfy the emulator. Production correctness against real Postgres is the priority.
```

# Wallet-authenticated Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a thirdweb-wallet-authenticated admin dashboard that manages apps, API keys, and per-app CORS origins in the database, replacing static env configuration.

**Architecture:** The existing Express service keeps its server-to-server data plane (`x-api-key`), but API keys now resolve from the DB by hash. A new admin plane (`/auth/*`, `/admin/*`) authenticates admins via thirdweb SIWE login, gates them by a wallet whitelist (env bootstrap + DB), and exposes CRUD for apps, keys, origins, and admins. A separate Vite + React app is the dashboard UI. thirdweb verification is wrapped behind an injectable `AuthService` so tests never hit the network.

**Tech Stack:** Node 20 + Express 4 + TypeScript (ESM), better-sqlite3, zod, web-push (existing); `thirdweb` v5 (new backend dep); Vite + React + thirdweb React SDK (new `dashboard/` app); `node:test` for tests.

---

## Spec

Source: `docs/superpowers/specs/2026-06-16-wallet-admin-dashboard-design.md`

## File Structure

**Backend — new files**
- `src/api-keys.ts` — generate/hash API key secrets (pure functions).
- `src/auth-service.ts` — `AuthService` interface + thirdweb implementation. Only backend module importing `thirdweb`.
- `src/seed.ts` — one-time env→DB import (`APP_KEYS`, `CORS_ORIGINS`).
- `src/routes/auth.ts` — `/auth/payload`, `/auth/login`, `/auth/me`.
- `src/routes/admin.ts` — `/admin/*` CRUD (apps, keys, origins, admins).
- `test/config.test.ts`, `test/api-keys.test.ts`, `test/repository.test.ts`, `test/seed.test.ts`, `test/admin.test.ts` — new test suites.
- `test/fake-auth-service.ts` — in-memory `AuthService` for tests.

**Backend — modified files**
- `src/config.ts` — new env fields (`thirdweb`, `adminWallets`, `dashboardOrigin`); `parseList` helper.
- `src/db.ts` — four new tables in `migrate()`.
- `src/repository.ts` — data access for apps, api_keys, cors_origins, admins.
- `src/types.ts` — new record types + admin auth context.
- `src/schemas.ts` — zod schemas for admin request bodies.
- `src/auth.ts` — DB-backed `apiKeyAuth`; new `requireAdmin` + `isAdminAddress`.
- `src/server.ts` — per-app browser CORS, admin-plane CORS, mount `/auth` + `/admin`, accept `authService`.
- `src/routes/subscriptions.ts` — per-app origin enforcement on `POST /`.
- `src/index.ts` — construct `ThirdwebAuthService`, run seed, pass authService.
- `.env.example`, `README.md` — document new config + dashboard.

**Frontend — new app (`dashboard/`)**
- `dashboard/package.json`, `dashboard/tsconfig.json`, `dashboard/vite.config.ts`, `dashboard/index.html`, `dashboard/.env.example`.
- `dashboard/src/main.tsx` — `ThirdwebProvider` + router.
- `dashboard/src/client.ts` — thirdweb client (`clientId`).
- `dashboard/src/auth.ts` — token storage + thirdweb auth config.
- `dashboard/src/api.ts` — fetch wrapper with Bearer token.
- `dashboard/src/App.tsx` — layout, `ConnectButton`, login gate, routes.
- `dashboard/src/pages/Apps.tsx`, `dashboard/src/pages/AppDetail.tsx`, `dashboard/src/pages/Admins.tsx`.

---

## Task 1: Extend config with new env fields

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/config.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseList } from '../src/config.js';

describe('parseList', () => {
  it('splits, trims, and drops empties', () => {
    assert.deepEqual(parseList('a, b ,,c'), ['a', 'b', 'c']);
  });

  it('returns an empty array for empty input', () => {
    assert.deepEqual(parseList(''), []);
    assert.deepEqual(parseList('   '), []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx ./test/config.test.ts`
Expected: FAIL — `parseList` is not exported.

- [ ] **Step 3: Implement**

In `src/config.ts`, add the exported helper above `loadConfig`:

```ts
/** Split a comma-separated env value into a trimmed, non-empty list. */
export function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
```

Extend the `Config` interface (add after `appKeys`):

```ts
  adminWallets: string[];
  dashboardOrigin: string;
  thirdweb: {
    secretKey: string;
    authPrivateKey: string;
    authDomain: string;
  };
```

In `loadConfig`'s returned object, add (after `appKeys: parseAppKeys(...)`):

```ts
    adminWallets: parseList(optional('ADMIN_WALLETS', '')).map((a) => a.toLowerCase()),
    dashboardOrigin: optional('DASHBOARD_ORIGIN', ''),
    thirdweb: {
      secretKey: required('THIRDWEB_SECRET_KEY'),
      authPrivateKey: required('THIRDWEB_AUTH_PRIVATE_KEY'),
      authDomain: required('THIRDWEB_AUTH_DOMAIN'),
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx ./test/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: add thirdweb/admin config fields and parseList helper"
```

---

## Task 2: Add the four admin tables to the schema

**Files:**
- Modify: `src/db.ts`
- Test: `test/repository.test.ts` (create — schema check first)

- [ ] **Step 1: Write the failing test**

Create `test/repository.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';

describe('schema', () => {
  it('creates the admin-plane tables', () => {
    const db = openDatabase(':memory:');
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of ['apps', 'api_keys', 'cors_origins', 'admins']) {
      assert.ok(names.includes(t), `expected table ${t}`);
    }
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx ./test/repository.test.ts`
Expected: FAIL — tables missing.

- [ ] **Step 3: Implement**

In `src/db.ts`, append to the `db.exec(\`...\`)` template in `migrate()` (after the `notification_logs` block, before the closing backtick):

```sql
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx ./test/repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts test/repository.test.ts
git commit -m "feat: add apps/api_keys/cors_origins/admins tables"
```

---

## Task 3: API-key generation + hashing helpers

**Files:**
- Create: `src/api-keys.ts`
- Test: `test/api-keys.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/api-keys.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateApiKey, hashApiKey } from '../src/api-keys.js';

describe('api-keys', () => {
  it('generates a prefixed secret with a matching hash and prefix', () => {
    const k = generateApiKey();
    assert.match(k.secret, /^pk_[A-Za-z0-9]{32,}$/);
    assert.equal(k.keyHash, hashApiKey(k.secret));
    assert.ok(k.secret.startsWith(k.keyPrefix));
    assert.equal(k.keyPrefix.length, 10); // "pk_" + 7 chars
  });

  it('hashes deterministically and differs per secret', () => {
    assert.equal(hashApiKey('pk_abc'), hashApiKey('pk_abc'));
    assert.notEqual(hashApiKey('pk_abc'), hashApiKey('pk_def'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx ./test/api-keys.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/api-keys.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';

/** A freshly minted API key. The plaintext `secret` is shown to the admin once. */
export interface GeneratedApiKey {
  secret: string;
  keyHash: string;
  keyPrefix: string;
}

/** SHA-256 hex digest of an API key secret. Stored instead of the plaintext. */
export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Mint a random `pk_…` secret plus its hash and a short display prefix. */
export function generateApiKey(): GeneratedApiKey {
  const secret = `pk_${randomBytes(24).toString('base64url')}`;
  return {
    secret,
    keyHash: hashApiKey(secret),
    keyPrefix: secret.slice(0, 10),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx ./test/api-keys.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api-keys.ts test/api-keys.test.ts
git commit -m "feat: add API key generation and hashing helpers"
```

---

## Task 4: Repository — apps + new record types

**Files:**
- Modify: `src/types.ts`, `src/repository.ts`
- Test: `test/repository.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/repository.test.ts`:

```ts
import { Repository } from '../src/repository.js';

function freshRepo(): Repository {
  return new Repository(openDatabase(':memory:'));
}

describe('repository: apps', () => {
  it('creates, lists, gets, updates, and deletes apps', () => {
    const repo = freshRepo();
    repo.createApp({ appId: 'user-app', name: 'User App' });
    assert.equal(repo.listApps().length, 1);

    const got = repo.getApp('user-app');
    assert.equal(got?.name, 'User App');
    assert.equal(got?.disabled, false);

    repo.updateApp('user-app', { name: 'Renamed', disabled: true });
    const updated = repo.getApp('user-app');
    assert.equal(updated?.name, 'Renamed');
    assert.equal(updated?.disabled, true);

    repo.deleteApp('user-app');
    assert.equal(repo.getApp('user-app'), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx ./test/repository.test.ts`
Expected: FAIL — `createApp` is not a function.

- [ ] **Step 3: Implement**

In `src/types.ts`, append:

```ts
/** A managed application (tenant). */
export interface AppRecord {
  appId: string;
  name: string;
  disabled: boolean;
  createdAt: string;
}

/** API key metadata — never includes the secret or its hash. */
export interface ApiKeyRecord {
  id: number;
  appId: string;
  keyPrefix: string;
  label: string | null;
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** A per-app allowed browser origin. */
export interface CorsOriginRecord {
  id: number;
  appId: string;
  origin: string;
  createdAt: string;
}

/** A DB-managed admin wallet. */
export interface AdminRecord {
  address: string;
  label: string | null;
  addedBy: string | null;
  createdAt: string;
}

/** Identity resolved from an admin Bearer JWT. */
export interface AdminAuthContext {
  address: string;
}
```

In `src/repository.ts`, add at the top with the other imports:

```ts
import type {
  AdminRecord,
  ApiKeyRecord,
  AppRecord,
  CorsOriginRecord,
} from './types.js';
```

Add inside the `Repository` class (after `countSubscriptions`):

```ts
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
```

Add the row type + mapper near the top of the file (after the existing `SubscriptionRow`/`toRecord`):

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx ./test/repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/repository.ts test/repository.test.ts
git commit -m "feat: repository app CRUD + admin-plane record types"
```

---

## Task 5: Repository — API keys

**Files:**
- Modify: `src/repository.ts`
- Test: `test/repository.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/repository.test.ts`:

```ts
import { generateApiKey } from '../src/api-keys.js';

describe('repository: api keys', () => {
  it('creates, looks up by hash, lists, and revokes', () => {
    const repo = freshRepo();
    repo.createApp({ appId: 'user-app', name: 'User App' });
    const k = generateApiKey();
    const rec = repo.createApiKey({
      appId: 'user-app',
      keyHash: k.keyHash,
      keyPrefix: k.keyPrefix,
      label: 'ci',
      createdBy: '0xabc',
    });

    const found = repo.findActiveApiKeyByHash(k.keyHash);
    assert.equal(found?.appId, 'user-app');

    assert.equal(repo.listApiKeys('user-app').length, 1);

    repo.revokeApiKey(rec.id);
    assert.equal(repo.findActiveApiKeyByHash(k.keyHash), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx ./test/repository.test.ts`
Expected: FAIL — `createApiKey` is not a function.

- [ ] **Step 3: Implement**

In `src/repository.ts`, add the row type + mapper (near the other mappers):

```ts
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
```

Add to the `Repository` class:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx ./test/repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repository.ts test/repository.test.ts
git commit -m "feat: repository API key persistence"
```

---

## Task 6: Repository — CORS origins

**Files:**
- Modify: `src/repository.ts`
- Test: `test/repository.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/repository.test.ts`:

```ts
describe('repository: cors origins', () => {
  it('adds, lists, checks per-app and global, and deletes', () => {
    const repo = freshRepo();
    repo.createApp({ appId: 'user-app', name: 'User App' });
    repo.createApp({ appId: 'merchant-app', name: 'Merchant App' });

    const o = repo.addCorsOrigin({ appId: 'user-app', origin: 'https://app.p2p.me' });
    assert.equal(repo.listCorsOrigins('user-app').length, 1);

    assert.equal(repo.isOriginAllowedForApp('user-app', 'https://app.p2p.me'), true);
    assert.equal(repo.isOriginAllowedForApp('merchant-app', 'https://app.p2p.me'), false);
    assert.equal(repo.isOriginAllowedForAny('https://app.p2p.me'), true);
    assert.equal(repo.isOriginAllowedForAny('https://evil.example'), false);

    repo.deleteCorsOrigin(o.id);
    assert.equal(repo.isOriginAllowedForAny('https://app.p2p.me'), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx ./test/repository.test.ts`
Expected: FAIL — `addCorsOrigin` is not a function.

- [ ] **Step 3: Implement**

In `src/repository.ts`, add the row type + mapper:

```ts
interface CorsOriginRow {
  id: number;
  app_id: string;
  origin: string;
  created_at: string;
}

function toCorsOriginRecord(row: CorsOriginRow): CorsOriginRecord {
  return { id: row.id, appId: row.app_id, origin: row.origin, createdAt: row.created_at };
}
```

Add to the `Repository` class:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx ./test/repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repository.ts test/repository.test.ts
git commit -m "feat: repository per-app CORS origin persistence"
```

---

## Task 7: Repository — admins

**Files:**
- Modify: `src/repository.ts`
- Test: `test/repository.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/repository.test.ts`:

```ts
describe('repository: admins', () => {
  it('adds (lowercased), lists, checks, and removes', () => {
    const repo = freshRepo();
    repo.addAdmin({ address: '0xAbC', label: 'me', addedBy: '0xroot' });
    assert.equal(repo.isDbAdmin('0xabc'), true);
    assert.equal(repo.isDbAdmin('0xABC'), true);
    assert.equal(repo.listAdmins().length, 1);
    repo.removeAdmin('0xabc');
    assert.equal(repo.isDbAdmin('0xabc'), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx ./test/repository.test.ts`
Expected: FAIL — `addAdmin` is not a function.

- [ ] **Step 3: Implement**

In `src/repository.ts`, add the row mapper:

```ts
interface AdminRow {
  address: string;
  label: string | null;
  added_by: string | null;
  created_at: string;
}

function toAdminRecord(row: AdminRow): AdminRecord {
  return { address: row.address, label: row.label, addedBy: row.added_by, createdAt: row.created_at };
}
```

Add to the `Repository` class. Addresses are lowercased on write and read so lookups are case-insensitive:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx ./test/repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repository.ts test/repository.test.ts
git commit -m "feat: repository admin-wallet persistence"
```

---

## Task 8: One-time env→DB seed

**Files:**
- Create: `src/seed.ts`
- Test: `test/seed.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/seed.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { Repository } from '../src/repository.js';
import { hashApiKey } from '../src/api-keys.js';
import { seedFromEnv } from '../src/seed.js';

function repo() {
  return new Repository(openDatabase(':memory:'));
}

describe('seedFromEnv', () => {
  it('imports app keys and attaches origins to every app', () => {
    const r = repo();
    seedFromEnv(r, {
      appKeys: { 'user-app': 'user-key', 'merchant-app': 'merchant-key' },
      corsOrigins: ['https://app.p2p.me'],
    });

    assert.equal(r.listApps().length, 2);
    assert.equal(r.findActiveApiKeyByHash(hashApiKey('user-key'))?.appId, 'user-app');
    assert.equal(r.isOriginAllowedForApp('user-app', 'https://app.p2p.me'), true);
    assert.equal(r.isOriginAllowedForApp('merchant-app', 'https://app.p2p.me'), true);
  });

  it('is a no-op when apps already exist', () => {
    const r = repo();
    r.createApp({ appId: 'existing', name: 'existing' });
    seedFromEnv(r, { appKeys: { 'user-app': 'user-key' }, corsOrigins: [] });
    assert.equal(r.listApps().length, 1);
  });

  it('ignores the wildcard origin', () => {
    const r = repo();
    seedFromEnv(r, { appKeys: { 'user-app': 'user-key' }, corsOrigins: ['*'] });
    assert.equal(r.listCorsOrigins('user-app').length, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx ./test/seed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/seed.ts`:

```ts
import { hashApiKey } from './api-keys.js';
import type { Repository } from './repository.js';

/**
 * One-time migration of the legacy env config into the database. Runs only when
 * no apps exist yet, so the DB becomes the source of truth after first boot.
 * The legacy global CORS list is best-effort attached to every imported app;
 * admins refine it afterward. The `*` wildcard is skipped (per-app origins are
 * explicit allow-list entries, not wildcards).
 */
export function seedFromEnv(
  repo: Repository,
  env: { appKeys: Record<string, string>; corsOrigins: string[] },
): void {
  if (repo.listApps().length > 0) return;

  const origins = env.corsOrigins.filter((o) => o !== '*');

  for (const [appId, secret] of Object.entries(env.appKeys)) {
    repo.createApp({ appId, name: appId });
    repo.createApiKey({
      appId,
      keyHash: hashApiKey(secret),
      keyPrefix: secret.slice(0, 10),
      label: 'imported from APP_KEYS',
      createdBy: null,
    });
    for (const origin of origins) {
      repo.addCorsOrigin({ appId, origin });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx ./test/seed.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/seed.ts test/seed.test.ts
git commit -m "feat: one-time env->DB seed of apps/keys/origins"
```

---

## Task 9: DB-backed data-plane auth

Switch `apiKeyAuth` from env `APP_KEYS` to a hashed DB lookup (master env key still works). Update the existing integration test to seed the DB so its keys keep working.

**Files:**
- Modify: `src/auth.ts`, `src/server.ts`, `test/api.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/api.test.ts`, update the imports and `before()` to seed the DB, and add new auth tests. Replace the existing `before(async () => { ... })` block with:

```ts
before(async () => {
  const db = openDatabase(':memory:');
  const repo = new Repository(db);
  const sender = new PushSender(config, repo);
  seedFromEnv(repo, { appKeys: config.appKeys, corsOrigins: [] });
  const app = createServer(config, repo, sender);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});
```

Add the import near the top of `test/api.test.ts`:

```ts
import { seedFromEnv } from '../src/seed.js';
```

Add a new test inside the `describe('auth', ...)` block:

```ts
  it('rejects a revoked / unknown key with 403', async () => {
    const res = await fetch(`${base}/notifications/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'pk_does_not_exist' },
      body: JSON.stringify({ appId: 'user-app', userId: 'alice', notification: { title: 'hi' } }),
    });
    assert.equal(res.status, 403);
  });
```

(The existing `admin-key`, `user-key`, and `merchant-key` cases now pass because the seed imported them.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx ./test/api.test.ts`
Expected: FAIL — `user-key`/`merchant-key` no longer authenticate (still env-based), so the `forbids an app key targeting another app` and stats tests break.

- [ ] **Step 3: Implement**

Rewrite `apiKeyAuth` in `src/auth.ts`. Replace the existing `apiKeyAuth` function with:

```ts
import { hashApiKey } from './api-keys.js';
import type { Repository } from './repository.js';

/**
 * Resolves the `x-api-key` header into an AuthContext. The admin key (env) may
 * act on any app; otherwise the key is looked up by hash in the DB and scoped to
 * its app. Sending endpoints require this middleware; browser subscribe does not.
 */
export function apiKeyAuth(config: Config, repo: Repository) {
  return (req: Request, res: Response, next: NextFunction): void => {
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

    const key = repo.findActiveApiKeyByHash(hashApiKey(provided));
    if (key) {
      repo.touchApiKey(key.id);
      req.auth = { isAdmin: false, appId: key.appId };
      next();
      return;
    }

    res.status(403).json({ error: 'Invalid API key' });
  };
}
```

In `src/server.ts`, update the `requireApiKey` wiring in `createServer`. Change:

```ts
    requireApiKey: apiKeyAuth(config),
```

to:

```ts
    requireApiKey: apiKeyAuth(config, repo),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx ./test/api.test.ts`
Expected: PASS (including the new revoked-key 403 case).

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts src/server.ts test/api.test.ts
git commit -m "feat: resolve data-plane API keys from the database"
```

---

## Task 10: AuthService interface + thirdweb implementation + test fake

**Files:**
- Create: `src/auth-service.ts`, `test/fake-auth-service.ts`
- Test: `test/admin.test.ts` (create — fake roundtrip first)
- Install: `thirdweb`

- [ ] **Step 1: Install the backend dependency**

Run: `npm install thirdweb`
Expected: `thirdweb` added to `dependencies` in `package.json`.

- [ ] **Step 2: Write the failing test**

Create `test/admin.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAuthService } from './fake-auth-service.js';

describe('FakeAuthService', () => {
  it('round-trips a login and JWT', async () => {
    const auth = new FakeAuthService();
    const payload = await auth.generatePayload('0xAbC');
    const issued = await auth.verifyAndIssueJwt(payload, 'sig');
    assert.equal(issued?.address, '0xabc');
    const verified = await auth.verifyJwt(issued!.token);
    assert.equal(verified?.address, '0xabc');
  });

  it('rejects a malformed token', async () => {
    const auth = new FakeAuthService();
    assert.equal(await auth.verifyJwt('garbage'), null);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test --import tsx ./test/admin.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the interface + thirdweb impl**

Create `src/auth-service.ts`:

```ts
import { createThirdwebClient } from 'thirdweb';
import { createAuth } from 'thirdweb/auth';
import { privateKeyToAccount } from 'thirdweb/wallets';
import type { Config } from './config.js';

/**
 * Wraps thirdweb SIWE auth behind a narrow interface so the HTTP layer never
 * imports thirdweb directly and tests can inject a fake (no network).
 * `payload` is passed through opaquely between client and thirdweb.
 */
export interface AuthService {
  /** Build a login payload for an address (sent to the client to sign). */
  generatePayload(address: string): Promise<unknown>;
  /** Verify a signed payload; on success returns the lowercased address + a JWT. */
  verifyAndIssueJwt(
    payload: unknown,
    signature: string,
  ): Promise<{ address: string; token: string } | null>;
  /** Verify a Bearer JWT; returns the lowercased address or null. */
  verifyJwt(token: string): Promise<{ address: string } | null>;
}

export function createThirdwebAuthService(config: Config): AuthService {
  const client = createThirdwebClient({ secretKey: config.thirdweb.secretKey });
  const auth = createAuth({
    domain: config.thirdweb.authDomain,
    client,
    adminAccount: privateKeyToAccount({
      client,
      privateKey: config.thirdweb.authPrivateKey,
    }),
  });

  return {
    async generatePayload(address) {
      return auth.generatePayload({ address });
    },
    async verifyAndIssueJwt(payload, signature) {
      const verified = await auth.verifyPayload({
        // thirdweb owns this payload shape; we pass it through opaquely.
        payload: payload as Parameters<typeof auth.verifyPayload>[0]['payload'],
        signature,
      });
      if (!verified.valid) return null;
      const token = await auth.generateJWT({ payload: verified.payload });
      return { address: verified.payload.address.toLowerCase(), token };
    },
    async verifyJwt(token) {
      const result = await auth.verifyJWT({ jwt: token });
      if (!result.valid) return null;
      const sub = result.parsedJWT.sub ?? '';
      return sub ? { address: sub.toLowerCase() } : null;
    },
  };
}
```

Create `test/fake-auth-service.ts`:

```ts
import type { AuthService } from '../src/auth-service.js';

/**
 * Deterministic in-memory AuthService for tests. A "token" is the literal
 * string `faketoken:<address>` so tests can forge an admin Bearer header
 * directly without running the full SIWE flow.
 */
export class FakeAuthService implements AuthService {
  async generatePayload(address: string): Promise<unknown> {
    return { address, nonce: 'test-nonce' };
  }

  async verifyAndIssueJwt(
    payload: unknown,
    _signature: string,
  ): Promise<{ address: string; token: string } | null> {
    const address = (payload as { address?: string }).address?.toLowerCase();
    if (!address) return null;
    return { address, token: `faketoken:${address}` };
  }

  async verifyJwt(token: string): Promise<{ address: string } | null> {
    const prefix = 'faketoken:';
    if (!token.startsWith(prefix)) return null;
    return { address: token.slice(prefix.length).toLowerCase() };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test --import tsx ./test/admin.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/auth-service.ts test/fake-auth-service.ts test/admin.test.ts package.json package-lock.json
git commit -m "feat: AuthService abstraction over thirdweb SIWE + test fake"
```

---

## Task 11: Admin authorization + auth routes + server wiring + CORS restructure

Adds `requireAdmin`/`isAdminAddress`, the `/auth/*` routes, restructures CORS (per-app browser CORS + admin-plane CORS), and threads `authService` into `createServer`.

**Files:**
- Modify: `src/auth.ts`, `src/server.ts`, `test/api.test.ts`
- Create: `src/routes/auth.ts`
- Test: `test/admin.test.ts`

- [ ] **Step 1: Write the failing test**

Append a shared harness + auth-route tests to `test/admin.test.ts`:

```ts
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import webpush from 'web-push';
import type { Config } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { Repository } from '../src/repository.js';
import { PushSender } from '../src/webpush.js';
import { createServer } from '../src/server.js';

const vapid = webpush.generateVAPIDKeys();
const ADMIN = '0xadmin0000000000000000000000000000000001';

function makeConfig(): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    corsOrigins: ['*'],
    vapid: { publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: 'mailto:test@p2p.me' },
    databasePath: ':memory:',
    adminApiKey: 'admin-key',
    appKeys: {},
    maxFailures: 5,
    adminWallets: [ADMIN],
    dashboardOrigin: 'http://localhost:5173',
    thirdweb: { secretKey: 'x', authPrivateKey: 'x', authDomain: 'localhost' },
  };
}

async function startServer(config: Config): Promise<{ base: string; repo: Repository; close: () => void }> {
  const repo = new Repository(openDatabase(':memory:'));
  const sender = new PushSender(config, repo);
  const app = createServer(config, repo, sender, new FakeAuthService());
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${addr.port}`, repo, close: () => server.close() };
}

const adminHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer faketoken:${ADMIN}` };

describe('auth routes', () => {
  it('returns a login payload', async () => {
    const { base, close } = await startServer(makeConfig());
    const res = await fetch(`${base}/auth/payload?address=${ADMIN}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { address: string };
    assert.equal(body.address, ADMIN);
    close();
  });

  it('logs in a whitelisted admin and returns a token', async () => {
    const { base, close } = await startServer(makeConfig());
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { address: ADMIN }, signature: 'sig' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { token: string; isAdmin: boolean };
    assert.equal(body.isAdmin, true);
    assert.equal(body.token, `faketoken:${ADMIN}`);
    close();
  });

  it('rejects a non-whitelisted address with 403 + address', async () => {
    const { base, close } = await startServer(makeConfig());
    const stranger = '0xstranger00000000000000000000000000000002';
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { address: stranger }, signature: 'sig' }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { address: string };
    assert.equal(body.address, stranger);
    close();
  });

  it('reports identity via /auth/me with a Bearer token', async () => {
    const { base, close } = await startServer(makeConfig());
    const res = await fetch(`${base}/auth/me`, { headers: adminHeaders });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { address: string; isAdmin: boolean };
    assert.equal(body.address, ADMIN);
    assert.equal(body.isAdmin, true);
    close();
  });

  it('rejects /auth/me without a token', async () => {
    const { base, close } = await startServer(makeConfig());
    const res = await fetch(`${base}/auth/me`);
    assert.equal(res.status, 401);
    close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx ./test/admin.test.ts`
Expected: FAIL — `createServer` takes 3 args / `/auth/*` routes missing.

- [ ] **Step 3: Implement `isAdminAddress` + `requireAdmin`**

In `src/auth.ts`, add the import for `AuthService` and `AdminAuthContext`, and extend the global Express `Request` augmentation. Update the `declare global` block to include `admin`:

```ts
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      admin?: AdminAuthContext;
    }
  }
}
```

Add these imports at the top of `src/auth.ts`:

```ts
import type { AuthService } from './auth-service.js';
import type { AdminAuthContext } from './types.js';
```

Add the helper + middleware at the bottom of `src/auth.ts`:

```ts
/** True when an address is a bootstrap (env) admin or a DB-managed admin. */
export function isAdminAddress(address: string, config: Config, repo: Repository): boolean {
  const lower = address.toLowerCase();
  return config.adminWallets.includes(lower) || repo.isDbAdmin(lower);
}

/**
 * Verifies a Bearer JWT and ensures the address is whitelisted. Populates
 * `req.admin`. 401 when the token is missing/invalid, 403 when not an admin.
 */
export function requireAdmin(config: Config, repo: Repository, authService: AuthService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: 'Missing Bearer token' });
      return;
    }
    const verified = await authService.verifyJwt(token);
    if (!verified) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    if (!isAdminAddress(verified.address, config, repo)) {
      res.status(403).json({ error: 'Wallet not authorized' });
      return;
    }
    req.admin = { address: verified.address };
    next();
  };
}
```

- [ ] **Step 4: Implement the auth routes**

Create `src/routes/auth.ts`:

```ts
import { Router } from 'express';
import { asyncHandler } from '../async-handler.js';
import { isAdminAddress } from '../auth.js';
import type { AuthService } from '../auth-service.js';
import type { Config } from '../config.js';
import type { Repository } from '../repository.js';

/**
 * thirdweb SIWE auth for the dashboard. `/payload` and `/login` are public;
 * `/me` requires a Bearer token. A non-whitelisted login returns 403 plus the
 * resolved address so the UI can show a bootstrap hint.
 */
export function authRouter(
  config: Config,
  repo: Repository,
  authService: AuthService,
): Router {
  const router = Router();

  router.get('/payload', asyncHandler(async (req, res) => {
    const address = String(req.query.address ?? '');
    if (!address) {
      res.status(400).json({ error: 'address query parameter is required' });
      return;
    }
    res.json(await authService.generatePayload(address));
  }));

  router.post('/login', asyncHandler(async (req, res) => {
    const { payload, signature } = req.body ?? {};
    if (payload == null || typeof signature !== 'string') {
      res.status(400).json({ error: 'payload and signature are required' });
      return;
    }
    const result = await authService.verifyAndIssueJwt(payload, signature);
    if (!result) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
    if (!isAdminAddress(result.address, config, repo)) {
      res.status(403).json({ error: 'Wallet not authorized', address: result.address });
      return;
    }
    res.json({ token: result.token, address: result.address, isAdmin: true });
  }));

  router.get('/me', asyncHandler(async (req, res) => {
    const header = req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: 'Missing Bearer token' });
      return;
    }
    const verified = await authService.verifyJwt(token);
    if (!verified) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    res.json({ address: verified.address, isAdmin: isAdminAddress(verified.address, config, repo) });
  }));

  return router;
}
```

- [ ] **Step 5: Restructure CORS + wire routers in `server.ts`**

In `src/server.ts`, update imports:

```ts
import { apiKeyAuth, HttpError } from './auth.js';
import type { AuthService } from './auth-service.js';
import { authRouter } from './routes/auth.js';
```

Replace the existing `cors(origins: string[])` helper with two CORS factories:

```ts
/** Browser CORS for subscribe/public endpoints: reflect any registered origin. */
function browserCors(repo: Repository) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header('origin');
    if (origin && repo.isOriginAllowedForAny(origin)) {
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
  };
}

/** Admin-plane CORS: allow exactly the configured dashboard origin + Bearer. */
function adminCors(config: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header('origin');
    if (origin && origin === config.dashboardOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}
```

Change the `createServer` signature and body. Replace the signature:

```ts
export function createServer(
  config: Config,
  repo: Repository,
  sender: PushSender,
  authService: AuthService,
): Application {
```

Replace the middleware/route registration block (from `const app = express();` through the `app.use('/notifications', notificationsRouter(ctx));` line — leaving the `ctx` definition above and the error-handling middleware + `return app;` below untouched) with:

```ts
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // Liveness (no CORS needed).
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Browser-facing endpoints: per-app CORS.
  app.get('/vapid-public-key', browserCors(repo), (_req, res) =>
    res.json({ publicKey: config.vapid.publicKey }),
  );
  app.use('/subscriptions', browserCors(repo), subscriptionsRouter(ctx));

  // Server-to-server delivery (x-api-key; no browser CORS).
  app.use('/notifications', notificationsRouter(ctx));

  // Admin plane: dashboard-origin CORS + thirdweb auth.
  app.use('/auth', adminCors(config), authRouter(config, repo, authService));
```

> Note: the `/admin` router is mounted in Task 12. The `ctx` object and error-handling middleware that follow remain unchanged. `subscriptionsRouter` keeps its `ctx.requireApiKey`-protected stats route.

- [ ] **Step 6: Update the existing integration test signature**

In `test/api.test.ts`, add the imports and pass a fake AuthService. Add near the top:

```ts
import { FakeAuthService } from './fake-auth-service.js';
```

Add the new config fields to the `config` object (after `maxFailures: 5,`):

```ts
  adminWallets: [],
  dashboardOrigin: 'http://localhost:5173',
  thirdweb: { secretKey: 'x', authPrivateKey: 'x', authDomain: 'localhost' },
```

Update the `createServer(...)` call in `before()`:

```ts
  const app = createServer(config, repo, sender, new FakeAuthService());
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test --import tsx ./test/admin.test.ts ./test/api.test.ts`
Expected: PASS (auth-route tests + unchanged api tests).

- [ ] **Step 8: Commit**

```bash
git add src/auth.ts src/routes/auth.ts src/server.ts test/api.test.ts test/admin.test.ts
git commit -m "feat: admin auth, /auth routes, and per-plane CORS"
```

---

## Task 12: Admin CRUD routes

**Files:**
- Modify: `src/schemas.ts`, `src/server.ts`
- Create: `src/routes/admin.ts`
- Test: `test/admin.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/admin.test.ts`:

```ts
describe('admin routes', () => {
  it('rejects unauthenticated access', async () => {
    const { base, close } = await startServer(makeConfig());
    const res = await fetch(`${base}/admin/apps`);
    assert.equal(res.status, 401);
    close();
  });

  it('rejects a non-admin token', async () => {
    const { base, close } = await startServer(makeConfig());
    const res = await fetch(`${base}/admin/apps`, {
      headers: { Authorization: 'Bearer faketoken:0xnope000000000000000000000000000000000003' },
    });
    assert.equal(res.status, 403);
    close();
  });

  it('runs the full app/key/origin/admin lifecycle', async () => {
    const { base, close } = await startServer(makeConfig());

    // Create an app.
    let res = await fetch(`${base}/admin/apps`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ appId: 'user-app', name: 'User App' }),
    });
    assert.equal(res.status, 201);

    res = await fetch(`${base}/admin/apps`, { headers: adminHeaders });
    assert.equal(((await res.json()) as unknown[]).length, 1);

    // Issue a key (secret returned once).
    res = await fetch(`${base}/admin/apps/user-app/keys`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ label: 'ci' }),
    });
    assert.equal(res.status, 201);
    const key = (await res.json()) as { id: number; secret: string };
    assert.match(key.secret, /^pk_/);

    // Listing keys never exposes the secret.
    res = await fetch(`${base}/admin/apps/user-app/keys`, { headers: adminHeaders });
    const keys = (await res.json()) as Record<string, unknown>[];
    assert.equal(keys.length, 1);
    assert.equal(keys[0].secret, undefined);

    // Revoke the key.
    res = await fetch(`${base}/admin/keys/${key.id}`, { method: 'DELETE', headers: adminHeaders });
    assert.equal(res.status, 204);

    // Add and list an origin.
    res = await fetch(`${base}/admin/apps/user-app/origins`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ origin: 'https://app.p2p.me' }),
    });
    assert.equal(res.status, 201);
    const origin = (await res.json()) as { id: number };

    res = await fetch(`${base}/admin/apps/user-app/origins`, { headers: adminHeaders });
    assert.equal(((await res.json()) as unknown[]).length, 1);

    res = await fetch(`${base}/admin/origins/${origin.id}`, { method: 'DELETE', headers: adminHeaders });
    assert.equal(res.status, 204);

    // Add and remove an admin.
    res = await fetch(`${base}/admin/admins`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ address: '0xBEEF000000000000000000000000000000000004', label: 'teammate' }),
    });
    assert.equal(res.status, 201);

    res = await fetch(`${base}/admin/admins`, { headers: adminHeaders });
    assert.equal(((await res.json()) as { managed: unknown[] }).managed.length, 1);

    res = await fetch(`${base}/admin/admins/0xBEEF000000000000000000000000000000000004`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    assert.equal(res.status, 204);

    // Delete the app.
    res = await fetch(`${base}/admin/apps/user-app`, { method: 'DELETE', headers: adminHeaders });
    assert.equal(res.status, 204);

    close();
  });

  it('validates request bodies with 400', async () => {
    const { base, close } = await startServer(makeConfig());
    const res = await fetch(`${base}/admin/apps`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ appId: 'Bad Id!', name: '' }),
    });
    assert.equal(res.status, 400);
    close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx ./test/admin.test.ts`
Expected: FAIL — `/admin/*` routes return 404 (not mounted).

- [ ] **Step 3: Add the schemas**

In `src/schemas.ts`, append:

```ts
export const createAppSchema = z.object({
  appId: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'appId must be lowercase alphanumeric/hyphen'),
  name: z.string().min(1).max(120),
});

export const updateAppSchema = z
  .object({ name: z.string().min(1).max(120).optional(), disabled: z.boolean().optional() })
  .refine((v) => v.name !== undefined || v.disabled !== undefined, {
    message: 'Provide at least one of: name, disabled',
  });

export const createKeySchema = z.object({ label: z.string().min(1).max(120).optional() });

export const addOriginSchema = z.object({ origin: z.string().url() });

export const addAdminSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'address must be a 0x-prefixed 40-hex string'),
  label: z.string().min(1).max(120).optional(),
});
```

- [ ] **Step 4: Implement the admin router**

Create `src/routes/admin.ts`:

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

/** Wallet-gated CRUD for apps, API keys, CORS origins, and admins. */
export function adminRouter(
  config: Config,
  repo: Repository,
  authService: AuthService,
): Router {
  const router = Router();
  router.use(requireAdmin(config, repo, authService));

  // --- Apps -----------------------------------------------------------------
  router.get('/apps', (_req, res) => res.json(repo.listApps()));

  router.post('/apps', (req, res) => {
    const body = createAppSchema.parse(req.body);
    if (repo.getApp(body.appId)) throw new HttpError(409, `App "${body.appId}" already exists`);
    res.status(201).json(repo.createApp(body));
  });

  router.patch('/apps/:appId', (req, res) => {
    const patch = updateAppSchema.parse(req.body);
    const updated = repo.updateApp(req.params.appId as string, patch);
    if (!updated) throw new HttpError(404, 'App not found');
    res.json(updated);
  });

  router.delete('/apps/:appId', (req, res) => {
    if (!repo.deleteApp(req.params.appId as string)) throw new HttpError(404, 'App not found');
    res.sendStatus(204);
  });

  // --- API keys -------------------------------------------------------------
  router.get('/apps/:appId/keys', (req, res) => {
    const appId = req.params.appId as string;
    if (!repo.getApp(appId)) throw new HttpError(404, 'App not found');
    res.json(repo.listApiKeys(appId));
  });

  router.post('/apps/:appId/keys', (req, res) => {
    const appId = req.params.appId as string;
    if (!repo.getApp(appId)) throw new HttpError(404, 'App not found');
    const body = createKeySchema.parse(req.body);
    const gen = generateApiKey();
    const rec = repo.createApiKey({
      appId,
      keyHash: gen.keyHash,
      keyPrefix: gen.keyPrefix,
      label: body.label ?? null,
      createdBy: req.admin?.address ?? null,
    });
    // The plaintext secret is returned exactly once.
    res.status(201).json({ ...rec, secret: gen.secret });
  });

  router.delete('/keys/:id', (req, res) => {
    if (!repo.revokeApiKey(Number(req.params.id))) throw new HttpError(404, 'Key not found');
    res.sendStatus(204);
  });

  // --- CORS origins ---------------------------------------------------------
  router.get('/apps/:appId/origins', (req, res) => {
    const appId = req.params.appId as string;
    if (!repo.getApp(appId)) throw new HttpError(404, 'App not found');
    res.json(repo.listCorsOrigins(appId));
  });

  router.post('/apps/:appId/origins', (req, res) => {
    const appId = req.params.appId as string;
    if (!repo.getApp(appId)) throw new HttpError(404, 'App not found');
    const body = addOriginSchema.parse(req.body);
    res.status(201).json(repo.addCorsOrigin({ appId, origin: body.origin }));
  });

  router.delete('/origins/:id', (req, res) => {
    if (!repo.deleteCorsOrigin(Number(req.params.id))) throw new HttpError(404, 'Origin not found');
    res.sendStatus(204);
  });

  // --- Admins ---------------------------------------------------------------
  router.get('/admins', (_req, res) => {
    res.json({ bootstrap: config.adminWallets, managed: repo.listAdmins() });
  });

  router.post('/admins', (req, res) => {
    const body = addAdminSchema.parse(req.body);
    res.status(201).json(
      repo.addAdmin({ address: body.address, label: body.label ?? null, addedBy: req.admin?.address ?? null }),
    );
  });

  router.delete('/admins/:address', (req, res) => {
    if (!repo.removeAdmin(req.params.address as string)) throw new HttpError(404, 'Admin not found');
    res.sendStatus(204);
  });

  return router;
}
```

> The `GET /admins` response shape is `{ bootstrap: string[], managed: AdminRecord[] }` (bootstrap = env wallets, read-only; managed = DB rows). The Task 12 test already reads `.managed` for the admin-list assertion.

- [ ] **Step 5: Mount the router in `server.ts`**

In `src/server.ts`, add the import:

```ts
import { adminRouter } from './routes/admin.js';
```

After the `/auth` mount line, add:

```ts
  app.use('/admin', adminCors(config), adminRouter(config, repo, authService));
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test --import tsx ./test/admin.test.ts`
Expected: PASS (all admin-route tests).

- [ ] **Step 7: Commit**

```bash
git add src/schemas.ts src/routes/admin.ts src/server.ts test/admin.test.ts
git commit -m "feat: admin CRUD routes for apps/keys/origins/admins"
```

---

## Task 13: Per-app origin enforcement on subscribe

**Files:**
- Modify: `src/routes/subscriptions.ts`
- Test: `test/admin.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/admin.test.ts`:

```ts
describe('per-app subscribe CORS enforcement', () => {
  it('allows a registered origin and blocks an unregistered one', async () => {
    const config = makeConfig();
    const { base, repo, close } = await startServer(config);
    repo.createApp({ appId: 'user-app', name: 'User App' });
    repo.addCorsOrigin({ appId: 'user-app', origin: 'https://app.p2p.me' });

    const sub = {
      appId: 'user-app',
      userId: 'alice',
      subscription: { endpoint: 'https://push.example.com/x', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(16) } },
    };

    const ok = await fetch(`${base}/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://app.p2p.me' },
      body: JSON.stringify(sub),
    });
    assert.equal(ok.status, 201);

    const blocked = await fetch(`${base}/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify(sub),
    });
    assert.equal(blocked.status, 403);

    close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx ./test/admin.test.ts`
Expected: FAIL — the blocked request returns 201 (no enforcement yet).

- [ ] **Step 3: Implement**

In `src/routes/subscriptions.ts`, add the `HttpError` import:

```ts
import { assertAppAccess, HttpError } from '../auth.js';
```

Replace the `router.post('/', ...)` handler with:

```ts
  router.post('/', (req, res) => {
    const parsed = subscribeSchema.parse(req.body);
    // When a browser sends an Origin, it must be registered for this app.
    const origin = req.header('origin');
    if (origin && !ctx.repo.isOriginAllowedForApp(parsed.appId, origin)) {
      throw new HttpError(403, `Origin ${origin} is not allowed for app "${parsed.appId}"`);
    }
    const record = ctx.repo.upsertSubscription({
      appId: parsed.appId,
      userId: parsed.userId ?? null,
      subscription: parsed.subscription,
      userAgent: req.header('user-agent') ?? null,
    });
    res.status(201).json({ id: record.id, appId: record.appId });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx ./test/admin.test.ts ./test/api.test.ts`
Expected: PASS (existing subscribe tests send no Origin, so they are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/routes/subscriptions.ts test/admin.test.ts
git commit -m "feat: enforce per-app origin on browser subscribe"
```

---

## Task 14: Wire it together in the composition root

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Implement**

Replace the body of `main()` in `src/index.ts` so it builds the auth service, seeds the DB, and passes the auth service to `createServer`. Replace the imports + `main` function:

```ts
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';
import { createServer } from './server.js';
import { PushSender } from './webpush.js';
import { createThirdwebAuthService } from './auth-service.js';
import { parseList } from './config.js';
import { seedFromEnv } from './seed.js';

/** Composition root: load config, wire dependencies, start listening. */
function main(): void {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const repo = new Repository(db);

  // One-time import of legacy env config (APP_KEYS / CORS_ORIGINS) into the DB.
  seedFromEnv(repo, {
    appKeys: config.appKeys,
    corsOrigins: config.corsOrigins.filter((o) => o !== '*'),
  });

  const sender = new PushSender(config, repo);
  const authService = createThirdwebAuthService(config);
  const app = createServer(config, repo, sender, authService);

  const server = app.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(`push-notifications listening on http://${config.host}:${config.port}`);
  });

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}, shutting down...`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
```

> `parseList` is imported for symmetry with config usage; if your linter flags it as unused, drop that import line — `corsOrigins` is already a parsed array on `Config`.

- [ ] **Step 2: Typecheck + full test run**

Run: `npm run typecheck && npm test`
Expected: PASS — no type errors, all suites green.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire thirdweb auth + env->DB seed into startup"
```

---

## Task 15: Document config in `.env.example` and `README.md`

**Files:**
- Modify: `.env.example`, `README.md`

- [ ] **Step 1: Update `.env.example`**

Append to `.env.example`:

```bash
# ---------------------------------------------------------------------------
# Admin dashboard (thirdweb wallet login)
# ---------------------------------------------------------------------------
# thirdweb project credentials (create at https://thirdweb.com/dashboard).
THIRDWEB_SECRET_KEY=
# A throwaway private key used ONLY to sign admin JWTs (no funds required).
THIRDWEB_AUTH_PRIVATE_KEY=
# SIWE domain — the host browsers see, e.g. push.p2p.me.
THIRDWEB_AUTH_DOMAIN=push.p2p.me
# Comma-separated bootstrap admin wallet addresses (embedded-wallet addresses).
ADMIN_WALLETS=
# Origin of the dashboard SPA, allowed to call /auth and /admin with credentials.
DASHBOARD_ORIGIN=http://localhost:5173

# NOTE: APP_KEYS and CORS_ORIGINS below are now OPTIONAL. They are imported into
# the database once on first boot; afterward the dashboard is the source of truth.
```

- [ ] **Step 2: Update `README.md`**

In `README.md`, under the Configuration table, add rows for the new variables and add a short "Admin dashboard" section after "Configuration":

```markdown
## Admin dashboard

A separate wallet-authenticated dashboard (`dashboard/`) manages apps, API keys,
and per-app CORS origins live in the database — replacing static `APP_KEYS` /
`CORS_ORIGINS` env config (those are imported once on first boot).

- **Login:** thirdweb in-app wallet (Google / email). Admins are whitelisted by
  wallet address via `ADMIN_WALLETS` (bootstrap) plus dashboard-managed admins.
- **First admin:** log in once to discover your embedded-wallet address (the UI
  shows it when not yet authorized), add it to `ADMIN_WALLETS`, then restart.
- **API keys** are shown in full exactly once at creation and stored hashed.

Run the dashboard:

\`\`\`bash
cd dashboard
npm install
cp .env.example .env   # set VITE_THIRDWEB_CLIENT_ID + VITE_API_BASE_URL
npm run dev
\`\`\`
```

- [ ] **Step 3: Commit**

```bash
git add .env.example README.md
git commit -m "docs: document admin dashboard config and bootstrap"
```

---

## Task 16: Scaffold the dashboard SPA

No automated tests (manual smoke per spec). Each frontend task ends with a manual check.

**Files:**
- Create: `dashboard/package.json`, `dashboard/tsconfig.json`, `dashboard/vite.config.ts`, `dashboard/index.html`, `dashboard/.env.example`, `dashboard/src/client.ts`, `dashboard/src/main.tsx`

- [ ] **Step 1: Create `dashboard/package.json`**

```json
{
  "name": "@p2pdotme/push-admin-dashboard",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0",
    "thirdweb": "^5"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.7.3",
    "vite": "^6.0.5"
  }
}
```

- [ ] **Step 2: Create `dashboard/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `dashboard/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
```

- [ ] **Step 4: Create `dashboard/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Push Admin</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `dashboard/.env.example`**

```bash
# thirdweb client id (public) from https://thirdweb.com/dashboard
VITE_THIRDWEB_CLIENT_ID=
# Base URL of the push API
VITE_API_BASE_URL=http://localhost:4000
```

- [ ] **Step 6: Create `dashboard/src/client.ts`**

```ts
import { createThirdwebClient } from 'thirdweb';

export const client = createThirdwebClient({
  clientId: import.meta.env.VITE_THIRDWEB_CLIENT_ID as string,
});

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string;
```

- [ ] **Step 7: Create `dashboard/src/main.tsx`**

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThirdwebProvider } from 'thirdweb/react';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThirdwebProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ThirdwebProvider>
  </React.StrictMode>,
);
```

> `App` is created in Task 18; the manual check below is deferred until then. To verify scaffolding now, temporarily render a placeholder by replacing `<App />` with `<div>hello</div>` and removing the `App` import, then revert in Task 18.

- [ ] **Step 8: Manual check (scaffold)**

Run:
```bash
cd dashboard && npm install && npm run dev
```
Expected: Vite serves at `http://localhost:5173` with no build errors (placeholder visible).

- [ ] **Step 9: Commit**

```bash
git add dashboard/package.json dashboard/tsconfig.json dashboard/vite.config.ts dashboard/index.html dashboard/.env.example dashboard/src/client.ts dashboard/src/main.tsx
git commit -m "feat: scaffold admin dashboard (Vite + React + thirdweb)"
```

---

## Task 17: Dashboard auth + API client

**Files:**
- Create: `dashboard/src/auth.ts`, `dashboard/src/api.ts`

- [ ] **Step 1: Create `dashboard/src/auth.ts`**

```ts
import { API_BASE_URL } from './client.js';

const TOKEN_KEY = 'push_admin_jwt';

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string): void => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

/**
 * thirdweb ConnectButton auth config. getLoginPayload/doLogin call our backend;
 * the issued JWT is stored in localStorage and sent as a Bearer token by api.ts.
 */
export const authConfig = {
  isLoggedIn: async (): Promise<boolean> => {
    const token = getToken();
    if (!token) return false;
    const res = await fetch(`${API_BASE_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  },

  getLoginPayload: async (params: { address: string; chainId?: number }) => {
    const res = await fetch(`${API_BASE_URL}/auth/payload?address=${params.address}`);
    if (!res.ok) throw new Error('Failed to get login payload');
    return res.json();
  },

  doLogin: async (params: unknown): Promise<void> => {
    const res = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string; address?: string };
      const hint = err.address ? ` Your wallet: ${err.address}` : '';
      throw new Error(`${err.error ?? 'Login failed'}.${hint}`);
    }
    const body = (await res.json()) as { token: string };
    setToken(body.token);
  },

  doLogout: async (): Promise<void> => {
    clearToken();
  },
};
```

- [ ] **Step 2: Create `dashboard/src/api.ts`**

```ts
import { API_BASE_URL } from './client.js';
import { clearToken, getToken } from './auth.js';

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    clearToken();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? (null as T) : ((await res.json()) as T);
}

export interface AppRecord { appId: string; name: string; disabled: boolean; createdAt: string }
export interface ApiKeyRecord {
  id: number; appId: string; keyPrefix: string; label: string | null;
  createdBy: string | null; createdAt: string; lastUsedAt: string | null; revokedAt: string | null;
}
export interface IssuedKey extends ApiKeyRecord { secret: string }
export interface CorsOriginRecord { id: number; appId: string; origin: string; createdAt: string }
export interface AdminRecord { address: string; label: string | null; addedBy: string | null; createdAt: string }

export const api = {
  listApps: () => req<AppRecord[]>('/admin/apps'),
  createApp: (b: { appId: string; name: string }) => req<AppRecord>('/admin/apps', { method: 'POST', body: JSON.stringify(b) }),
  deleteApp: (appId: string) => req<null>(`/admin/apps/${appId}`, { method: 'DELETE' }),

  listKeys: (appId: string) => req<ApiKeyRecord[]>(`/admin/apps/${appId}/keys`),
  createKey: (appId: string, b: { label?: string }) => req<IssuedKey>(`/admin/apps/${appId}/keys`, { method: 'POST', body: JSON.stringify(b) }),
  revokeKey: (id: number) => req<null>(`/admin/keys/${id}`, { method: 'DELETE' }),

  listOrigins: (appId: string) => req<CorsOriginRecord[]>(`/admin/apps/${appId}/origins`),
  addOrigin: (appId: string, b: { origin: string }) => req<CorsOriginRecord>(`/admin/apps/${appId}/origins`, { method: 'POST', body: JSON.stringify(b) }),
  deleteOrigin: (id: number) => req<null>(`/admin/origins/${id}`, { method: 'DELETE' }),

  listAdmins: () => req<{ bootstrap: string[]; managed: AdminRecord[] }>('/admin/admins'),
  addAdmin: (b: { address: string; label?: string }) => req<AdminRecord>('/admin/admins', { method: 'POST', body: JSON.stringify(b) }),
  removeAdmin: (address: string) => req<null>(`/admin/admins/${address}`, { method: 'DELETE' }),
};
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/auth.ts dashboard/src/api.ts
git commit -m "feat: dashboard auth config + typed admin API client"
```

---

## Task 18: Dashboard pages + layout

**Files:**
- Create: `dashboard/src/App.tsx`, `dashboard/src/pages/Apps.tsx`, `dashboard/src/pages/AppDetail.tsx`, `dashboard/src/pages/Admins.tsx`
- Modify: `dashboard/src/main.tsx` (revert placeholder from Task 16)

- [ ] **Step 1: Revert the Task 16 placeholder**

Ensure `dashboard/src/main.tsx` renders `<App />` (import from `./App.js`) as written in Task 16 Step 7 — undo any temporary placeholder.

- [ ] **Step 2: Create `dashboard/src/App.tsx`**

```tsx
import { useActiveAccount } from 'thirdweb/react';
import { ConnectButton, useActiveWallet } from 'thirdweb/react';
import { inAppWallet } from 'thirdweb/wallets';
import { Link, Route, Routes } from 'react-router-dom';
import { client } from './client.js';
import { authConfig } from './auth.js';
import { Apps } from './pages/Apps.js';
import { AppDetail } from './pages/AppDetail.js';
import { Admins } from './pages/Admins.js';

const wallets = [inAppWallet({ auth: { options: ['google', 'email'] } })];

export function App() {
  const account = useActiveAccount();
  const wallet = useActiveWallet();

  const connect = (
    <ConnectButton
      client={client}
      wallets={wallets}
      auth={authConfig}
      connectButton={{ label: 'Sign in' }}
    />
  );

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 920, margin: '0 auto', padding: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <nav style={{ display: 'flex', gap: 16 }}>
          <Link to="/">Apps</Link>
          <Link to="/admins">Admins</Link>
        </nav>
        {connect}
      </header>

      {!account || !wallet ? (
        <p>Sign in with your wallet to manage the push service. If your wallet
          is not yet authorized, the sign-in error will show your address — add it
          to <code>ADMIN_WALLETS</code> and restart the server.</p>
      ) : (
        <Routes>
          <Route path="/" element={<Apps />} />
          <Route path="/apps/:appId" element={<AppDetail />} />
          <Route path="/admins" element={<Admins />} />
        </Routes>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create `dashboard/src/pages/Apps.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AppRecord } from '../api.js';

export function Apps() {
  const [apps, setApps] = useState<AppRecord[]>([]);
  const [appId, setAppId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const load = () => api.listApps().then(setApps).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    setError('');
    try {
      await api.createApp({ appId, name });
      setAppId(''); setName('');
      await load();
    } catch (e) { setError((e as Error).message); }
  };

  const remove = async (id: string) => {
    if (!confirm(`Delete app ${id}? This removes its keys and origins.`)) return;
    await api.deleteApp(id);
    await load();
  };

  return (
    <section>
      <h1>Apps</h1>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <ul>
        {apps.map((a) => (
          <li key={a.appId}>
            <Link to={`/apps/${a.appId}`}>{a.appId}</Link> — {a.name}{a.disabled ? ' (disabled)' : ''}
            {' '}<button onClick={() => remove(a.appId)}>delete</button>
          </li>
        ))}
      </ul>
      <h3>Create app</h3>
      <input placeholder="app-id" value={appId} onChange={(e) => setAppId(e.target.value)} />
      <input placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} />
      <button onClick={create}>Create</button>
    </section>
  );
}
```

- [ ] **Step 4: Create `dashboard/src/pages/AppDetail.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type ApiKeyRecord, type CorsOriginRecord } from '../api.js';

export function AppDetail() {
  const { appId = '' } = useParams();
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [origins, setOrigins] = useState<CorsOriginRecord[]>([]);
  const [label, setLabel] = useState('');
  const [origin, setOrigin] = useState('');
  const [issued, setIssued] = useState<string>('');
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setKeys(await api.listKeys(appId));
      setOrigins(await api.listOrigins(appId));
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, [appId]);

  const issue = async () => {
    setError('');
    try {
      const k = await api.createKey(appId, { label: label || undefined });
      setIssued(k.secret); setLabel('');
      await load();
    } catch (e) { setError((e as Error).message); }
  };

  const revoke = async (id: number) => { await api.revokeKey(id); await load(); };
  const addOrigin = async () => {
    setError('');
    try { await api.addOrigin(appId, { origin }); setOrigin(''); await load(); }
    catch (e) { setError((e as Error).message); }
  };
  const removeOrigin = async (id: number) => { await api.deleteOrigin(id); await load(); };

  return (
    <section>
      <h1>{appId}</h1>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      <h3>API keys</h3>
      {issued && (
        <p style={{ background: '#fffbcc', padding: 8 }}>
          New key (copy now, shown once): <code>{issued}</code>
        </p>
      )}
      <ul>
        {keys.map((k) => (
          <li key={k.id}>
            <code>{k.keyPrefix}…</code> {k.label ?? ''} {k.revokedAt ? '(revoked)' : ''}
            {!k.revokedAt && <> <button onClick={() => revoke(k.id)}>revoke</button></>}
          </li>
        ))}
      </ul>
      <input placeholder="label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
      <button onClick={issue}>Issue key</button>

      <h3>CORS origins</h3>
      <ul>
        {origins.map((o) => (
          <li key={o.id}>{o.origin} <button onClick={() => removeOrigin(o.id)}>remove</button></li>
        ))}
      </ul>
      <input placeholder="https://app.example.com" value={origin} onChange={(e) => setOrigin(e.target.value)} />
      <button onClick={addOrigin}>Add origin</button>
    </section>
  );
}
```

- [ ] **Step 5: Create `dashboard/src/pages/Admins.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { api, type AdminRecord } from '../api.js';

export function Admins() {
  const [bootstrap, setBootstrap] = useState<string[]>([]);
  const [managed, setManaged] = useState<AdminRecord[]>([]);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try { const r = await api.listAdmins(); setBootstrap(r.bootstrap); setManaged(r.managed); }
    catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, []);

  const add = async () => {
    setError('');
    try { await api.addAdmin({ address, label: label || undefined }); setAddress(''); setLabel(''); await load(); }
    catch (e) { setError((e as Error).message); }
  };
  const remove = async (a: string) => { await api.removeAdmin(a); await load(); };

  return (
    <section>
      <h1>Admins</h1>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <h3>Bootstrap (env, read-only)</h3>
      <ul>{bootstrap.map((a) => <li key={a}><code>{a}</code></li>)}</ul>
      <h3>Managed</h3>
      <ul>
        {managed.map((a) => (
          <li key={a.address}><code>{a.address}</code> {a.label ?? ''} <button onClick={() => remove(a.address)}>remove</button></li>
        ))}
      </ul>
      <input placeholder="0x… address" value={address} onChange={(e) => setAddress(e.target.value)} />
      <input placeholder="label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
      <button onClick={add}>Add admin</button>
    </section>
  );
}
```

- [ ] **Step 6: Manual smoke test (end-to-end)**

Prerequisites: backend running with `ADMIN_WALLETS` set, a thirdweb client id in `dashboard/.env`.

```bash
# Terminal 1 — backend
npm run dev
# Terminal 2 — dashboard
cd dashboard && npm run dev
```
Verify:
1. Open `http://localhost:5173`, click "Sign in", complete Google/email login.
2. If unauthorized, the error shows your wallet address — add it to `ADMIN_WALLETS`, restart backend, sign in again.
3. Create an app, issue a key (secret shows once), add an origin, add/remove an admin.
4. Confirm the issued key works against the data API:
   `curl -H "x-api-key: <secret>" http://localhost:4000/subscriptions/stats/<appId>`.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/App.tsx dashboard/src/pages/Apps.tsx dashboard/src/pages/AppDetail.tsx dashboard/src/pages/Admins.tsx dashboard/src/main.tsx
git commit -m "feat: dashboard pages for apps, keys, origins, and admins"
```

---

## Final verification

- [ ] Run `npm run typecheck` (backend) — expect no errors.
- [ ] Run `npm test` (backend) — expect all suites green (`config`, `api-keys`, `repository`, `seed`, `admin`, `api`).
- [ ] Run `cd dashboard && npm run build` — expect a clean production build.
- [ ] Confirm the manual smoke test in Task 18 passes end-to-end.

# Wallet-signed Push Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a subscriber to prove control of the wallet address they subscribe under by signing a server-issued challenge, supporting EOA wallets and smart contract wallets (EIP-1271 / EIP-6492).

**Architecture:** A new isolated verifier module (`src/subscription-verify.ts`) builds an endpoint-bound EIP-4361 challenge and verifies the signature with viem (EOA + EIP-1271 + EIP-6492 against Base). Enforcement is a per-app opt-in flag (`apps.require_subscription_signature`). The browser client gains an optional `signMessage` callback that drives a challenge→sign→subscribe flow. The audited admin SIWE path (`auth-service.ts`, `siwe.ts`) is left untouched; the new module reuses only `createLoginMessage`/`generateNonce`.

**Tech Stack:** Node + Express + TypeScript, PostgreSQL (`pg`, `pg-mem` for tests), `ox` (existing EOA primitives), **viem** (new runtime dep, smart-wallet verification), `zod`, `node:test` + `tsx`.

## Global Constraints

- Node `>=20`; ESM (`"type": "module"`) — all relative imports use the `.js` extension even from `.ts` files.
- Test runner: `npm test` → `node --test --import tsx ./test/*.test.ts`. Typecheck: `npm run typecheck`.
- Tests run against `pg-mem` via `test/helpers/test-db.ts`, which executes `MIGRATION_SQL` verbatim — any DDL added to `MIGRATION_SQL` must parse under pg-mem 3.x.
- `disabled`-style booleans are stored as `integer` (0/1) and mapped to TS `boolean`. Follow this for the new flag column.
- Addresses are compared lowercased. Address shape: `/^0x[a-fA-F0-9]{40}$/`.
- The subscribe endpoint stays unauthenticated (no API key); it is origin-checked.
- Chain: Base, chain ID `8453`. Single chain for v1.
- Commit after every task. Commit messages end with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: Add viem dependency + verification config

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `src/config.ts:68-111`
- Test: `test/config.test.ts:56-63`

**Interfaces:**
- Produces: `Config.subscribeVerifyRpcUrl: string` (empty string when unset), `Config.subscribeVerifyChainId: number` (default `8453`).

- [ ] **Step 1: Add the failing config test**

In `test/config.test.ts`, add inside `describe('loadConfig auth env', ...)` (after the existing `defaults sendConcurrency` test):

```ts
  it('defaults subscribe verification chain to Base (8453) and rpc url to empty', () => {
    baseEnv();
    process.env.AUTH_DOMAIN = 'd';
    process.env.AUTH_JWT_SECRET = 's';
    delete process.env.SUBSCRIBE_VERIFY_RPC_URL;
    delete process.env.SUBSCRIBE_VERIFY_CHAIN_ID;
    const c = loadConfig();
    assert.equal(c.subscribeVerifyChainId, 8453);
    assert.equal(c.subscribeVerifyRpcUrl, '');
  });

  it('reads SUBSCRIBE_VERIFY_RPC_URL and SUBSCRIBE_VERIFY_CHAIN_ID', () => {
    baseEnv();
    process.env.AUTH_DOMAIN = 'd';
    process.env.AUTH_JWT_SECRET = 's';
    process.env.SUBSCRIBE_VERIFY_RPC_URL = 'https://base-rpc.example/key';
    process.env.SUBSCRIBE_VERIFY_CHAIN_ID = '8453';
    const c = loadConfig();
    assert.equal(c.subscribeVerifyRpcUrl, 'https://base-rpc.example/key');
    assert.equal(c.subscribeVerifyChainId, 8453);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern='subscribe verification'`
(or `node --test --import tsx ./test/config.test.ts`)
Expected: FAIL — `c.subscribeVerifyChainId` is `undefined`.

- [ ] **Step 3: Add the config fields**

In `src/config.ts`, add to the `Config` interface (after `logRetentionDays: number;`):

```ts
  subscribeVerifyRpcUrl: string;
  subscribeVerifyChainId: number;
```

In `loadConfig()`'s returned object (after `logRetentionDays: ...`):

```ts
    subscribeVerifyRpcUrl: optional('SUBSCRIBE_VERIFY_RPC_URL', ''),
    subscribeVerifyChainId: Number(optional('SUBSCRIBE_VERIFY_CHAIN_ID', '8453')),
```

- [ ] **Step 3b: Keep the typed Config literal in `test/api.test.ts` valid**

`test/api.test.ts` declares `const config: Config = { ... }` (a typed literal, not an `as Config` cast), so the new required fields must be added or `npm run typecheck` fails. Add to that object (after `logRetentionDays: 0,`):

```ts
  subscribeVerifyRpcUrl: '',
  subscribeVerifyChainId: 8453,
```

(Other tests — `auth-service.test.ts`, `auth-contract.test.ts` — use `{ ... } as Config` casts and need no change.)

- [ ] **Step 4: Add viem as a runtime dependency**

In `package.json`, add to `"dependencies"` (keep alphabetical-ish; after `"pg"`):

```json
    "viem": "^2.31.7",
```

Then install:

Run: `npm install`
Expected: `viem` resolves (already present transitively); lockfile updates, no errors.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test --import tsx ./test/config.test.ts`
Expected: PASS (all config tests green).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/config.ts test/config.test.ts test/api.test.ts
git commit -m "feat(config): add viem dep + SUBSCRIBE_VERIFY_RPC_URL/CHAIN_ID

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Migration + per-app `require_subscription_signature` flag

**Files:**
- Modify: `src/db.ts:29-93` (append ALTER statements to `MIGRATION_SQL`)
- Modify: `src/types.ts:59-65` (`AppRecord`)
- Modify: `src/repository.ts:41-55` (`AppRow`, `toAppRecord`), `:278-285` (`updateApp`)
- Test: `test/repository.test.ts`

**Interfaces:**
- Produces: `AppRecord.requireSubscriptionSignature: boolean`; `Repository.updateApp(appId, { name?, disabled?, requireSubscriptionSignature? })` persisting the flag; `apps.require_subscription_signature integer NOT NULL DEFAULT 0` column.

- [ ] **Step 1: Add the failing repository test**

In `test/repository.test.ts`, add a test (follow the file's existing `createTestPool()` + `new Repository(db)` setup; mirror an existing app test):

```ts
  it('defaults require_subscription_signature to false and toggles it via updateApp', async () => {
    const db = await createTestPool();
    const repo = new Repository(db);
    const app = await repo.createApp({ appId: 'sig-app', name: 'Sig App' });
    assert.equal(app.requireSubscriptionSignature, false);

    const updated = await repo.updateApp('sig-app', { requireSubscriptionSignature: true });
    assert.equal(updated?.requireSubscriptionSignature, true);

    // Unrelated patches must not clear the flag.
    const renamed = await repo.updateApp('sig-app', { name: 'Renamed' });
    assert.equal(renamed?.name, 'Renamed');
    assert.equal(renamed?.requireSubscriptionSignature, true);
  });
```

If `test/repository.test.ts` lacks the imports, ensure the top of the file has:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../src/repository.js';
import { createTestPool } from './helpers/test-db.js';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx ./test/repository.test.ts`
Expected: FAIL — `app.requireSubscriptionSignature` is `undefined`.

- [ ] **Step 3: Add the migration column**

In `src/db.ts`, immediately before the closing backtick of `MIGRATION_SQL` (after the `admins` table block), append:

```sql

  ALTER TABLE apps ADD COLUMN IF NOT EXISTS require_subscription_signature integer NOT NULL DEFAULT 0;
```

- [ ] **Step 4: Map the column in types + repository**

In `src/types.ts`, add to `AppRecord` (after `disabled: boolean;`):

```ts
  /** When true, subscribing under a wallet address requires a valid signature. */
  requireSubscriptionSignature: boolean;
```

In `src/repository.ts`, change `AppRow` to include the column:

```ts
interface AppRow {
  app_id: string;
  name: string;
  disabled: number;
  require_subscription_signature: number;
  created_at: string;
}
```

Change `toAppRecord`:

```ts
function toAppRecord(row: AppRow): AppRecord {
  return {
    appId: row.app_id,
    name: row.name,
    disabled: row.disabled === 1,
    requireSubscriptionSignature: row.require_subscription_signature === 1,
    createdAt: row.created_at,
  };
}
```

Replace `updateApp`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test --import tsx ./test/repository.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite to confirm the migration parses under pg-mem**

Run: `npm test`
Expected: PASS across all files (notably `test/db.test.ts`, which runs `MIGRATION_SQL`). If pg-mem rejects `ADD COLUMN IF NOT EXISTS`, that error surfaces here — it must pass before continuing.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/types.ts src/repository.ts test/repository.test.ts
git commit -m "feat(apps): per-app require_subscription_signature flag

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Subscription `verified_at` column + endpoint lookup

**Files:**
- Modify: `src/db.ts` (append ALTER statement to `MIGRATION_SQL`)
- Modify: `src/types.ts:36-49` (`SubscriptionRecord`)
- Modify: `src/repository.ts:11-39` (`SubscriptionRow`, `toRecord`), `:147-170` (`upsertSubscription`), add `getSubscriptionByEndpoint`
- Test: `test/repository.test.ts`

**Interfaces:**
- Consumes: `upsertSubscription` now takes `verifiedAt: string | null`.
- Produces: `SubscriptionRecord.verifiedAt: string | null`; `Repository.getSubscriptionByEndpoint(endpoint): Promise<SubscriptionRecord | null>`; upsert preserves an existing `verified_at` when `verifiedAt` is `null` (via `COALESCE`).

- [ ] **Step 1: Add the failing test**

In `test/repository.test.ts`, add:

```ts
  it('records verified_at on upsert and preserves it on a null re-sync', async () => {
    const db = await createTestPool();
    const repo = new Repository(db);
    const sub = { endpoint: 'https://push.example.com/x', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(16) } };

    const first = await repo.upsertSubscription({
      appId: 'user-app', userId: '0xabc', subscription: sub, userAgent: null, verifiedAt: null,
    });
    assert.equal(first.verifiedAt, null);

    const stamp = '2026-06-22T00:00:00.000Z';
    const verified = await repo.upsertSubscription({
      appId: 'user-app', userId: '0xabc', subscription: sub, userAgent: null, verifiedAt: stamp,
    });
    assert.ok(verified.verifiedAt, 'verified_at should be set');

    // A later null re-sync must NOT clear the prior verification.
    const resynced = await repo.upsertSubscription({
      appId: 'user-app', userId: '0xabc', subscription: sub, userAgent: 'UA', verifiedAt: null,
    });
    assert.ok(resynced.verifiedAt, 'verified_at must be preserved');

    const fetched = await repo.getSubscriptionByEndpoint(sub.endpoint);
    assert.equal(fetched?.userId, '0xabc');
    assert.ok(fetched?.verifiedAt);
    assert.equal(await repo.getSubscriptionByEndpoint('https://nope'), null);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx ./test/repository.test.ts`
Expected: FAIL — `upsertSubscription` rejects the extra `verifiedAt` key / `getSubscriptionByEndpoint` is not a function.

- [ ] **Step 3: Add the migration column**

In `src/db.ts`, append after the Task 2 ALTER (before the closing backtick):

```sql
  ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS verified_at timestamptz;
```

- [ ] **Step 4: Map the column + add the lookup**

In `src/types.ts`, add to `SubscriptionRecord` (after `disabled: number;`):

```ts
  /** When the subscriber proved control of `userId` via signature; null if unverified. */
  verifiedAt: string | null;
```

In `src/repository.ts`, add to `SubscriptionRow` (after `disabled: number;`):

```ts
  verified_at: string | null;
```

Add to `toRecord` (after `disabled: row.disabled,`):

```ts
    verifiedAt: row.verified_at,
```

Replace `upsertSubscription`:

```ts
  async upsertSubscription(input: {
    appId: string;
    userId: string | null;
    subscription: PushSubscriptionJSON;
    userAgent: string | null;
    verifiedAt: string | null;
  }): Promise<SubscriptionRecord> {
    const { appId, userId, subscription, userAgent, verifiedAt } = input;
    const q = sql(
      `INSERT INTO subscriptions (app_id, user_id, endpoint, p256dh, auth, user_agent, verified_at)
       VALUES (@appId, @userId, @endpoint, @p256dh, @auth, @userAgent, @verifiedAt)
       ON CONFLICT(endpoint) DO UPDATE SET
         app_id        = excluded.app_id,
         user_id       = excluded.user_id,
         p256dh        = excluded.p256dh,
         auth          = excluded.auth,
         user_agent    = excluded.user_agent,
         verified_at   = COALESCE(excluded.verified_at, subscriptions.verified_at),
         failure_count = 0,
         disabled      = 0
       RETURNING *`,
      { appId, userId, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, userAgent, verifiedAt },
    );
    const { rows } = await this.db.query(q.text, q.values);
    return toRecord(rows[0] as SubscriptionRow);
  }

  /** Fetch a single subscription by its push endpoint, or null. */
  async getSubscriptionByEndpoint(endpoint: string): Promise<SubscriptionRecord | null> {
    const { rows } = await this.db.query('SELECT * FROM subscriptions WHERE endpoint = $1', [endpoint]);
    return rows[0] ? toRecord(rows[0] as SubscriptionRow) : null;
  }
```

- [ ] **Step 5: Update the existing subscribe route's upsert call so the project compiles**

In `src/routes/subscriptions.ts`, the `POST /` handler calls `upsertSubscription`. Add `verifiedAt: null,` to that call (full route rewrite happens in Task 6; this keeps typecheck green now):

```ts
    const record = await ctx.repo.upsertSubscription({
      appId: parsed.appId,
      userId: parsed.userId ?? null,
      subscription: parsed.subscription,
      userAgent: req.header('user-agent') ?? null,
      verifiedAt: null,
    });
```

- [ ] **Step 6: Run tests + typecheck**

Run: `node --test --import tsx ./test/repository.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/types.ts src/repository.ts src/routes/subscriptions.ts test/repository.test.ts
git commit -m "feat(subscriptions): verified_at column + getSubscriptionByEndpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Request schemas + HttpError code plumbing

**Files:**
- Modify: `src/schemas.ts`
- Modify: `src/auth.ts:76-84` (`HttpError`)
- Modify: `src/server.ts:106-109` (error middleware)
- Test: `test/schemas.test.ts` (new)

**Interfaces:**
- Produces: `siwePayloadSchema`, `subscriptionChallengeSchema`, `subscribeSchema` (now with optional `payload`/`signature`), `updateAppSchema` (now accepts `requireSubscriptionSignature`); `new HttpError(status, message, code?)` whose `code` is serialized as `{ error, code }`.

- [ ] **Step 1: Write the failing schema test**

Create `test/schemas.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  subscribeSchema,
  subscriptionChallengeSchema,
  updateAppSchema,
} from '../src/schemas.js';

describe('subscriptionChallengeSchema', () => {
  it('accepts a valid address + endpoint', () => {
    const v = subscriptionChallengeSchema.parse({
      appId: 'user-app',
      address: '0x' + 'a'.repeat(40),
      endpoint: 'https://push.example.com/abc',
    });
    assert.equal(v.appId, 'user-app');
  });

  it('rejects a non-address', () => {
    assert.throws(() =>
      subscriptionChallengeSchema.parse({ appId: 'a', address: 'nope', endpoint: 'https://x' }),
    );
  });
});

describe('subscribeSchema', () => {
  it('accepts an optional payload + signature', () => {
    const v = subscribeSchema.parse({
      appId: 'user-app',
      userId: '0x' + 'b'.repeat(40),
      subscription: { endpoint: 'https://push.example.com/a', keys: { p256dh: 'p', auth: 'a' } },
      payload: {
        domain: 'app.example.com', address: '0x' + 'b'.repeat(40), version: '1',
        nonce: 'n', issued_at: 't', expiration_time: 't', invalid_before: 't',
        resources: ['push-channel:user-app:deadbeef'],
      },
      signature: '0xsig',
    });
    assert.equal(v.signature, '0xsig');
  });

  it('still accepts the legacy body without proof', () => {
    const v = subscribeSchema.parse({
      appId: 'user-app',
      userId: 'alice',
      subscription: { endpoint: 'https://push.example.com/a', keys: { p256dh: 'p', auth: 'a' } },
    });
    assert.equal(v.payload, undefined);
  });
});

describe('updateAppSchema', () => {
  it('accepts requireSubscriptionSignature alone', () => {
    const v = updateAppSchema.parse({ requireSubscriptionSignature: true });
    assert.equal(v.requireSubscriptionSignature, true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx ./test/schemas.test.ts`
Expected: FAIL — `subscriptionChallengeSchema` is not exported.

- [ ] **Step 3: Add the schemas**

In `src/schemas.ts`, replace `subscribeSchema` and add the new schemas:

```ts
/** EIP-4361 SIWE payload the client signs to prove wallet control. */
export const siwePayloadSchema = z.object({
  domain: z.string().min(1),
  address: z.string().min(1),
  statement: z.string().optional(),
  uri: z.string().optional(),
  version: z.string().min(1),
  chain_id: z.string().optional(),
  nonce: z.string().min(1),
  issued_at: z.string().min(1),
  expiration_time: z.string().min(1),
  invalid_before: z.string().min(1),
  resources: z.array(z.string()).optional(),
});

export const subscribeSchema = z.object({
  appId: z.string().min(1),
  userId: z.string().min(1).nullable().optional(),
  subscription: pushSubscriptionSchema,
  /** Optional proof-of-ownership (required when the app enables signatures). */
  payload: siwePayloadSchema.optional(),
  signature: z.string().min(1).optional(),
});

export const subscriptionChallengeSchema = z.object({
  appId: z.string().min(1),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'address must be a 0x-prefixed 40-hex string'),
  endpoint: z.string().url(),
});
```

Replace `updateAppSchema`:

```ts
export const updateAppSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    disabled: z.boolean().optional(),
    requireSubscriptionSignature: z.boolean().optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.disabled !== undefined || v.requireSubscriptionSignature !== undefined,
    { message: 'Provide at least one of: name, disabled, requireSubscriptionSignature' },
  );
```

- [ ] **Step 4: Add `code` to HttpError + serialize it**

In `src/auth.ts`, replace the `HttpError` class:

```ts
/** Lightweight error carrying an HTTP status (+ optional machine code), handled by the error middleware. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}
```

In `src/server.ts`, replace the `HttpError` branch of the error middleware:

```ts
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
      return;
    }
```

- [ ] **Step 5: Run tests + typecheck**

Run: `node --test --import tsx ./test/schemas.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts src/auth.ts src/server.ts test/schemas.test.ts
git commit -m "feat(schemas): subscribe proof + challenge schemas, HttpError.code

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Subscription verifier module

**Files:**
- Create: `src/subscription-verify.ts`
- Test: `test/subscription-verify.test.ts` (new)

**Interfaces:**
- Consumes: `createLoginMessage`, `generateNonce` from `src/siwe.js`; `Config` from `src/config.js`.
- Produces:
  - `type SignatureVerifier = (a: { address: string; message: string; signature: string }) => Promise<boolean>`
  - `viemSignatureVerifier(config: Config): SignatureVerifier`
  - `channelResource(appId: string, endpoint: string): string`
  - `createSubscriptionVerifier(config: Config, verifySignature?: SignatureVerifier): SubscriptionVerifier`
  - `type SubscriptionVerifier = { buildChallenge(a: { address; appId; endpoint; originHost }): { payload: LoginPayload; message: string }; verifyProof(a: { userId; appId; endpoint; originHost; payload: unknown; signature: string }): Promise<boolean> }`

- [ ] **Step 1: Write the failing test**

Create `test/subscription-verify.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as Secp256k1 from 'ox/Secp256k1';
import * as PersonalMessage from 'ox/PersonalMessage';
import * as Signature from 'ox/Signature';
import * as Hex from 'ox/Hex';
import * as Address from 'ox/Address';
import {
  channelResource,
  createSubscriptionVerifier,
  type SignatureVerifier,
} from '../src/subscription-verify.js';
import type { Config } from '../src/config.js';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDRESS = Address.fromPublicKey(Secp256k1.getPublicKey({ privateKey: PRIVATE_KEY })).toLowerCase();

const config = { subscribeVerifyRpcUrl: '', subscribeVerifyChainId: 8453 } as Config;

/** Offline EOA verifier (no network) used to exercise structural checks. */
const oxVerifier: SignatureVerifier = async ({ address, message, signature }) => {
  try {
    const hash = PersonalMessage.getSignPayload(Hex.fromString(message));
    const recovered = Secp256k1.recoverAddress({
      payload: hash,
      signature: Signature.fromHex(signature as `0x${string}`),
    });
    return recovered.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
};

function sign(message: string): string {
  const hash = PersonalMessage.getSignPayload(Hex.fromString(message));
  return Signature.toHex(Secp256k1.sign({ payload: hash, privateKey: PRIVATE_KEY }));
}

const ORIGIN = 'app.example.com';
const ENDPOINT = 'https://push.example.com/channel-1';
const APP = 'user-app';

describe('channelResource', () => {
  it('binds appId + endpoint deterministically', () => {
    const a = channelResource(APP, ENDPOINT);
    assert.match(a, /^push-channel:user-app:[0-9a-f]{64}$/);
    assert.notEqual(a, channelResource(APP, ENDPOINT + 'x'));
    assert.notEqual(a, channelResource('other', ENDPOINT));
  });
});

describe('verifyProof', () => {
  const verifier = createSubscriptionVerifier(config, oxVerifier);

  function freshProof(over: { endpoint?: string; appId?: string; originHost?: string } = {}) {
    const { payload, message } = verifier.buildChallenge({
      address: ADDRESS,
      appId: over.appId ?? APP,
      endpoint: over.endpoint ?? ENDPOINT,
      originHost: over.originHost ?? ORIGIN,
    });
    return { payload, signature: sign(message) };
  }

  it('accepts a valid EOA proof', async () => {
    const { payload, signature } = freshProof();
    const ok = await verifier.verifyProof({
      userId: ADDRESS, appId: APP, endpoint: ENDPOINT, originHost: ORIGIN, payload, signature,
    });
    assert.equal(ok, true);
  });

  it('rejects when the submitted endpoint differs from the signed one', async () => {
    const { payload, signature } = freshProof({ endpoint: ENDPOINT });
    const ok = await verifier.verifyProof({
      userId: ADDRESS, appId: APP, endpoint: 'https://push.example.com/OTHER',
      originHost: ORIGIN, payload, signature,
    });
    assert.equal(ok, false);
  });

  it('rejects when userId does not match the signer/payload address', async () => {
    const { payload, signature } = freshProof();
    const ok = await verifier.verifyProof({
      userId: '0x' + '1'.repeat(40), appId: APP, endpoint: ENDPOINT, originHost: ORIGIN, payload, signature,
    });
    assert.equal(ok, false);
  });

  it('rejects when the origin host does not match the signed domain', async () => {
    const { payload, signature } = freshProof({ originHost: ORIGIN });
    const ok = await verifier.verifyProof({
      userId: ADDRESS, appId: APP, endpoint: ENDPOINT, originHost: 'evil.example.com', payload, signature,
    });
    assert.equal(ok, false);
  });

  it('rejects an expired payload', async () => {
    const { payload, message } = verifier.buildChallenge({
      address: ADDRESS, appId: APP, endpoint: ENDPOINT, originHost: ORIGIN,
    });
    const expired = { ...payload, expiration_time: '2000-01-01T00:00:00.000Z' };
    // Sign the tampered message so only the time check (not the signature) fails.
    const ok = await verifier.verifyProof({
      userId: ADDRESS, appId: APP, endpoint: ENDPOINT, originHost: ORIGIN,
      payload: expired, signature: sign(message),
    });
    assert.equal(ok, false);
  });

  it('rejects a garbage signature', async () => {
    const { payload } = freshProof();
    const ok = await verifier.verifyProof({
      userId: ADDRESS, appId: APP, endpoint: ENDPOINT, originHost: ORIGIN,
      payload, signature: '0xnotreal',
    });
    assert.equal(ok, false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx ./test/subscription-verify.test.ts`
Expected: FAIL — cannot find module `../src/subscription-verify.js`.

- [ ] **Step 3: Implement the verifier module**

Create `src/subscription-verify.ts`:

```ts
import { createHash } from 'node:crypto';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import type { Config } from './config.js';
import { createLoginMessage, generateNonce, type LoginPayload } from './siwe.js';

/** Verifies an (address, message, signature) triple. Returns false on any failure. */
export type SignatureVerifier = (args: {
  address: string;
  message: string;
  signature: string;
}) => Promise<boolean>;

const STATEMENT =
  'Sign to receive push notifications for this wallet. Make sure the domain above matches this site.';
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

/** Deterministic binding of a push channel to an app: `push-channel:<appId>:<sha256(endpoint)>`. */
export function channelResource(appId: string, endpoint: string): string {
  const hash = createHash('sha256').update(endpoint).digest('hex');
  return `push-channel:${appId}:${hash}`;
}

/**
 * viem-backed verifier: EOA `ecrecover`, falling back to EIP-1271 and EIP-6492
 * against Base. EOA verification is offline; the contract paths use the RPC.
 * Uses `SUBSCRIBE_VERIFY_RPC_URL` when set, else viem's default Base RPC.
 */
export function viemSignatureVerifier(config: Config): SignatureVerifier {
  let client: ReturnType<typeof createPublicClient> | null = null;
  const getClient = () => {
    if (!client) {
      client = createPublicClient({
        chain: base,
        transport: http(config.subscribeVerifyRpcUrl || undefined),
      });
    }
    return client;
  };
  return async ({ address, message, signature }) => {
    try {
      return await getClient().verifyMessage({
        address: address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });
    } catch {
      return false;
    }
  };
}

export interface SubscriptionVerifier {
  buildChallenge(args: {
    address: string;
    appId: string;
    endpoint: string;
    originHost: string;
  }): { payload: LoginPayload; message: string };
  verifyProof(args: {
    userId: string;
    appId: string;
    endpoint: string;
    originHost: string;
    payload: unknown;
    signature: string;
  }): Promise<boolean>;
}

export function createSubscriptionVerifier(
  config: Config,
  verifySignature: SignatureVerifier = viemSignatureVerifier(config),
): SubscriptionVerifier {
  return {
    buildChallenge({ address, appId, endpoint, originHost }) {
      const now = Date.now();
      const payload: LoginPayload = {
        address: address.toLowerCase(),
        domain: originHost,
        uri: `https://${originHost}`,
        version: '1',
        chain_id: String(config.subscribeVerifyChainId),
        statement: STATEMENT,
        nonce: generateNonce(),
        issued_at: new Date(now).toISOString(),
        expiration_time: new Date(now + CHALLENGE_TTL_MS).toISOString(),
        invalid_before: new Date(now - CHALLENGE_TTL_MS).toISOString(),
        resources: [channelResource(appId, endpoint)],
      };
      return { payload, message: createLoginMessage(payload) };
    },

    async verifyProof({ userId, appId, endpoint, originHost, payload, signature }) {
      const p = payload as LoginPayload | null;
      if (!p || typeof p.address !== 'string') return false;

      // 1. Channel binding: the signed resource must match the submitted endpoint.
      const expected = channelResource(appId, endpoint);
      if (!Array.isArray(p.resources) || !p.resources.includes(expected)) return false;

      // 2. The proven address must equal the userId being subscribed.
      if (p.address.toLowerCase() !== userId.toLowerCase()) return false;

      // 3. Domain (anti-phishing) must match the calling origin host.
      if (p.domain !== originHost) return false;

      // 4. Freshness window.
      const now = Date.now();
      if (!p.expiration_time || Date.parse(p.expiration_time) < now) return false;
      if (!p.invalid_before || Date.parse(p.invalid_before) > now) return false;

      // 5. Cryptographic check (EOA / EIP-1271 / EIP-6492).
      const message = createLoginMessage(p);
      return verifySignature({ address: userId, message, signature });
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx ./test/subscription-verify.test.ts`
Expected: PASS (all structural cases green; no network used).

- [ ] **Step 5: Add the smart-wallet contract test (gated on RPC)**

Append to `test/subscription-verify.test.ts`:

```ts
describe('viem verifier (integration — needs RPC)', () => {
  const RPC = process.env.SUBSCRIBE_VERIFY_RPC_URL;
  it('verifies a real EOA signature through viem (offline)', async (t) => {
    const { viemSignatureVerifier } = await import('../src/subscription-verify.js');
    const verify = viemSignatureVerifier({ subscribeVerifyRpcUrl: RPC ?? '', subscribeVerifyChainId: 8453 } as Config);
    const message = 'hello viem';
    const hash = PersonalMessage.getSignPayload(Hex.fromString(message));
    const signature = Signature.toHex(Secp256k1.sign({ payload: hash, privateKey: PRIVATE_KEY }));
    assert.equal(await verify({ address: ADDRESS, message, signature }), true);
  });

  it('rejects a wrong-address EOA signature', async function (t) {
    if (!RPC) return t.skip('set SUBSCRIBE_VERIFY_RPC_URL to run the contract-wallet fallback path');
    const { viemSignatureVerifier } = await import('../src/subscription-verify.js');
    const verify = viemSignatureVerifier({ subscribeVerifyRpcUrl: RPC, subscribeVerifyChainId: 8453 } as Config);
    const message = 'hello viem';
    const hash = PersonalMessage.getSignPayload(Hex.fromString(message));
    const signature = Signature.toHex(Secp256k1.sign({ payload: hash, privateKey: PRIVATE_KEY }));
    assert.equal(await verify({ address: '0x' + '2'.repeat(40), message, signature }), false);
  });
});
```

- [ ] **Step 6: Run the test again**

Run: `node --test --import tsx ./test/subscription-verify.test.ts`
Expected: PASS; the wrong-address case is skipped unless `SUBSCRIBE_VERIFY_RPC_URL` is set.

- [ ] **Step 7: Commit**

```bash
git add src/subscription-verify.ts test/subscription-verify.test.ts
git commit -m "feat(verify): endpoint-bound SIWE challenge + viem signature verifier

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Wire verifier into the server + subscribe routes

**Files:**
- Modify: `src/server.ts:18-25` (`AppContext`), `:67-78` (`createServer`)
- Modify: `src/routes/subscriptions.ts` (full rewrite of the router)
- Test: `test/subscriptions-signing.test.ts` (new)

**Interfaces:**
- Consumes: `createSubscriptionVerifier`, `SubscriptionVerifier` from Task 5; `Repository.getApp`, `getSubscriptionByEndpoint`, `upsertSubscription`, `isOriginAllowedForApp` from Tasks 2–3.
- Produces: `POST /subscriptions/challenge`; signature enforcement in `POST /subscriptions`; `AppContext.verifier`; `createServer(config, repo, sender, authService, verifier?)`.

- [ ] **Step 1: Write the failing route test**

Create `test/subscriptions-signing.test.ts`:

```ts
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import webpush from 'web-push';
import * as Secp256k1 from 'ox/Secp256k1';
import * as PersonalMessage from 'ox/PersonalMessage';
import * as Signature from 'ox/Signature';
import * as Hex from 'ox/Hex';
import * as Address from 'ox/Address';
import type { Config } from '../src/config.js';
import { Repository } from '../src/repository.js';
import { PushSender } from '../src/webpush.js';
import { createServer } from '../src/server.js';
import { createSubscriptionVerifier, type SignatureVerifier } from '../src/subscription-verify.js';
import { FakeAuthService } from './fake-auth-service.js';
import { createTestPool } from './helpers/test-db.js';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDRESS = Address.fromPublicKey(Secp256k1.getPublicKey({ privateKey: PRIVATE_KEY })).toLowerCase();
const ORIGIN = 'http://app.example.com';

const vapid = webpush.generateVAPIDKeys();
const config: Config = {
  port: 0, host: '127.0.0.1', corsOrigins: ['*'],
  vapid: { publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: 'mailto:test@p2p.me' },
  databaseUrl: 'postgresql://localhost/test', adminApiKey: 'admin-key', appKeys: {},
  maxFailures: 5, adminWallets: [], dashboardOrigin: 'http://localhost:5173',
  authDomain: 'localhost', jwtSecret: 'x', sendConcurrency: 25, logRetentionDays: 0,
  subscribeVerifyRpcUrl: '', subscribeVerifyChainId: 8453,
};

const oxVerifier: SignatureVerifier = async ({ address, message, signature }) => {
  try {
    const hash = PersonalMessage.getSignPayload(Hex.fromString(message));
    const recovered = Secp256k1.recoverAddress({ payload: hash, signature: Signature.fromHex(signature as `0x${string}`) });
    return recovered.toLowerCase() === address.toLowerCase();
  } catch { return false; }
};

let server: Server;
let base: string;
let repo: Repository;

function makeSub(endpoint: string) {
  return { endpoint, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(16) } };
}

async function subscribeWithProof(endpoint: string, address = ADDRESS) {
  const chRes = await fetch(`${base}/subscriptions/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ appId: 'sig-app', address, endpoint }),
  });
  assert.equal(chRes.status, 200, 'challenge should succeed');
  const { payload, message } = (await chRes.json()) as { payload: unknown; message: string };
  const hash = PersonalMessage.getSignPayload(Hex.fromString(message));
  const signature = Signature.toHex(Secp256k1.sign({ payload: hash, privateKey: PRIVATE_KEY }));
  return fetch(`${base}/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ appId: 'sig-app', userId: address, subscription: makeSub(endpoint), payload, signature }),
  });
}

before(async () => {
  const db = await createTestPool();
  repo = new Repository(db);
  const sender = new PushSender(config, repo);
  await repo.createApp({ appId: 'sig-app', name: 'Sig App' });
  await repo.updateApp('sig-app', { requireSubscriptionSignature: true });
  await repo.addCorsOrigin({ appId: 'sig-app', origin: ORIGIN });
  await repo.createApp({ appId: 'open-app', name: 'Open App' });
  await repo.addCorsOrigin({ appId: 'open-app', origin: ORIGIN });
  const app = createServer(config, repo, sender, new FakeAuthService(), createSubscriptionVerifier(config, oxVerifier));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

describe('signature-required subscribe', () => {
  it('rejects subscribe without a signature (401 signature_required)', async () => {
    const res = await fetch(`${base}/subscriptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ appId: 'sig-app', userId: ADDRESS, subscription: makeSub('https://push.example.com/n1') }),
    });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code?: string }).code, 'signature_required');
  });

  it('rejects a null/non-address userId on a sig-required app', async () => {
    const res = await fetch(`${base}/subscriptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ appId: 'sig-app', userId: 'alice', subscription: makeSub('https://push.example.com/n2') }),
    });
    assert.equal(res.status, 401);
  });

  it('accepts a valid signed subscribe and records verified_at', async () => {
    const res = await subscribeWithProof('https://push.example.com/ok');
    assert.equal(res.status, 201);
    const stored = await repo.getSubscriptionByEndpoint('https://push.example.com/ok');
    assert.ok(stored?.verifiedAt, 'verified_at should be set');
  });

  it('rejects a signature bound to a different endpoint', async () => {
    const chRes = await fetch(`${base}/subscriptions/challenge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ appId: 'sig-app', address: ADDRESS, endpoint: 'https://push.example.com/sign-this' }),
    });
    const { payload, message } = (await chRes.json()) as { payload: unknown; message: string };
    const hash = PersonalMessage.getSignPayload(Hex.fromString(message));
    const signature = Signature.toHex(Secp256k1.sign({ payload: hash, privateKey: PRIVATE_KEY }));
    const res = await fetch(`${base}/subscriptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ appId: 'sig-app', userId: ADDRESS, subscription: makeSub('https://push.example.com/DIFFERENT'), payload, signature }),
    });
    assert.equal(res.status, 401);
  });

  it('allows an unsigned refresh of an already-verified (endpoint, userId)', async () => {
    await subscribeWithProof('https://push.example.com/refresh');
    const res = await fetch(`${base}/subscriptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ appId: 'sig-app', userId: ADDRESS, subscription: makeSub('https://push.example.com/refresh') }),
    });
    assert.equal(res.status, 201);
  });

  it('still allows legacy unsigned subscribe on a non-sig app', async () => {
    const res = await fetch(`${base}/subscriptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ appId: 'open-app', userId: 'alice', subscription: makeSub('https://push.example.com/legacy') }),
    });
    assert.equal(res.status, 201);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx ./test/subscriptions-signing.test.ts`
Expected: FAIL — `createServer` does not accept a 5th argument / `/subscriptions/challenge` 404s.

- [ ] **Step 3: Add the verifier to AppContext + createServer**

In `src/server.ts`, add the import near the other router imports:

```ts
import { createSubscriptionVerifier, type SubscriptionVerifier } from './subscription-verify.js';
```

Add to the `AppContext` interface (after `requireApiKey: ...`):

```ts
  /** Verifies wallet-signed subscribe proofs (EOA + smart wallet). */
  verifier: SubscriptionVerifier;
```

Change the `createServer` signature + ctx construction:

```ts
export function createServer(
  config: Config,
  repo: Repository,
  sender: PushSender,
  authService: AuthService,
  verifier: SubscriptionVerifier = createSubscriptionVerifier(config),
): Application {
  const ctx: AppContext = {
    config,
    repo,
    sender,
    requireApiKey: apiKeyAuth(config, repo),
    verifier,
  };
```

(The existing `src/index.ts` call site needs no change — it uses the default verifier.)

- [ ] **Step 4: Rewrite the subscriptions router**

Replace the entire body of `src/routes/subscriptions.ts`:

```ts
import { Router } from 'express';
import { asyncHandler } from '../async-handler.js';
import { assertAppAccess, HttpError } from '../auth.js';
import { subscribeSchema, subscriptionChallengeSchema, unsubscribeSchema } from '../schemas.js';
import type { AppContext } from '../server.js';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Browser-facing subscription management. `POST /subscriptions` registers a
 * channel; when the target app enables `require_subscription_signature`, the
 * caller must prove control of the wallet `userId` with a signed challenge
 * obtained from `POST /subscriptions/challenge`. The endpoint is otherwise
 * unauthenticated (browsers can't hold API keys) but is origin-checked.
 */
export function subscriptionsRouter(ctx: AppContext): Router {
  const router = Router();

  router.post('/challenge', asyncHandler(async (req, res) => {
    const parsed = subscriptionChallengeSchema.parse(req.body);
    const origin = req.header('origin');
    if (!origin || !(await ctx.repo.isOriginAllowedForApp(parsed.appId, origin))) {
      throw new HttpError(403, `Origin ${origin ?? '(none)'} is not allowed for app "${parsed.appId}"`);
    }
    const { payload, message } = ctx.verifier.buildChallenge({
      address: parsed.address,
      appId: parsed.appId,
      endpoint: parsed.endpoint,
      originHost: new URL(origin).host,
    });
    res.json({ payload, message });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const parsed = subscribeSchema.parse(req.body);
    const origin = req.header('origin');
    if (origin && !(await ctx.repo.isOriginAllowedForApp(parsed.appId, origin))) {
      throw new HttpError(403, `Origin ${origin} is not allowed for app "${parsed.appId}"`);
    }

    const app = await ctx.repo.getApp(parsed.appId);
    let verifiedAt: string | null = null;

    if (app?.requireSubscriptionSignature) {
      const userId = parsed.userId ?? null;
      if (!userId || !ADDRESS_RE.test(userId)) {
        throw new HttpError(401, 'A wallet signature is required to subscribe', 'signature_required');
      }

      if (parsed.payload && parsed.signature) {
        if (!origin) throw new HttpError(403, 'Origin header is required to verify a subscription signature');
        const ok = await ctx.verifier.verifyProof({
          userId,
          appId: parsed.appId,
          endpoint: parsed.subscription.endpoint,
          originHost: new URL(origin).host,
          payload: parsed.payload,
          signature: parsed.signature,
        });
        if (!ok) throw new HttpError(401, 'Invalid wallet signature', 'invalid_signature');
        verifiedAt = new Date().toISOString();
      } else {
        // Allow an unsigned refresh of an already-verified (endpoint, userId).
        const existing = await ctx.repo.getSubscriptionByEndpoint(parsed.subscription.endpoint);
        const sameUser = !!existing?.userId && existing.userId.toLowerCase() === userId.toLowerCase();
        if (!existing || !sameUser || !existing.verifiedAt) {
          throw new HttpError(401, 'A wallet signature is required to subscribe', 'signature_required');
        }
        // verifiedAt stays null; the upsert's COALESCE preserves the prior timestamp.
      }
    }

    const record = await ctx.repo.upsertSubscription({
      appId: parsed.appId,
      userId: parsed.userId ?? null,
      subscription: parsed.subscription,
      userAgent: req.header('user-agent') ?? null,
      verifiedAt,
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

- [ ] **Step 5: Run the new test to verify it passes**

Run: `node --test --import tsx ./test/subscriptions-signing.test.ts`
Expected: PASS (all signature cases green).

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — including the existing `test/api.test.ts` (legacy unsigned subscribe on `user-app`, which has no flag, still returns 201).

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/routes/subscriptions.ts test/subscriptions-signing.test.ts
git commit -m "feat(subscriptions): enforce wallet-signed subscribe + challenge endpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Admin API + dashboard toggle

**Files:**
- Modify: `dashboard/src/api.ts:27` (`AppRecord`), `:36-39` (add `updateApp`)
- Modify: `dashboard/src/pages/AppDetail.tsx`
- (Server side already works: `updateAppSchema` accepts the flag in Task 4, and the existing `PATCH /admin/apps/:appId` route forwards the parsed patch to `repo.updateApp`.)

**Interfaces:**
- Consumes: `PATCH /admin/apps/:appId` accepting `{ requireSubscriptionSignature }`.
- Produces: dashboard `api.updateApp(appId, patch)`; a toggle in `AppDetail`.

- [ ] **Step 1: Extend the dashboard API client**

In `dashboard/src/api.ts`, update the `AppRecord` interface:

```ts
export interface AppRecord { appId: string; name: string; disabled: boolean; requireSubscriptionSignature: boolean; createdAt: string }
```

Add to the `api` object (after the `deleteApp` line):

```ts
  updateApp: (appId: string, b: { name?: string; disabled?: boolean; requireSubscriptionSignature?: boolean }) =>
    req<AppRecord>(`/admin/apps/${appId}`, { method: 'PATCH', body: JSON.stringify(b) }),
```

- [ ] **Step 2: Add the toggle to AppDetail**

In `dashboard/src/pages/AppDetail.tsx`, add `api`-typed state + loader. Replace the component's state/`load` region and add a toggle block.

After the existing `useState` declarations (around line 12), add:

```tsx
  const [requireSig, setRequireSig] = useState(false);
```

Change `load` to also fetch the app record (the admin API exposes `listApps`; find this app):

```tsx
  const load = async () => {
    try {
      const apps = await api.listApps();
      const app = apps.find((a) => a.appId === appId);
      setRequireSig(app?.requireSubscriptionSignature ?? false);
      setKeys(await api.listKeys(appId));
      setOrigins(await api.listOrigins(appId));
    } catch (e) { setError((e as Error).message); }
  };
```

Add a handler (near the other handlers):

```tsx
  const toggleRequireSig = async () => {
    setError('');
    try {
      const next = !requireSig;
      await api.updateApp(appId, { requireSubscriptionSignature: next });
      setRequireSig(next);
    } catch (e) { setError((e as Error).message); }
  };
```

In the returned JSX, add this section just below `<h1>{appId}</h1>` (above the API keys section):

```tsx
      <h3>Subscription security</h3>
      <label>
        <input type="checkbox" checked={requireSig} onChange={toggleRequireSig} />{' '}
        Require a wallet signature to subscribe (EOA + smart wallets)
      </label>
```

- [ ] **Step 3: Typecheck + build the dashboard**

Run: `cd dashboard && npm install && npm run build`
Expected: build succeeds with no type errors. (The dashboard has no unit-test harness; the build is the gate.)

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/api.ts dashboard/src/pages/AppDetail.tsx
git commit -m "feat(dashboard): toggle require-subscription-signature per app

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Client SDK — `signMessage` flow

**Files:**
- Modify: `client/src/index.ts` (add `SubscribeOptions`, `SignatureRequiredError`, challenge flow)
- Modify: `client/src/react.ts` (thread `signMessage` through `usePush`)

**Interfaces:**
- Consumes: server `POST /subscriptions/challenge` and the `code: 'signature_required'` 401 from Task 6.
- Produces: `PushClient.subscribe(userId?, opts?: { signMessage?})`, `PushClient.sync(subscription, userId?, signMessage?)`, `SignatureRequiredError`, `usePush({ ..., signMessage? })`.

- [ ] **Step 1: Add the error type + subscribe options to the client**

In `client/src/index.ts`, after the `PushNotSupportedError` class, add:

```ts
/** Thrown when the app requires a wallet signature but no `signMessage` was supplied. */
export class SignatureRequiredError extends Error {
  constructor() {
    super('This app requires a wallet signature to subscribe; pass a signMessage callback');
    this.name = 'SignatureRequiredError';
  }
}

export interface SubscribeOptions {
  /**
   * Sign the server-issued challenge message to prove control of the wallet
   * `userId`. Works with any wallet (EOA or smart wallet) — return the
   * signature hex. Required when the target app enables signature enforcement.
   */
  signMessage?: (message: string) => Promise<string>;
}
```

- [ ] **Step 2: Thread `signMessage` through `subscribe` + `sync`**

In `client/src/index.ts`, replace the `subscribe` and `sync` methods and add a private helper:

```ts
  async subscribe(userId?: string, opts?: SubscribeOptions): Promise<PushSubscription> {
    if (!isPushSupported()) throw new PushNotSupportedError();

    const permission = await this.requestPermission();
    if (permission !== 'granted') {
      throw new Error(`Notification permission was not granted (${permission})`);
    }

    const registration = await this.registerServiceWorker();
    await navigator.serviceWorker.ready;

    const key = await this.getVapidPublicKey();
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      }));

    await this.sync(subscription, userId, opts?.signMessage);
    return subscription;
  }

  /** Send (or refresh) the subscription on the server, signing a proof when asked. */
  async sync(
    subscription: PushSubscription,
    userId?: string,
    signMessage?: (message: string) => Promise<string>,
  ): Promise<void> {
    let proof: { payload: unknown; signature: string } | undefined;
    if (signMessage && userId) {
      proof = await this.requestProof(subscription, userId, signMessage);
    }

    const res = await fetch(`${this.serverUrl}/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: this.appId,
        userId: userId ?? null,
        subscription: subscription.toJSON(),
        ...(proof ?? {}),
      }),
    });

    if (res.status === 401) {
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      if (body.code === 'signature_required') throw new SignatureRequiredError();
      throw new Error('Subscription rejected: invalid wallet signature');
    }
    if (!res.ok) {
      throw new Error(`Failed to register subscription: ${res.status}`);
    }
  }

  /** Fetch a challenge for this channel and sign it. */
  private async requestProof(
    subscription: PushSubscription,
    address: string,
    signMessage: (message: string) => Promise<string>,
  ): Promise<{ payload: unknown; signature: string }> {
    const res = await fetch(`${this.serverUrl}/subscriptions/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, address, endpoint: subscription.endpoint }),
    });
    if (!res.ok) throw new Error(`Failed to obtain subscription challenge: ${res.status}`);
    const { payload, message } = (await res.json()) as { payload: unknown; message: string };
    const signature = await signMessage(message);
    return { payload, signature };
  }
```

- [ ] **Step 3: Thread `signMessage` through the React hook**

In `client/src/react.ts`, add to `UsePushOptions` (after `userId?: string;`):

```ts
  /** Sign the challenge to prove wallet control (required for signature-enabled apps). */
  signMessage?: (message: string) => Promise<string>;
```

Destructure it and pass it to `subscribe`. Update the destructuring line:

```ts
  const { userId, signMessage, serverUrl, appId, serviceWorkerUrl, vapidPublicKey } = options;
```

Update the `subscribe` callback body + deps:

```ts
  const subscribe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await client.subscribe(userId, { signMessage });
      setPermission(Notification.permission);
      setSubscribed(true);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [client, userId, signMessage]);
```

- [ ] **Step 4: Typecheck + build the client**

Run: `cd client && npm install && npm run build`
Expected: build succeeds, emits `dist/`. (The client package has no unit-test harness; the type-checked build is the gate.)

- [ ] **Step 5: Commit**

```bash
git add client/src/index.ts client/src/react.ts
git commit -m "feat(client): wallet signMessage flow for signed subscribe

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Documentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Document the env vars**

In `.env.example`, under the "Runtime tuning (optional — defaults shown)" section (or a new "Subscription signature verification" block), add:

```bash
# ---------------------------------------------------------------------------
# Subscription signature verification (per-app opt-in)
# ---------------------------------------------------------------------------
# When an app enables "require signature", subscribers must prove control of
# their wallet address. EOA signatures verify offline; smart-wallet (EIP-1271 /
# EIP-6492) signatures need a Base RPC. If unset, viem's default public Base RPC
# is used (rate-limited — set a dedicated endpoint for production).
SUBSCRIBE_VERIFY_RPC_URL=
SUBSCRIBE_VERIFY_CHAIN_ID=8453         # Base mainnet
```

- [ ] **Step 2: Document the feature in the README**

In `README.md`, add a new `## Wallet-signed subscriptions` section after the
subscribe-related content. Write it with this structure and wording (it contains
one nested ` ```ts ` example — author it directly in the README, no escaping needed):

- **Intro paragraph:** "By default the subscribe endpoint is open (browsers can't
  hold API keys). To stop anyone registering a push channel under someone else's
  wallet address, enable **Require a wallet signature to subscribe** for an app in
  the dashboard."
- **Numbered flow:**
  1. The browser subscribes via `PushManager` (gets its `endpoint`).
  2. It calls `POST /subscriptions/challenge` `{ appId, address, endpoint }` and
     receives an EIP-4361 `{ payload, message }`, bound to the exact push channel
     (`appId` + `sha256(endpoint)`) and the calling origin.
  3. The wallet signs `message`; the browser posts the subscription plus
     `{ payload, signature }`.
- **Verification paragraph:** "The server verifies the signature with viem against
  **Base** — `ecrecover` for EOAs, EIP-1271 `isValidSignature` for deployed smart
  wallets, and EIP-6492 for counterfactual (not-yet-deployed) ones."
- **A ```ts code block** showing the SDK usage:

      const push = usePush({
        serverUrl: 'https://push.p2p.me',
        appId: 'user-app',
        userId: walletAddress,                        // the wallet to prove
        signMessage: (msg) => wallet.signMessage(msg) // EOA or smart wallet
      });

- **Closing notes:** "If the app requires a signature and no `signMessage` is
  provided, `subscribe()` throws `SignatureRequiredError`. Already-verified
  channels refresh without re-signing; a new endpoint or a changed wallet requires
  a fresh signature. Configure `SUBSCRIBE_VERIFY_RPC_URL` (a Base RPC) for
  smart-wallet verification."

- [ ] **Step 3: Sanity-check the docs render**

Run: `git diff --stat`
Expected: `.env.example` and `README.md` modified. Re-read both diffs to confirm no stray placeholders.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs: document wallet-signed subscriptions + verification env vars

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run the whole suite: `npm test` → all green.
- [ ] Typecheck the server: `npm run typecheck` → no errors.
- [ ] Build the client: `cd client && npm run build` → succeeds.
- [ ] Build the dashboard: `cd dashboard && npm run build` → succeeds.
- [ ] Manual smoke (optional, needs a Base RPC): set `SUBSCRIBE_VERIFY_RPC_URL`, enable the flag on a test app, and confirm a real smart-wallet (e.g. a thirdweb in-app/smart account) subscribe succeeds end-to-end.

## Notes for the implementer

- **Isolation:** the new verifier (`src/subscription-verify.ts`) is independent of the admin SIWE path. Do not modify `src/auth-service.ts` or `src/siwe.ts` beyond importing `createLoginMessage`/`generateNonce`.
- **Why endpoint binding:** the signed `resources` entry commits to `sha256(endpoint)`, so a captured signature can't be replayed to attach a different browser. Keep this check first in `verifyProof`.
- **Why `COALESCE` in the upsert:** a `null` `verifiedAt` on refresh must preserve an earlier verification rather than wipe it.
- **EOA offline property:** viem `verifyMessage` resolves valid EOA signatures without a network call; the RPC is only hit for the contract-wallet (1271/6492) fallback. This is what lets the route/verifier tests run offline with the injected `oxVerifier`.

# Ultra-lightweight Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the heavyweight `thirdweb` dependency from the push server and trim its runtime footprint, with zero observable behaviour change.

**Architecture:** Replace the thirdweb-backed `AuthService` with a tiny self-contained SIWE verifier (`ox` for secp256k1 recovery, copied EIP-4361 serializer) plus an HS256 JWT issued/verified with `node:crypto`. Keep the `AuthService` interface, all routes, the dashboard, and the SQLite schema untouched. Add concurrency-limited push fan-out, low-RAM SQLite pragmas, optional log retention, and a slimmer Docker runtime.

**Tech Stack:** Node ≥20, TypeScript (ESM), express, better-sqlite3, web-push, zod, `ox` (new), `node:crypto`. `thirdweb` demoted to a devDependency used only by a contract test.

## Global Constraints

- **ESM only** — `package.json` has `"type": "module"`; every relative import in `src/` and `test/` ends in `.js` (e.g. `import { x } from './siwe.js'`). TypeScript source files are `.ts`.
- **Node ≥20** (`engines.node`). `node:crypto`, `Buffer.from(..., 'base64url')`, and `globalThis.crypto` are all available.
- **`AuthService` interface is frozen.** Its three methods keep these exact signatures (from `src/auth-service.ts`):
  - `generatePayload(address: string): Promise<unknown>`
  - `verifyAndIssueJwt(payload: unknown, signature: string): Promise<{ address: string; token: string } | null>`
  - `verifyJwt(token: string): Promise<{ address: string } | null>`
  Addresses returned are always lowercased.
- **Wire-compatible login.** The SIWE message our server verifies MUST be byte-identical to what the dashboard's thirdweb client signs. The copied `createLoginMessage` and the Task 5 contract test enforce this.
- **Env backward compatibility.** New env names fall back to the old ones: `AUTH_DOMAIN || THIRDWEB_AUTH_DOMAIN`, `AUTH_JWT_SECRET || THIRDWEB_AUTH_PRIVATE_KEY`. `THIRDWEB_SECRET_KEY` is no longer required.
- **Test runner:** `node --test --import tsx ./test/*.test.ts` (via `npm test`). Tests use `node:test` (`describe`/`it`) and `node:assert/strict`, matching existing tests in `test/`.
- **Commit style:** Conventional commits. Commit after each task's tests pass.

---

### Task 1: SIWE module (`src/siwe.ts`)

Self-contained EIP-4361 message builder + EOA signature recovery, using `ox`.

**Files:**
- Create: `src/siwe.ts`
- Create: `test/siwe.test.ts`
- Modify: `package.json` (add `ox` to `dependencies`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface LoginPayload { domain: string; address: string; statement: string; uri?: string; version: string; chain_id?: string; nonce: string; issued_at: string; expiration_time: string; invalid_before: string; resources?: string[] }`
  - `createLoginMessage(payload: LoginPayload): string`
  - `generateNonce(): string`
  - `recoverSiweAddress(payload: LoginPayload, signature: string): string | null` — lowercased recovered address, or `null` on any failure.

- [ ] **Step 1: Add `ox` dependency**

```bash
npm install ox@^0.7.0
```
Expected: `ox` appears under `dependencies` in `package.json`; `package-lock.json` updates. (`ox` is already present transitively, so this mostly records the direct dependency.)

- [ ] **Step 2: Write the failing test**

Create `test/siwe.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as Secp256k1 from 'ox/Secp256k1';
import * as PersonalMessage from 'ox/PersonalMessage';
import * as Signature from 'ox/Signature';
import * as Hex from 'ox/Hex';
import * as Address from 'ox/Address';
import { createLoginMessage, recoverSiweAddress, type LoginPayload } from '../src/siwe.js';

// Hardhat account #0 — a well-known test key. Never use in production.
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDRESS = Address.fromPublicKey(Secp256k1.getPublicKey({ privateKey: PRIVATE_KEY }));

function payload(over: Partial<LoginPayload> = {}): LoginPayload {
  return {
    domain: 'admin.push.p2p.me',
    address: ADDRESS,
    statement: 'Please ensure that the domain above matches the URL of the current website.',
    uri: 'admin.push.p2p.me',
    version: '1',
    nonce: 'abc123',
    issued_at: '2026-06-16T00:00:00.000Z',
    expiration_time: '2026-06-16T00:10:00.000Z',
    invalid_before: '2026-06-15T23:50:00.000Z',
    ...over,
  };
}

function signPayload(p: LoginPayload): string {
  const hash = PersonalMessage.getSignPayload(Hex.fromString(createLoginMessage(p)));
  return Signature.toHex(Secp256k1.sign({ payload: hash, privateKey: PRIVATE_KEY }));
}

describe('createLoginMessage', () => {
  it('produces the EIP-4361 header and ordered fields', () => {
    const msg = createLoginMessage(payload());
    assert.ok(msg.startsWith('admin.push.p2p.me wants you to sign in with your Ethereum account:'));
    assert.ok(msg.includes('\nVersion: 1\n'));
    assert.ok(msg.includes('Nonce: abc123'));
    assert.ok(msg.includes('Expiration Time: 2026-06-16T00:10:00.000Z'));
    assert.ok(msg.includes('Not Before: 2026-06-15T23:50:00.000Z'));
  });
});

describe('recoverSiweAddress', () => {
  it('recovers the signer for a valid signature', () => {
    const p = payload();
    assert.equal(recoverSiweAddress(p, signPayload(p)), ADDRESS.toLowerCase());
  });

  it('returns a different address if the payload is tampered after signing', () => {
    const p = payload();
    const sig = signPayload(p);
    const tampered = payload({ nonce: 'different' });
    assert.notEqual(recoverSiweAddress(tampered, sig), ADDRESS.toLowerCase());
  });

  it('returns null for a malformed signature', () => {
    assert.equal(recoverSiweAddress(payload(), 'not-a-signature'), null);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- 2>&1 | head -40` (or `node --test --import tsx ./test/siwe.test.ts`)
Expected: FAIL — cannot find module `../src/siwe.js`.

- [ ] **Step 4: Write `src/siwe.ts`**

```ts
import { randomBytes } from 'node:crypto';
import * as Hex from 'ox/Hex';
import * as PersonalMessage from 'ox/PersonalMessage';
import * as Secp256k1 from 'ox/Secp256k1';
import * as Signature from 'ox/Signature';

/** EIP-4361 / CAIP-122 login payload (same shape the thirdweb client signs). */
export interface LoginPayload {
  domain: string;
  address: string;
  statement: string;
  uri?: string;
  version: string;
  chain_id?: string;
  nonce: string;
  issued_at: string;
  expiration_time: string;
  invalid_before: string;
  resources?: string[];
}

/**
 * Build the EIP-4361 message to sign. Copied verbatim from thirdweb's internal
 * `createLoginMessage` so the bytes we verify match exactly what the dashboard's
 * thirdweb client produces. The Task 5 contract test guards this equivalence.
 */
export function createLoginMessage(payload: LoginPayload): string {
  const typeField = 'Ethereum';
  const header = `${payload.domain} wants you to sign in with your ${typeField} account:`;
  let prefix = [header, payload.address].join('\n');
  prefix = [prefix, payload.statement].join('\n\n');
  if (payload.statement) {
    prefix += '\n';
  }
  const suffixArray: string[] = [];
  if (payload.uri) {
    suffixArray.push(`URI: ${payload.uri}`);
  }
  suffixArray.push(`Version: ${payload.version}`);
  if (payload.chain_id) {
    suffixArray.push(`Chain ID: ${payload.chain_id}`);
  }
  suffixArray.push(`Nonce: ${payload.nonce}`);
  suffixArray.push(`Issued At: ${payload.issued_at}`);
  suffixArray.push(`Expiration Time: ${payload.expiration_time}`);
  if (payload.invalid_before) {
    suffixArray.push(`Not Before: ${payload.invalid_before}`);
  }
  if (payload.resources) {
    suffixArray.push(['Resources:', ...payload.resources.map((x) => `- ${x}`)].join('\n'));
  }
  const suffix = suffixArray.join('\n');
  return [prefix, suffix].join('\n');
}

/** 16 random bytes as hex — single-use nonce for a login payload. */
export function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Recover the EOA address that signed this payload (EIP-191 personal_sign over
 * the EIP-4361 message), lowercased. Returns null on any malformed input —
 * honouring a "bad input is a failure, not a throw" contract.
 */
export function recoverSiweAddress(payload: LoginPayload, signature: string): string | null {
  try {
    const message = createLoginMessage(payload);
    const hash = PersonalMessage.getSignPayload(Hex.fromString(message));
    const address = Secp256k1.recoverAddress({
      payload: hash,
      signature: Signature.fromHex(signature as `0x${string}`),
    });
    return address.toLowerCase();
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test --import tsx ./test/siwe.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add src/siwe.ts test/siwe.test.ts package.json package-lock.json
git commit -m "feat: self-contained SIWE message builder and EOA recovery (ox)"
```

---

### Task 2: HS256 JWT module (`src/jwt.ts`)

Zero-dependency JWT issue/verify using `node:crypto`. The token is consumed only by our own server.

**Files:**
- Create: `src/jwt.ts`
- Create: `test/jwt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `issueJwt(secret: string, sub: string, ttlSeconds: number): string`
  - `verifyJwt(secret: string, token: string): { address: string } | null` — lowercased `sub`, or `null` if signature/format/expiry invalid.

- [ ] **Step 1: Write the failing test**

Create `test/jwt.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { issueJwt, verifyJwt } from '../src/jwt.js';

const SECRET = 'unit-test-secret';

describe('jwt', () => {
  it('round-trips and lowercases the address', () => {
    const token = issueJwt(SECRET, '0xAbC', 3600);
    assert.deepEqual(verifyJwt(SECRET, token), { address: '0xabc' });
  });

  it('rejects a token signed with a different secret', () => {
    const token = issueJwt(SECRET, '0xabc', 3600);
    assert.equal(verifyJwt('other-secret', token), null);
  });

  it('rejects an expired token', () => {
    const token = issueJwt(SECRET, '0xabc', -1);
    assert.equal(verifyJwt(SECRET, token), null);
  });

  it('rejects a structurally invalid token', () => {
    assert.equal(verifyJwt(SECRET, 'garbage'), null);
    assert.equal(verifyJwt(SECRET, 'a.b'), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx ./test/jwt.test.ts`
Expected: FAIL — cannot find module `../src/jwt.js`.

- [ ] **Step 3: Write `src/jwt.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/** HMAC-SHA256 over `data` keyed by `secret`, base64url-encoded. */
function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

const encode = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj)).toString('base64url');

/** Issue an HS256 JWT carrying `sub` (the address), valid for `ttlSeconds`. */
export function issueJwt(secret: string, sub: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub, iat: now, exp: now + ttlSeconds });
  const data = `${header}.${payload}`;
  return `${data}.${sign(data, secret)}`;
}

/** Verify an HS256 JWT: signature (constant-time), structure, and expiry. */
export function verifyJwt(secret: string, token: string): { address: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, providedSig] = parts;

  const expectedSig = sign(`${header}.${payload}`, secret);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
    if (Math.floor(Date.now() / 1000) >= claims.exp) return null;
    return { address: claims.sub.toLowerCase() };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx ./test/jwt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jwt.ts test/jwt.test.ts
git commit -m "feat: HS256 JWT issue/verify via node:crypto"
```

---

### Task 3: Config changes (`src/config.ts`)

Drop the thirdweb-only requirements; expose `authDomain`, `jwtSecret`, and `sendConcurrency`/`logRetentionDays` (used by later tasks) with backward-compatible env fallbacks.

**Files:**
- Modify: `src/config.ts`
- Modify: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (on `Config`):
  - `authDomain: string`
  - `jwtSecret: string`
  - `sendConcurrency: number`
  - `logRetentionDays: number`
  - The `thirdweb` block is removed.

- [ ] **Step 1: Read the current config test to learn its setup helper**

Run: `sed -n '1,60p' test/config.test.ts`
Expected: see how it sets `process.env` before calling `loadConfig()` (note which vars it sets). You will mirror that style.

- [ ] **Step 2: Write the failing test**

Add these cases to `test/config.test.ts` (inside the existing describe, or a new one). Set the env vars the existing tests already set for VAPID/ADMIN_API_KEY; the snippet below only shows the new assertions:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

function baseEnv(): void {
  process.env.VAPID_PUBLIC_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
  process.env.ADMIN_API_KEY = 'admin';
  delete process.env.THIRDWEB_SECRET_KEY;
  delete process.env.AUTH_DOMAIN;
  delete process.env.AUTH_JWT_SECRET;
  delete process.env.THIRDWEB_AUTH_DOMAIN;
  delete process.env.THIRDWEB_AUTH_PRIVATE_KEY;
}

describe('loadConfig auth env', () => {
  it('reads AUTH_DOMAIN and AUTH_JWT_SECRET', () => {
    baseEnv();
    process.env.AUTH_DOMAIN = 'admin.push.p2p.me';
    process.env.AUTH_JWT_SECRET = 'secret';
    const c = loadConfig();
    assert.equal(c.authDomain, 'admin.push.p2p.me');
    assert.equal(c.jwtSecret, 'secret');
  });

  it('falls back to THIRDWEB_AUTH_DOMAIN / THIRDWEB_AUTH_PRIVATE_KEY', () => {
    baseEnv();
    process.env.THIRDWEB_AUTH_DOMAIN = 'legacy.example';
    process.env.THIRDWEB_AUTH_PRIVATE_KEY = '0xdeadbeef';
    const c = loadConfig();
    assert.equal(c.authDomain, 'legacy.example');
    assert.equal(c.jwtSecret, '0xdeadbeef');
  });

  it('no longer requires THIRDWEB_SECRET_KEY', () => {
    baseEnv();
    process.env.AUTH_DOMAIN = 'd';
    process.env.AUTH_JWT_SECRET = 's';
    assert.doesNotThrow(() => loadConfig());
  });

  it('defaults sendConcurrency to 25 and logRetentionDays to 0', () => {
    baseEnv();
    process.env.AUTH_DOMAIN = 'd';
    process.env.AUTH_JWT_SECRET = 's';
    const c = loadConfig();
    assert.equal(c.sendConcurrency, 25);
    assert.equal(c.logRetentionDays, 0);
  });
});
```

If `test/config.test.ts` already asserts on the removed `thirdweb` block, update or delete those assertions to match the new shape.

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test --import tsx ./test/config.test.ts`
Expected: FAIL — `authDomain`/`jwtSecret`/`sendConcurrency` undefined.

- [ ] **Step 4: Edit `src/config.ts`**

In the `Config` interface, remove the `thirdweb: { secretKey; authPrivateKey; authDomain }` block and add:

```ts
  authDomain: string;
  jwtSecret: string;
  sendConcurrency: number;
  logRetentionDays: number;
```

Add a helper near `optional`:

```ts
/** First non-empty value among the given env var names, else fallback. */
function firstEnv(names: string[], fallback: string): string {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim() !== '') return value.trim();
  }
  return fallback;
}
```

In `loadConfig()`, remove the `thirdweb: { secretKey: required('THIRDWEB_SECRET_KEY'), ... }` block and replace with:

```ts
    authDomain: firstEnv(['AUTH_DOMAIN', 'THIRDWEB_AUTH_DOMAIN'], ''),
    jwtSecret: required2(['AUTH_JWT_SECRET', 'THIRDWEB_AUTH_PRIVATE_KEY']),
    sendConcurrency: Number(optional('SEND_CONCURRENCY', '25')),
    logRetentionDays: Number(optional('LOG_RETENTION_DAYS', '0')),
```

And add a `required2` helper that fails fast if the secret is missing (the service cannot issue tokens without it):

```ts
/** Like `required`, but accepts the first of several candidate env names. */
function required2(names: string[]): string {
  const value = firstEnv(names, '');
  if (!value) {
    throw new Error(`Missing required environment variable (one of): ${names.join(', ')}`);
  }
  return value;
}
```

Keep `dashboardOrigin`, `adminWallets`, and everything else as-is. Remove the now-unused `THIRDWEB_SECRET_KEY` line entirely.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test --import tsx ./test/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: config auth env with backward-compatible fallbacks; drop thirdweb keys"
```

---

### Task 4: Rewrite `AuthService` without thirdweb (`src/auth-service.ts`)

Wire Tasks 1–3 into the `AuthService`. Keep the interface; rename the factory from `createThirdwebAuthService` to `createAuthService` and update its single import in `src/index.ts`.

**Files:**
- Modify: `src/auth-service.ts` (replace implementation; keep `AuthService` interface)
- Modify: `src/index.ts:6` (import + call site)
- Create: `test/auth-service.test.ts`

**Interfaces:**
- Consumes: `createLoginMessage`, `generateNonce`, `recoverSiweAddress`, `LoginPayload` (Task 1); `issueJwt`, `verifyJwt` (Task 2); `config.authDomain`, `config.jwtSecret` (Task 3).
- Produces: `createAuthService(config: Config): AuthService` (interface unchanged).

- [ ] **Step 1: Write the failing test**

Create `test/auth-service.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as Secp256k1 from 'ox/Secp256k1';
import * as PersonalMessage from 'ox/PersonalMessage';
import * as Signature from 'ox/Signature';
import * as Hex from 'ox/Hex';
import * as Address from 'ox/Address';
import { createAuthService } from '../src/auth-service.js';
import { createLoginMessage, type LoginPayload } from '../src/siwe.js';
import type { Config } from '../src/config.js';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDRESS = Address.fromPublicKey(Secp256k1.getPublicKey({ privateKey: PRIVATE_KEY }));

const config = { authDomain: 'admin.push.p2p.me', jwtSecret: 'test-secret' } as Config;

function sign(p: LoginPayload): string {
  const hash = PersonalMessage.getSignPayload(Hex.fromString(createLoginMessage(p)));
  return Signature.toHex(Secp256k1.sign({ payload: hash, privateKey: PRIVATE_KEY }));
}

describe('createAuthService', () => {
  it('generates a payload, verifies a signature, issues and re-verifies a JWT', async () => {
    const svc = createAuthService(config);
    const payload = (await svc.generatePayload(ADDRESS)) as LoginPayload;
    assert.equal(payload.domain, 'admin.push.p2p.me');
    assert.ok(payload.nonce.length > 0);

    const result = await svc.verifyAndIssueJwt(payload, sign(payload));
    assert.ok(result);
    assert.equal(result!.address, ADDRESS.toLowerCase());

    const verified = await svc.verifyJwt(result!.token);
    assert.deepEqual(verified, { address: ADDRESS.toLowerCase() });
  });

  it('rejects a payload whose domain does not match', async () => {
    const svc = createAuthService(config);
    const payload = (await svc.generatePayload(ADDRESS)) as LoginPayload;
    const bad = { ...payload, domain: 'evil.example' };
    assert.equal(await svc.verifyAndIssueJwt(bad, sign(bad)), null);
  });

  it('rejects an expired payload', async () => {
    const svc = createAuthService(config);
    const payload = (await svc.generatePayload(ADDRESS)) as LoginPayload;
    const expired = { ...payload, expiration_time: '2000-01-01T00:00:00.000Z' };
    assert.equal(await svc.verifyAndIssueJwt(expired, sign(expired)), null);
  });

  it('rejects a signature from the wrong key', async () => {
    const svc = createAuthService(config);
    const payload = (await svc.generatePayload(ADDRESS)) as LoginPayload;
    const otherKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    const hash = PersonalMessage.getSignPayload(Hex.fromString(createLoginMessage(payload)));
    const wrongSig = Signature.toHex(Secp256k1.sign({ payload: hash, privateKey: otherKey }));
    assert.equal(await svc.verifyAndIssueJwt(payload, wrongSig), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx ./test/auth-service.test.ts`
Expected: FAIL — `createAuthService` is not exported.

- [ ] **Step 3: Rewrite `src/auth-service.ts`**

Replace the whole file with (the `AuthService` interface block is unchanged from the original; the implementation is new):

```ts
import type { Config } from './config.js';
import {
  createLoginMessage,
  generateNonce,
  recoverSiweAddress,
  type LoginPayload,
} from './siwe.js';
import { issueJwt, verifyJwt } from './jwt.js';

/**
 * SIWE (EIP-4361) auth for the dashboard, with no third-party SDK. The HTTP
 * layer depends only on this interface so tests can inject a fake. `payload` is
 * passed through opaquely between client and this module.
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

const PAYLOAD_TTL_MS = 10 * 60 * 1000; // login payload valid for 10 minutes
const JWT_TTL_SECONDS = 7 * 24 * 60 * 60; // session token valid for 7 days
const DEFAULT_STATEMENT =
  'Please ensure that the domain above matches the URL of the current website.';

export function createAuthService(config: Config): AuthService {
  const { authDomain: domain, jwtSecret: secret } = config;

  return {
    async generatePayload(address) {
      const now = Date.now();
      const payload: LoginPayload = {
        address,
        domain,
        uri: domain,
        version: '1',
        statement: DEFAULT_STATEMENT,
        nonce: generateNonce(),
        issued_at: new Date(now).toISOString(),
        expiration_time: new Date(now + PAYLOAD_TTL_MS).toISOString(),
        invalid_before: new Date(now - PAYLOAD_TTL_MS).toISOString(),
      };
      return payload;
    },

    async verifyAndIssueJwt(payload, signature) {
      const p = payload as LoginPayload | null;
      if (!p || typeof p.address !== 'string') return null;

      const recovered = recoverSiweAddress(p, signature);
      if (!recovered || recovered !== p.address.toLowerCase()) return null;
      if (p.domain !== domain) return null;

      const now = Date.now();
      if (p.expiration_time && Date.parse(p.expiration_time) < now) return null;
      if (p.invalid_before && Date.parse(p.invalid_before) > now) return null;

      return { address: recovered, token: issueJwt(secret, recovered, JWT_TTL_SECONDS) };
    },

    async verifyJwt(token) {
      return verifyJwt(secret, token);
    },
  };
}
```

- [ ] **Step 4: Update `src/index.ts`**

Change the import (line 6) from:

```ts
import { createThirdwebAuthService } from './auth-service.js';
```
to:
```ts
import { createAuthService } from './auth-service.js';
```

And the call site (around line 32) from:

```ts
  const authService = createThirdwebAuthService(config);
```
to:
```ts
  const authService = createAuthService(config);
```

- [ ] **Step 5: Run the auth tests**

Run: `node --test --import tsx ./test/auth-service.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS (existing admin/api/auth tests still green via `FakeAuthService`).

- [ ] **Step 7: Commit**

```bash
git add src/auth-service.ts src/index.ts test/auth-service.test.ts
git commit -m "feat: replace thirdweb AuthService with self-contained SIWE + JWT"
```

---

### Task 5: thirdweb contract test + dependency demotion

Prove our SIWE verification matches the real thirdweb client byte-for-byte, then move `thirdweb` from `dependencies` to `devDependencies` so it never ships in the runtime image.

**Files:**
- Create: `test/auth-contract.test.ts`
- Modify: `package.json` (move `thirdweb` deps→devDeps)

**Interfaces:**
- Consumes: `recoverSiweAddress`, `createLoginMessage`, `LoginPayload` (Task 1); `createAuthService` (Task 4).
- Produces: nothing (guard test only).

- [ ] **Step 1: Write the contract test**

Create `test/auth-contract.test.ts`. It signs one of *our* payloads with thirdweb's **public** client signer and asserts our verifier accepts it:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createThirdwebClient } from 'thirdweb';
import { privateKeyToAccount } from 'thirdweb/wallets';
import { signLoginPayload } from 'thirdweb/auth';
import { recoverSiweAddress, type LoginPayload } from '../src/siwe.js';
import { createAuthService } from '../src/auth-service.js';
import type { Config } from '../src/config.js';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const client = createThirdwebClient({ secretKey: 'contract-test' });
const account = privateKeyToAccount({ client, privateKey: PRIVATE_KEY });

const config = { authDomain: 'admin.push.p2p.me', jwtSecret: 'test-secret' } as Config;

describe('thirdweb client ⇄ our verifier contract', () => {
  it('our verifier recovers the signer of a thirdweb-signed payload', async () => {
    const svc = createAuthService(config);
    const payload = (await svc.generatePayload(account.address)) as LoginPayload;

    // thirdweb's CLIENT builds the EIP-4361 message its own way and signs it.
    const { signature } = await signLoginPayload({ payload, account });

    assert.equal(recoverSiweAddress(payload, signature), account.address.toLowerCase());

    const result = await svc.verifyAndIssueJwt(payload, signature);
    assert.ok(result, 'thirdweb-signed payload must be accepted');
    assert.equal(result!.address, account.address.toLowerCase());
  });

  it('rejects a thirdweb-signed payload if the address is swapped', async () => {
    const svc = createAuthService(config);
    const payload = (await svc.generatePayload(account.address)) as LoginPayload;
    const { signature } = await signLoginPayload({ payload, account });
    const tampered = { ...payload, address: '0x0000000000000000000000000000000000000001' };
    assert.equal(await svc.verifyAndIssueJwt(tampered, signature), null);
  });
});
```

- [ ] **Step 2: Run the contract test (thirdweb still in node_modules)**

Run: `node --test --import tsx ./test/auth-contract.test.ts`
Expected: PASS. If it fails on serialization, our `createLoginMessage` diverged from thirdweb — fix `src/siwe.ts` to match before continuing. (This is the whole point of the test.)

- [ ] **Step 3: Move `thirdweb` to devDependencies**

Edit `package.json`: delete `"thirdweb": "^5.120.1"` from `dependencies` and add it to `devDependencies`. Then reconcile the lockfile:

```bash
npm install
```
Expected: `thirdweb` now under `devDependencies`; install succeeds.

- [ ] **Step 4: Verify no `src/` file imports thirdweb anymore**

Run: `grep -rn "thirdweb" src/ || echo "clean"`
Expected: `clean` (no matches). If any remain, remove them.

- [ ] **Step 5: Verify a production install excludes thirdweb**

Run: `npm ls thirdweb --omit=dev 2>&1 | head -5`
Expected: thirdweb is **not** part of the production dependency tree (empty/`(empty)` result), confirming it won't ship in the Docker runtime stage.

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add test/auth-contract.test.ts package.json package-lock.json
git commit -m "test: thirdweb wire-contract guard; demote thirdweb to devDependency"
```

---

### Task 6: Concurrency-limited push fan-out (`src/concurrency.ts` + `src/webpush.ts`)

Cap how many push sends run at once so a large fan-out can't spike CPU/RAM/open sockets.

**Files:**
- Create: `src/concurrency.ts`
- Create: `test/concurrency.test.ts`
- Modify: `src/webpush.ts` (`sendToMany`)

**Interfaces:**
- Consumes: `config.sendConcurrency` (Task 3).
- Produces: `mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]>` — results in input order; at most `limit` calls to `fn` in flight.

- [ ] **Step 1: Write the failing test**

Create `test/concurrency.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency } from '../src/concurrency.js';

describe('mapWithConcurrency', () => {
  it('preserves input order in results', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    assert.deepEqual(out, [10, 20, 30, 40, 50]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n;
    });
    assert.ok(maxInFlight <= 3, `maxInFlight was ${maxInFlight}`);
  });

  it('handles an empty list', async () => {
    assert.deepEqual(await mapWithConcurrency([], 5, async (x) => x), []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx ./test/concurrency.test.ts`
Expected: FAIL — cannot find module `../src/concurrency.js`.

- [ ] **Step 3: Write `src/concurrency.ts`**

```ts
/**
 * Map `items` through `fn` with at most `limit` calls in flight at once.
 * Results are returned in input order. A fixed pool of workers pulls from a
 * shared cursor, so memory and socket pressure stay bounded regardless of how
 * many items there are.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  };

  const poolSize = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx ./test/concurrency.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into `src/webpush.ts`**

In `sendToMany`, replace:

```ts
    const results = await Promise.all(
      subs.map((sub) => this.sendToOne(sub, payload, options)),
    );
```
with:
```ts
    const results = await mapWithConcurrency(
      subs,
      this.config.sendConcurrency,
      (sub) => this.sendToOne(sub, payload, options),
    );
```

Add the import at the top of `src/webpush.ts`:

```ts
import { mapWithConcurrency } from './concurrency.js';
```

(`this.config` is already a constructor field; `sendConcurrency` was added to `Config` in Task 3.)

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS (existing webpush/api tests still green; the summary shape is unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/concurrency.ts test/concurrency.test.ts src/webpush.ts
git commit -m "perf: bound push fan-out concurrency to flatten CPU/RAM spikes"
```

---

### Task 7: Low-RAM SQLite pragmas (`src/db.ts`)

Cap SQLite's memory use and keep the WAL bounded.

**Files:**
- Modify: `src/db.ts`
- Create: `test/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no API change; `openDatabase` applies additional pragmas.

- [ ] **Step 1: Write the failing test**

Create `test/db.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';

describe('openDatabase pragmas', () => {
  it('applies low-memory pragmas', () => {
    const db = openDatabase(':memory:');
    assert.equal(db.pragma('mmap_size', { simple: true }), 0);
    // negative cache_size = KiB of memory; we set a small bounded cache.
    assert.ok((db.pragma('cache_size', { simple: true }) as number) < 0);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx ./test/db.test.ts`
Expected: FAIL — `mmap_size` is not 0 (default is non-zero) / `cache_size` assertion fails.

- [ ] **Step 3: Edit `src/db.ts`**

In `openDatabase`, after the existing pragmas, add:

```ts
  db.pragma('cache_size = -2000');     // ~2 MiB page cache (negative = KiB)
  db.pragma('mmap_size = 0');          // don't memory-map the DB into RSS
  db.pragma('wal_autocheckpoint = 256'); // checkpoint ~1 MiB of WAL
```

So the block reads:

```ts
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -2000');
  db.pragma('mmap_size = 0');
  db.pragma('wal_autocheckpoint = 256');
  migrate(db);
  return db;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx ./test/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts test/db.test.ts
git commit -m "perf: low-RAM SQLite pragmas (bounded cache, no mmap, WAL checkpoint)"
```

---

### Task 8: Optional notification-log retention

Bound `notification_logs` growth so the DB (and its page cache) stays small over time. Off by default (`LOG_RETENTION_DAYS=0`).

**Files:**
- Modify: `src/repository.ts` (add `pruneOldLogs`)
- Modify: `src/index.ts` (schedule pruning when configured)
- Modify: `test/repository.test.ts` (test `pruneOldLogs`)

**Interfaces:**
- Consumes: `config.logRetentionDays` (Task 3).
- Produces: `Repository.pruneOldLogs(days: number): number` — rows deleted (0 when `days <= 0`).

- [ ] **Step 1: Read the existing repository test setup**

Run: `sed -n '1,40p' test/repository.test.ts`
Expected: see how it constructs a `Repository` over an in-memory DB and inserts logs (reuse this helper style).

- [ ] **Step 2: Write the failing test**

Add to `test/repository.test.ts` (reusing its existing in-memory `openDatabase(':memory:')` + `new Repository(db)` setup):

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { Repository } from '../src/repository.js';

describe('pruneOldLogs', () => {
  it('deletes only rows older than the retention window', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    // One old row (40 days ago) and one fresh row.
    db.prepare(
      `INSERT INTO notification_logs (app_id, endpoint, status, created_at)
       VALUES ('a', 'e1', 'sent', datetime('now', '-40 days'))`,
    ).run();
    db.prepare(
      `INSERT INTO notification_logs (app_id, endpoint, status, created_at)
       VALUES ('a', 'e2', 'sent', datetime('now'))`,
    ).run();

    const deleted = repo.pruneOldLogs(30);
    assert.equal(deleted, 1);
    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM notification_logs')
      .get() as { n: number };
    assert.equal(remaining.n, 1);
    db.close();
  });

  it('is a no-op when days <= 0', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    assert.equal(repo.pruneOldLogs(0), 0);
    db.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test --import tsx ./test/repository.test.ts`
Expected: FAIL — `repo.pruneOldLogs` is not a function.

- [ ] **Step 4: Add `pruneOldLogs` to `src/repository.ts`**

In the `Repository` class, after `recentLogs`, add:

```ts
  /** Delete logs older than `days`. No-op (returns 0) when days <= 0. */
  pruneOldLogs(days: number): number {
    if (days <= 0) return 0;
    return this.db
      .prepare(`DELETE FROM notification_logs WHERE created_at < datetime('now', ?)`)
      .run(`-${days} days`).changes;
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test --import tsx ./test/repository.test.ts`
Expected: PASS.

- [ ] **Step 6: Schedule pruning in `src/index.ts`**

In `main()`, after `seedFromEnv(...)` and before `app.listen(...)`, add:

```ts
  if (config.logRetentionDays > 0) {
    const prune = () => repo.pruneOldLogs(config.logRetentionDays);
    prune(); // prune once at startup
    const HOUR = 60 * 60 * 1000;
    const timer = setInterval(prune, HOUR);
    timer.unref(); // don't keep the event loop alive for the timer alone
  }
```

- [ ] **Step 7: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/repository.ts src/index.ts test/repository.test.ts
git commit -m "perf: optional notification-log retention (LOG_RETENTION_DAYS)"
```

---

### Task 9: Slimmer Docker runtime + docs

Cap the V8 heap, use `npm ci`, and document the new env vars and the thirdweb removal.

**Files:**
- Modify: `Dockerfile`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (build/config/docs only).

- [ ] **Step 1: Edit the runtime stage of `Dockerfile`**

In the `runtime` stage, after `ENV NODE_ENV=production`, add a heap cap:

```dockerfile
# Cap the V8 heap so RSS stays small on a low-traffic service; tune per host.
ENV NODE_OPTIONS="--max-old-space-size=128 --max-semi-space-size=2"
```

Change both `RUN npm install` lines to `npm ci`:
- Build stage: `RUN npm ci`
- Runtime stage: `RUN npm ci --omit=dev && npm cache clean --force`

(`npm ci` is lockfile-exact and faster; the lockfile is already copied in before it.)

- [ ] **Step 2: Verify the image builds and starts**

Run:
```bash
docker build -t push-light . && \
docker run --rm -e VAPID_PUBLIC_KEY=p -e VAPID_PRIVATE_KEY=q -e ADMIN_API_KEY=a \
  -e AUTH_DOMAIN=localhost -e AUTH_JWT_SECRET=s -e DATABASE_PATH=:memory: \
  -p 4000:4000 -d --name push-light push-light && sleep 2 && \
curl -fsS http://localhost:4000/health && echo && docker rm -f push-light
```
Expected: build succeeds; `curl` prints `{"status":"ok"}`.

If `DATABASE_PATH=:memory:` is rejected by the volume mount, omit it and let it use the default path inside the container.

- [ ] **Step 3: Update `.env.example`**

- Replace `THIRDWEB_SECRET_KEY=...` and `THIRDWEB_AUTH_PRIVATE_KEY=...` / `THIRDWEB_AUTH_DOMAIN=...` entries with:

```bash
# SIWE / admin-dashboard auth (no third-party SDK)
AUTH_DOMAIN=admin.push.p2p.me          # was THIRDWEB_AUTH_DOMAIN (still accepted)
AUTH_JWT_SECRET=<32+ random bytes>     # was THIRDWEB_AUTH_PRIVATE_KEY (still accepted)

# Runtime tuning (optional)
SEND_CONCURRENCY=25                    # max push sends in flight at once
LOG_RETENTION_DAYS=0                   # 0 = keep delivery logs forever
```

Keep a one-line note that the old `THIRDWEB_*` names still work as fallbacks, and that `THIRDWEB_SECRET_KEY` is no longer used.

- [ ] **Step 4: Update `README.md`**

- In the dependency/architecture prose, state that the server has **no thirdweb runtime dependency** — SIWE signatures are verified with `ox` (secp256k1) and sessions use an HS256 JWT (`node:crypto`); `thirdweb` remains only as a dev-time contract-test dependency.
- Document `AUTH_DOMAIN`, `AUTH_JWT_SECRET`, `SEND_CONCURRENCY`, `LOG_RETENTION_DAYS` and the `NODE_OPTIONS` heap cap in the config section.

- [ ] **Step 5: Final full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all PASS; `dist/` is produced.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .env.example README.md
git commit -m "perf: V8 heap cap + npm ci in Docker; document lightweight auth env"
```

---

## Self-Review

**Spec coverage:**
- Part 1 (remove thirdweb): Tasks 1 (SIWE), 2 (JWT), 3 (config), 4 (AuthService rewrite + index wiring), 5 (contract test + dep demotion). ✓
- Wire-compatibility safety net: Task 5 contract test. ✓
- Env changes with fallback: Task 3 + Task 9 docs. ✓
- Part 2.1 concurrency: Task 6. ✓
- Part 2.2 SQLite pragmas: Task 7. ✓
- Part 2.3 log retention: Task 8. ✓
- Part 2.4 V8 heap cap: Task 9. ✓
- Part 2.5 slimmer Docker / npm ci: Task 9. ✓
- Success criteria (prod node_modules ≲50 MB, login round-trip, tests, smaller image): verified by Task 5 step 5 (`npm ls --omit=dev`), Task 5 contract test, full-suite runs, and Task 9 docker build. ✓
- Explicitly-not-done (express, schema, prepared-statement caching): respected — no task touches them. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `LoginPayload`, `createLoginMessage`, `recoverSiweAddress`, `generateNonce` (Task 1) used identically in Tasks 4–5. `issueJwt(secret, sub, ttl)` / `verifyJwt(secret, token)` (Task 2) used in Task 4. `config.authDomain` / `config.jwtSecret` / `config.sendConcurrency` / `config.logRetentionDays` (Task 3) used in Tasks 4, 6, 8. `mapWithConcurrency(items, limit, fn)` (Task 6) signature matches its call in `webpush.ts`. `createAuthService` (Task 4) replaces `createThirdwebAuthService` consistently in `index.ts`. ✓

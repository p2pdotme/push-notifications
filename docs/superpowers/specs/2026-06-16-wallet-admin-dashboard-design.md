# Wallet-authenticated admin dashboard — design

**Date:** 2026-06-16
**Status:** Approved (brainstorming) — pending implementation plan
**Topic:** thirdweb login + admin dashboard for dynamic API-key / CORS / admin management

## Summary

Add a wallet-authenticated admin dashboard to the self-hosted push service. Admins
log in with a thirdweb **in-app wallet** (Google/email social login), are gated by a
wallet **whitelist**, and manage **apps, API keys, per-app CORS origins, and the admin
list** from a browser UI. This moves configuration that is currently static and
env-based (`APP_KEYS`, `CORS_ORIGINS`) into the **database** as the source of truth,
managed live without a restart.

This is the first frontend in the repository. It is a **separate** Vite + React app
that talks to the existing Express API over CORS.

## Goals

- Wallet login via thirdweb in-app wallet (social/email only — no external wallets).
- A whitelisted set of admin wallets, bootstrapped from env and extended in the DB.
- Dashboard CRUD for: apps, API keys (issue / revoke, hashed at rest), per-app CORS
  origins, and admin wallets.
- API keys and CORS become DB-backed and live; env is used only to bootstrap.
- Preserve the existing data-plane behavior (server-to-server `x-api-key` sends).

## Non-goals (YAGNI for this iteration)

- Observability views (subscription stats, delivery-log viewer) and dashboard
  "send test notification". Explicitly out of scope this round.
- External wallet login (MetaMask / WalletConnect).
- Account-abstraction / smart-account wrapping of the in-app wallet — the embedded
  wallet must remain a plain EOA so its address is stable (whitelistable) and can
  sign the SIWE payload.
- Multi-instance / Postgres migration (SQLite remains the store).

## Decisions (from brainstorming)

| Decision | Choice |
| --- | --- |
| Config model | **Full DB migration**; env imported once on first boot, DB is source of truth thereafter. |
| Frontend | **Separate** Vite + React app (`dashboard/`), talks to API over CORS. |
| Login methods | **In-app wallet only** (thirdweb social/email). |
| Admin whitelist | **Env bootstrap + DB-managed.** |
| CORS scope | **Per-app** allowed origins. |
| Dashboard scope | Apps & API keys, CORS management, admin-wallet management. |
| Session transport | **Bearer JWT** in dashboard localStorage (separate origin; no cross-site cookies). |

## Architecture: two auth planes

The service keeps its existing **data plane** and gains a new **admin plane**.

```
 thirdweb in-app wallet (Google/email)            server-to-server callers
        | SIWE sign-in                                    | x-api-key
        v                                                 v
  dashboard (separate Vite+React) --Bearer JWT--> /auth/*, /admin/*     /notifications, /subscriptions
                                                       |                        |
                                                       v                        v
                                                admin whitelist          api_keys (hashed) lookup
                                                       \___ SQLite: apps, api_keys, cors_origins, admins ___/
```

- **Data plane** keeps current behavior. API keys now resolve from the DB by hash
  instead of env `APP_KEYS`; the env `ADMIN_API_KEY` master key continues to work.
- **Admin plane** is new: thirdweb SIWE login -> JWT -> every `/admin/*` request is
  gated by the admin whitelist.

## thirdweb auth flow

thirdweb v5 SDK. Backend uses `createAuth` from `thirdweb/auth`; frontend uses the
React `ConnectButton` with an `auth` config and `inAppWallet`.

**Backend setup**

```ts
import { createThirdwebClient } from 'thirdweb';
import { createAuth } from 'thirdweb/auth';
import { privateKeyToAccount } from 'thirdweb/wallets';

const client = createThirdwebClient({ secretKey: THIRDWEB_SECRET_KEY });
const auth = createAuth({
  domain: THIRDWEB_AUTH_DOMAIN,          // e.g. push.p2p.me
  client,
  adminAccount: privateKeyToAccount({ client, privateKey: THIRDWEB_AUTH_PRIVATE_KEY }),
});
```

The private key is used only to sign JWTs and needs no funds.

**Endpoints (public, consumed by the dashboard)**

- `GET /auth/payload?address=0x...` -> `auth.generatePayload({ address })`.
- `POST /auth/login { payload, signature }`
  -> `auth.verifyPayload(...)` -> check whitelist -> `auth.generateJWT(...)`.
  Returns `{ token, address, isAdmin }`. If the address is **not** whitelisted,
  responds `403` **including the address**, so the UI can show
  "your address is 0x…, not yet authorized" — this resolves the bootstrap
  chicken-and-egg (a new admin logs in once to discover their embedded-wallet
  address, then it is added to `ADMIN_WALLETS`).
- `GET /auth/me` (Bearer) -> `auth.verifyJWT(...)` -> `{ address, isAdmin }`.

**Frontend**

```ts
const wallet = inAppWallet({ auth: { options: ['google', 'email' /* , ... */] } });
// ConnectButton auth config:
//   getLoginPayload -> GET /auth/payload
//   doLogin(params) -> POST /auth/login, store returned JWT in localStorage
//   isLoggedIn      -> GET /auth/me with Bearer
//   doLogout        -> clear localStorage
```

**Testability:** thirdweb verification is wrapped behind a small `AuthService`
interface (`generatePayload`, `verifyPayloadAndIssueJwt`, `verifyJwt`). The Express
layer depends on the interface, so the test suite injects a fake and never hits the
network. This matches the repo's existing dependency-injection style (config + repo +
sender passed into `createServer`).

## Data model

New tables alongside the existing `subscriptions` and `notification_logs`.

```sql
CREATE TABLE IF NOT EXISTS apps (
  app_id     TEXT PRIMARY KEY,                 -- slug, e.g. "user-app"
  name       TEXT    NOT NULL,
  disabled   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id       TEXT    NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  key_hash     TEXT    NOT NULL UNIQUE,         -- sha256(secret), hex
  key_prefix   TEXT    NOT NULL,                -- e.g. "pk_ab12cd" for display
  label        TEXT,
  created_by   TEXT,                            -- admin wallet address
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_app ON api_keys(app_id);

CREATE TABLE IF NOT EXISTS cors_origins (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id     TEXT    NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  origin     TEXT    NOT NULL,                  -- e.g. https://app.p2p.me
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(app_id, origin)
);

CREATE TABLE IF NOT EXISTS admins (
  address    TEXT PRIMARY KEY,                  -- lowercased 0x address
  label      TEXT,
  added_by   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**API-key handling.** On creation the server generates a random secret (e.g.
`pk_<base62>`), stores `sha256(secret)` + a short display prefix, and returns the
full secret **once**. The data-plane auth middleware hashes the incoming `x-api-key`
and looks it up by `key_hash` (ignoring revoked rows), updating `last_used_at`. The
env `ADMIN_API_KEY` master key remains a constant-time compare.

**Whitelist resolution.** `isAdmin(address)` is true when the lowercased address is
in env `ADMIN_WALLETS` (bootstrap super-admins) **or** the `admins` table.

## Migration-on-boot (one-time seed)

When `apps` is empty at startup:
- For each entry in env `APP_KEYS`, create an `apps` row and an `api_keys` row
  (hashing the existing key so current callers keep working).
- Attach each env `CORS_ORIGINS` entry to every seeded app (best-effort mapping from
  the old global list to the new per-app model; admins refine later).

After seeding, the DB is authoritative; `APP_KEYS` / `CORS_ORIGINS` become optional.

## Admin API (Bearer JWT, `requireAdmin` on every route)

| Method & path | Description |
| --- | --- |
| `GET /admin/apps` | List apps. |
| `POST /admin/apps` | Create app `{ appId, name }`. |
| `PATCH /admin/apps/:appId` | Update `{ name?, disabled? }`. |
| `DELETE /admin/apps/:appId` | Delete app (cascades keys + origins). |
| `GET /admin/apps/:appId/keys` | List keys (prefixes + metadata, never the secret). |
| `POST /admin/apps/:appId/keys` | Issue key `{ label? }` -> returns full secret **once**. |
| `DELETE /admin/keys/:id` | Revoke a key (sets `revoked_at`). |
| `GET /admin/apps/:appId/origins` | List allowed origins. |
| `POST /admin/apps/:appId/origins` | Add origin `{ origin }`. |
| `DELETE /admin/origins/:id` | Remove origin. |
| `GET /admin/admins` | List DB-managed admins (env bootstrap shown read-only). |
| `POST /admin/admins` | Add admin `{ address, label? }`. |
| `DELETE /admin/admins/:address` | Remove a DB-managed admin (env entries not removable). |

## CORS (per-app, DB-driven)

Two CORS concerns:

1. **Browser data endpoints** (`POST/DELETE /subscriptions`, `GET /vapid-public-key`):
   the middleware reflects an `Origin` when it is registered for **any** app — this is
   required because a CORS preflight (`OPTIONS`) carries no body and the app cannot be
   known yet. The `POST /subscriptions` handler then **enforces** that the request
   `Origin` is registered for the specific `body.appId`, returning `403` otherwise.
   This gives true per-app scoping while remaining compatible with how preflight works.

2. **Admin plane** (`/auth/*`, `/admin/*`): a dedicated CORS config allows exactly the
   `DASHBOARD_ORIGIN` env value and the `Authorization` header (Bearer transport).

Allowed-origin lookups are read frequently; they are served from the DB (optionally
cached in-memory with invalidation on origin writes — an implementation detail).

## Configuration changes

**New backend env**

| Variable | Purpose |
| --- | --- |
| `THIRDWEB_SECRET_KEY` | Backend thirdweb client secret. |
| `THIRDWEB_AUTH_PRIVATE_KEY` | JWT signing key (no funds needed). |
| `THIRDWEB_AUTH_DOMAIN` | SIWE domain, e.g. `push.p2p.me`. |
| `ADMIN_WALLETS` | Comma-separated bootstrap admin addresses. |
| `DASHBOARD_ORIGIN` | Origin of the dashboard app, for admin-plane CORS. |

**New frontend env** (`dashboard/.env`)

| Variable | Purpose |
| --- | --- |
| `VITE_THIRDWEB_CLIENT_ID` | thirdweb client id for the React SDK. |
| `VITE_API_BASE_URL` | Base URL of the push API. |

**Kept:** `VAPID_*`, `ADMIN_API_KEY`, `DATABASE_PATH`, `MAX_FAILURES`.
**Now optional (import-only):** `APP_KEYS`, `CORS_ORIGINS`.

## Frontend (`dashboard/`)

- Vite + React + thirdweb React SDK, `ThirdwebProvider`, `ConnectButton` with the
  `auth` config and `inAppWallet({ auth: { options: [...] } })`.
- Routes: **Login** (connect + "not authorized" bootstrap hint), **Apps** (list /
  create), **App detail** (keys: issue/reveal-once/revoke; origins: add/remove),
  **Admins** (list / add / remove).
- A small API client attaches the Bearer token and handles `401`/`403` by returning
  to the login state.
- Styling is intentionally minimal/clean; polish is deferred and not part of this
  spec's acceptance.

## Component boundaries

- `AuthService` (new) — wraps thirdweb `createAuth`; the only module that imports
  thirdweb on the backend. Interface: `generatePayload`, `verifyPayloadAndIssueJwt`,
  `verifyJwt`. Mockable.
- `Repository` (extended) — gains app / api_key / cors_origin / admin data access.
  All SQL stays here.
- `auth.ts` (extended) — `requireApiKey` now does a hashed DB lookup (plus env master
  key); new `requireAdmin` middleware verifies the Bearer JWT and checks the whitelist.
- Route modules — `routes/auth.ts` and `routes/admin.ts` added; `routes/subscriptions.ts`
  gains per-app origin enforcement.
- `server.ts` — wires the new routers and the admin-plane CORS config.
- `dashboard/` — standalone frontend, no shared build with the backend.

## Error handling

- Reuse the existing centralized error middleware (`ZodError -> 400`,
  `HttpError -> status`, else `500`).
- Auth failures: missing/invalid Bearer -> `401`; valid JWT but non-admin -> `403`.
- Login of a non-whitelisted address -> `403` with `{ address }` for the bootstrap hint.
- Zod validation on all new request bodies (appId slug format, origin URL, address
  format).

## Testing

Extend the `node:test` suite (in-memory SQLite, injected fake `AuthService`):

- API-key hashing: issue -> hash stored, secret returned once; data-plane lookup by
  hash succeeds; revoked keys rejected; env master key still works.
- Admin CRUD: apps / keys / origins / admins happy paths + validation errors.
- `requireAdmin`: no token -> 401; non-admin token -> 403; admin token -> 200.
- Whitelist resolution across env bootstrap + DB.
- Per-app CORS enforcement: subscribe with a registered vs unregistered origin for the
  given appId.
- Migration-on-boot seed from env `APP_KEYS` / `CORS_ORIGINS`.

Frontend gets a manual smoke test (login, issue key, add origin, add admin); automated
frontend tests are out of scope this round.

## Open implementation details (decided during planning, not blocking)

- Exact API-key string format and prefix length.
- Whether to add an in-memory origin cache or hit the DB per request initially
  (start simple: DB per request, optimize only if needed).
- thirdweb social provider list to enable (at least Google + email).

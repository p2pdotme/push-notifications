# @p2pdotme/push-notifications

Lightweight, **self-hosted** push notification service for the p2p.me
organization. Built on the open **Web Push** standards — no Firebase, no
OneSignal, no third-party vendor, no lock-in. One small service that every
p2p.me app (user-app, merchant-app, coinsme-app, widgets, …) can share.

## How it works (no Firebase)

It implements the W3C/IETF web push stack directly:

- **Web Push Protocol** (RFC 8030) — the server posts encrypted messages to
  each browser's own push service (Google's FCM endpoint for Chrome, Mozilla
  autopush for Firefox, Apple for Safari/iOS PWAs). These endpoints are part of
  the browser and free to use; you are **not** using the Firebase SDK or an FCM
  project.
- **VAPID** (RFC 8292) — an ECDSA P-256 key pair identifies our application
  server to those push services via a signed JWT. Generated once, kept secret.
- **Message Encryption** (RFC 8291) — payloads are encrypted end-to-end with
  ECDH + AES-128-GCM, so push services relay ciphertext they cannot read.

The heavy crypto is handled by the battle-tested [`web-push`](https://github.com/web-push-libs/web-push)
library. Subscriptions and a delivery audit log live in **PostgreSQL** — managed
on Railway or any Postgres host; docker-compose bundles one locally.

The server has **no thirdweb runtime dependency**. SIWE signatures are verified
with [`ox`](https://github.com/wevm/ox) (secp256k1), and admin sessions use an
HS256 JWT signed entirely by `node:crypto`. The `thirdweb` package remains only
as a dev-time contract-test dependency.

```
 ┌────────────┐  subscribe   ┌──────────────────┐  encrypted   ┌──────────────┐
 │  Browser   │ ───────────► │  push service    │ ───────────► │   Browser    │
 │ (SW + SDK) │              │ (this service)   │  Web Push    │ Service Worker│
 └────────────┘              └──────────────────┘              └──────────────┘
        ▲   stores subscription │  send (x-api-key)   ▲
        │                       ▼                      │
        │                 ┌──────────┐         ┌───────────────┐
        └─────────────────│ Postgres │         │ p2p.me backend│
                          └──────────┘         └───────────────┘
```

## Repository layout

| Path                | What it is                                              |
| ------------------- | ------------------------------------------------------- |
| `src/`              | The push service (Node + Express + TypeScript)          |
| `client/`           | `@p2pdotme/push-client` — framework-agnostic browser SDK |
| `client/service-worker.js` | Drop-in service worker for receiving notifications |
| `scripts/generate-vapid.ts` | One-off VAPID key generator                     |
| `examples/`         | Backend send script + React hook                        |

## Quick start

```bash
npm install

# 1. Generate VAPID keys (once) and copy them into your env.
npm run generate-vapid

# 2. Configure
cp .env.example .env   # fill in the generated keys + API keys

# 3. Run
npm run dev            # watch mode
# or
npm run build && npm start
```

Or with Docker (includes a bundled `postgres` service — no separate DB needed):

```bash
# .env must contain VAPID_*, ADMIN_API_KEY, APP_KEYS, AUTH_JWT_SECRET
docker compose up --build
```

For a full production walkthrough — configuration, persistence, backups,
updates, TLS, and troubleshooting — see
[`docs/docker-deployment.md`](./docs/docker-deployment.md).

## Configuration

See [`.env.example`](./.env.example). Key variables:

| Variable              | Purpose                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| `VAPID_PUBLIC_KEY`    | Shared with browsers; identifies the app server.                               |
| `VAPID_PRIVATE_KEY`   | **Secret.** Signs push requests.                                               |
| `VAPID_SUBJECT`       | `mailto:` or `https:` contact, required by push services.                     |
| `ADMIN_API_KEY`       | Master key — may send to / manage any app.                                    |
| `APP_KEYS`            | Optional JSON `{ "<appId>": "<secret>" }`. Imported into the DB on first boot. |
| `DATABASE_URL`        | PostgreSQL connection string (Railway: `${{Postgres.DATABASE_URL}}`).          |
| `CORS_ORIGINS`        | Optional. Imported into the DB on first boot; DB is source of truth after.    |
| `AUTH_DOMAIN`         | SIWE domain shown to wallets (e.g. `push.p2p.me`). Replaces `THIRDWEB_AUTH_DOMAIN` (still accepted as fallback). |
| `AUTH_JWT_SECRET`     | **Secret.** 32+ random bytes used to sign HS256 admin session JWTs. Replaces `THIRDWEB_AUTH_PRIVATE_KEY` (still accepted as fallback). |
| `ADMIN_WALLETS`       | Comma-separated bootstrap admin wallet addresses.                              |
| `DASHBOARD_ORIGIN`    | Origin of the dashboard SPA, allowed on `/auth` + `/admin`.                   |
| `SEND_CONCURRENCY`    | Max push sends in flight at once (default: `25`).                              |
| `LOG_RETENTION_DAYS`  | Delete delivery logs older than N days (`0` = keep forever, default).          |
| `NODE_OPTIONS`        | Set in the Docker runtime stage to cap V8 heap: `--max-old-space-size=128 --max-semi-space-size=2`. Override for larger hosts. |

Each org app gets its own `appId` + key, so `merchant-app` can never push to
`user-app` subscribers. The admin key is for internal tooling / cross-app sends.

## Admin dashboard

A separate wallet-authenticated dashboard (`dashboard/`) manages apps, API keys,
and per-app CORS origins live in the database — replacing static `APP_KEYS` /
`CORS_ORIGINS` env config (those are imported once on first boot).

- **Login:** thirdweb in-app wallet (Google / email) on the frontend; the server
  verifies SIWE signatures with `ox` (no thirdweb SDK at runtime) and issues
  HS256 JWTs via `node:crypto`. Admins are whitelisted by wallet address via
  `ADMIN_WALLETS` (bootstrap) plus dashboard-managed admins.
- **First admin:** log in once to discover your embedded-wallet address (the UI
  shows it when not yet authorized), add it to `ADMIN_WALLETS`, then restart.
- **API keys** are shown in full exactly once at creation and stored hashed.

Run the dashboard:

```bash
cd dashboard
npm install
cp .env.example .env   # set VITE_THIRDWEB_CLIENT_ID + VITE_API_BASE_URL
npm run dev
```

## HTTP API

### Public (browser-facing, no API key)

| Method & path           | Description                                  |
| ----------------------- | -------------------------------------------- |
| `GET /health`           | Liveness probe.                              |
| `GET /vapid-public-key` | Returns `{ publicKey }` for client subscribe. |
| `POST /subscriptions`   | Register/refresh a subscription.             |
| `DELETE /subscriptions` | Remove a subscription by `endpoint`.         |

`POST /subscriptions` body:

```json
{
  "appId": "user-app",
  "userId": "alice",
  "subscription": { "endpoint": "https://...", "keys": { "p256dh": "...", "auth": "..." } }
}
```

### Authenticated (server-to-server, `x-api-key` header required)

| Method & path                     | Description                                 |
| --------------------------------- | ------------------------------------------- |
| `POST /notifications/send`        | Send to a user, list of users, or broadcast.|
| `GET /notifications/logs/:appId`  | Recent delivery log (`?limit=`).            |
| `GET /subscriptions/stats/:appId` | Subscription counts.                        |

`POST /notifications/send` body:

```json
{
  "appId": "user-app",
  "userId": "alice",            // or "userIds": [...] or "broadcast": true
  "notification": {
    "title": "Payment received",
    "body": "You received 25 USDC.",
    "url": "https://app.p2p.me/transactions",
    "icon": "/icons/icon-192.png",
    "data": { "txId": "0xabc123" }
  },
  "urgency": "high",            // optional: very-low|low|normal|high
  "ttl": 86400                  // optional seconds
}
```

Response summarizes per-endpoint results; dead subscriptions (HTTP 404/410 from
the push service) are pruned automatically.

## Frontend integration

Install the client SDK and copy the service worker to your app's web root
(e.g. `public/push-sw.js`).

```ts
import { PushClient } from '@p2pdotme/push-client';

const push = new PushClient({
  serverUrl: 'https://push.p2p.me',
  appId: 'user-app',
  serviceWorkerUrl: '/push-sw.js',
});

// On a user gesture (e.g. "Enable notifications" button):
await push.subscribe(currentUser.id);

// Later:
await push.unsubscribe();
```

See [`examples/react-usage.tsx`](./examples/react-usage.tsx) for a React hook
and [`examples/send.mjs`](./examples/send.mjs) for a backend sender.

## Notes & limits

- **iOS**: web push works only for PWAs added to the Home Screen (iOS 16.4+).
- **VAPID keys are forever**: rotating them invalidates every existing
  subscription, so store them durably.
- The subscribe endpoint isn't behind an API key (browsers can't keep secrets);
  protect it with CORS + a rate limiter / WAF at your edge in production.
- Postgres backs the store, so the service scales to multiple replicas and gets
  managed backups on Railway.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test integration suite (in-memory DB)
npm run build
```

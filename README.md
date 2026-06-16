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
library. Subscriptions and a delivery audit log live in a local **SQLite** file
— genuinely self-contained, nothing else to run.

```
 ┌────────────┐  subscribe   ┌──────────────────┐  encrypted   ┌──────────────┐
 │  Browser   │ ───────────► │  push service    │ ───────────► │   Browser    │
 │ (SW + SDK) │              │ (this service)   │  Web Push    │ Service Worker│
 └────────────┘              └──────────────────┘              └──────────────┘
        ▲   stores subscription │  send (x-api-key)   ▲
        │                       ▼                      │
        │                 ┌──────────┐         ┌───────────────┐
        └─────────────────│  SQLite  │         │ p2p.me backend│
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

Or with Docker:

```bash
# .env must contain VAPID_*, ADMIN_API_KEY, APP_KEYS
docker compose up --build
```

## Configuration

See [`.env.example`](./.env.example). Key variables:

| Variable            | Purpose                                                            |
| ------------------- | ----------------------------------------------------------------- |
| `VAPID_PUBLIC_KEY`  | Shared with browsers; identifies the app server.                  |
| `VAPID_PRIVATE_KEY` | **Secret.** Signs push requests.                                  |
| `VAPID_SUBJECT`     | `mailto:` or `https:` contact, required by push services.         |
| `ADMIN_API_KEY`     | Master key — may send to / manage any app.                        |
| `APP_KEYS`          | JSON `{ "<appId>": "<secret>" }` — per-app keys, scoped to that app. |
| `DATABASE_PATH`     | SQLite file location.                                             |
| `CORS_ORIGINS`      | Comma-separated allowed origins for browser endpoints.            |

Each org app gets its own `appId` + key, so `merchant-app` can never push to
`user-app` subscribers. The admin key is for internal tooling / cross-app sends.

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
- SQLite suits a single instance comfortably. For multi-instance HA, put the
  repository layer behind Postgres — the data-access code is isolated in
  `src/repository.ts`.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test integration suite (in-memory DB)
npm run build
```

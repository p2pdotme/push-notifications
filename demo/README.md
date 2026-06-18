# Push demo PWA

A tiny Progressive Web App that exercises the full web-push flow against the
**central push service** (`push.lmao.cl`): **subscribe in the browser → trigger
a notification → receive it**.

This is a *client* of the push service — it does not run its own push backend or
database. The browser subscribes **directly** against the push service
(`CONFIG.pushBase`); the push service manages apps, keys and the allowed-origins
list (administered from the dashboard). Only the notification trigger goes
through this app's own small backend, which holds the app key.

It is intentionally framework-free. `public/app.js` replicates the
`@p2pdotme/push-client` subscribe flow inline (register the service worker,
fetch the VAPID public key, `pushManager.subscribe`, `POST /subscriptions`), so
the app needs no build step. It reads `pushBase` + `appId` from `/config.json`,
served by `server.mjs` from its environment.

> The push service must allow this app's origin (`https://demo.lmao.cl`) for the
> app id — add it under the app's CORS origins in the dashboard.

## Pieces

| Path | What it is |
| ---- | ---------- |
| `public/index.html` | UI: enable button, title/body inputs, send + broadcast |
| `public/app.js` | Subscribe flow + `fetch` to the trigger API |
| `public/push-sw.js` | Service worker (copy of `client/service-worker.js`) |
| `public/manifest.webmanifest` + `public/icon.svg` | PWA install metadata |
| `server.mjs` | Express server: serves `public/` and proxies the trigger to the push service with the app key (kept server-side) |

## Endpoints (served by `server.mjs`)

- `POST /api/trigger { userId, title, body }` → sends to one device.
- `POST /api/broadcast { title, body }` → sends to every subscriber.

Both forward to `${PUSH_URL}/notifications/send` with the `x-api-key` header.

## Run locally

```bash
cd demo
npm install
PUSH_URL=https://push.lmao.cl \
PUSH_PUBLIC_URL=https://push.lmao.cl \
PUSH_API_KEY=<demo-app key> \
npm start
# open http://localhost:3000
```

Subscribing from `http://localhost:3000` requires that origin to be allowed for
`demo-app` in the push service too (add `http://localhost:3000` under the app's
CORS origins for local testing).

## Environment

| Var | Default | Notes |
| --- | ------- | ----- |
| `PORT` | `3000` | HTTP port |
| `PUSH_URL` | `https://push.lmao.cl` | Push service base URL (server-to-server, for the trigger) |
| `PUSH_PUBLIC_URL` | = `PUSH_URL` | Push service URL the browser subscribes against (`/config.json`) |
| `PUSH_APP_ID` | `demo-app` | App id the demo sends as |
| `PUSH_API_KEY` | — | **Required.** App key for `PUSH_APP_ID` |

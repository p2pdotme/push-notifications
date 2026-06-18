# Push demo PWA

A tiny, self-contained Progressive Web App that exercises the full web-push
flow against the push service: **subscribe in the browser → trigger a
notification → receive it**.

It is intentionally framework-free. `public/app.js` replicates the
`@p2pdotme/push-client` subscribe flow inline (register the service worker,
fetch the VAPID public key, `pushManager.subscribe`, `POST /subscriptions`), so
the app needs no build step.

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
PUSH_URL=http://localhost:4000 PUSH_API_KEY=<demo-app key> npm start
# open http://localhost:3000
```

`/vapid-public-key` and `/subscriptions` must reach the push backend on the same
origin — in production a reverse proxy (Caddy) routes those to the push service
and everything else to this server. See the deploy compose for the wiring.

## Environment

| Var | Default | Notes |
| --- | ------- | ----- |
| `PORT` | `3000` | HTTP port |
| `PUSH_URL` | `http://push:4000` | Push service base URL |
| `PUSH_APP_ID` | `demo-app` | App id the demo sends as |
| `PUSH_API_KEY` | — | **Required.** App key for `PUSH_APP_ID` |

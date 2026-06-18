# Push demo PWA — design

**Date:** 2026-06-17
**Status:** approved

## Goal

A simple, self-contained Progressive Web App that demonstrates the full push
flow end to end: subscribe in the browser → trigger a notification → receive it.
Hosted on its own Hetzner VM at `https://demo.lmao.cl`, independent from the
testing backend at `push.lmao.cl`.

## Architecture

A new Hetzner `cx23` VM runs a 4-service Docker Compose stack:

1. **postgres** — store for the push backend.
2. **push** — the backend from this repo (same `Dockerfile`), configured with a
   single app `demo-app` and its API key.
3. **demo** — a minimal Node/Express server that serves the PWA static files and
   exposes the trigger endpoints (it holds the app key server-side; the browser
   never sees it).
4. **caddy** — automatic HTTPS for `demo.lmao.cl` and path routing.

### Caddy routing (`demo.lmao.cl`)

- `/vapid-public-key`, `/subscriptions*` → `push:4000` (browser-facing push API)
- everything else → `demo:3000` (PWA static assets + `/api/*`)

Same-origin, so no CORS concerns for the browser-facing endpoints.

## The demo app (`demo/` in the repo)

```
demo/
  public/
    index.html            UI: enable button, title/body inputs, send/broadcast
    app.js                vanilla subscribe flow + fetch /api/*
    push-sw.js            copy of client/service-worker.js
    manifest.webmanifest  PWA manifest
    icon.svg              app + notification icon
  server.mjs              Express: static + POST /api/trigger + /api/broadcast
  package.json
  Dockerfile
```

- `app.js` replicates `PushClient`'s subscribe flow inline (no SDK build/auth
  needed): register `push-sw.js` → `GET /vapid-public-key` → `pushManager.subscribe`
  → `POST /subscriptions` with `appId: "demo-app"` and `userId` = a UUID stored
  in `localStorage` (shown on screen).
- `server.mjs` forwards `POST /api/trigger { userId, title, body }` and
  `POST /api/broadcast { title, body }` to `push:4000/notifications/send` with the
  `x-api-key` header. It returns the push service's `{ sent, failed, expired }`
  summary, which the UI displays.

## Data flow

```
Browser --enable--> POST /subscriptions (push)        <-- receives push (SW shows notification)
Browser --send----> POST /api/trigger (demo) --> push:4000/notifications/send (x-api-key) --> push svc --+
Browser --bcast---> POST /api/broadcast (demo) -> push:4000/notifications/send broadcast=true ----------+
```

## Error handling

- `server.mjs` validates body, returns `4xx` with a JSON `{ error }` on bad input,
  and surfaces upstream failures. The UI shows a status line (`sent=1 failed=0`
  or the error message).
- Browser: gate the subscribe button on `Notification`/`serviceWorker` support;
  show permission-denied state.

## Testing / verification

- `GET https://demo.lmao.cl/` serves the PWA; `/vapid-public-key` proxies to push.
- Manual: open the PWA, enable notifications, send a test → notification arrives.
- Sanity: unauthenticated `/notifications/send` still 401 (key stays server-side).

## Secrets / config (on the VM only)

Fresh VAPID keys, `demo-app` key, `ADMIN_API_KEY`, `AUTH_JWT_SECRET`,
`POSTGRES_PASSWORD` generated on the box into `deploy-demo/.env` (chmod 600).
`CORS_ORIGINS=https://demo.lmao.cl`.

## Repo scope

The `demo/` app is committed to the repo. The VM deploy compose/Caddyfile stay
on the VM (consistent with the prior deploy), offered as a PR at the end.

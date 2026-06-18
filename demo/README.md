# Push demo PWA

A small **React** Progressive Web App that exercises the full web-push flow
against the **central push service** (`push.lmao.cl`): **subscribe in the
browser → trigger a notification → receive it**.

It dogfoods the published private SDK **`@p2pdotme/push-client`** and is split
into two folders:

- **`frontend/`** — React + Vite PWA, uses the `usePush` hook from
  `@p2pdotme/push-client/react`. The browser subscribes **directly** against the
  push service (`pushBase`, read from `/config.json`).
- **`server/`** — Express backend, uses `PushServer` from
  `@p2pdotme/push-client/server` to trigger sends with the app key (kept
  server-side). It also serves the built PWA and `/config.json`.

The push service manages apps, keys and the allowed-origins list (administered
from the dashboard). This app's origin (`https://demo.lmao.cl`) must be allowed
for its app id there.

## Layout

| Path | What it is |
| ---- | ---------- |
| `frontend/` | React + Vite PWA (`src/App.jsx` uses `usePush`) |
| `frontend/public/` | `push-sw.js`, `manifest.webmanifest`, `icon.svg` (copied verbatim) |
| `server/server.mjs` | Express backend: serves the PWA + `POST /api/trigger` / `POST /api/broadcast` via `PushServer` |
| `server/Dockerfile` | Runtime image (express only; the SDK is bundled into `server.out.mjs`) |
| `build.sh` | Builds the React app into `server/public/` and bundles the server (`server/server.out.mjs`) |

## Endpoints (backend)

- `GET /config.json` → `{ pushBase, appId }` for the PWA.
- `POST /api/trigger { userId, title, body }` → `push.sendToUser(...)`.
- `POST /api/broadcast { title, body }` → `push.broadcast(...)`.

## Build

Installing `@p2pdotme/push-client` needs a `read:packages` token for the
`@p2pdotme` scope. Put it in `frontend/.npmrc` and `server/.npmrc` (both
gitignored):

```
@p2pdotme:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_xxx
```

Then:

```bash
./build.sh        # -> server/public/ (React PWA) + server/server.out.mjs
```

The token is only used at build time and is **not** baked into the image or
shipped to the server.

## Run locally

```bash
# 1. Backend (after build.sh, or with the SDK installed)
cd server
PUSH_URL=https://push.lmao.cl PUSH_PUBLIC_URL=https://push.lmao.cl \
PUSH_API_KEY=<demo-app key> node server.out.mjs   # :3000

# 2. Frontend dev server (proxies /api + /config.json to :3000)
cd frontend && npm run dev                          # :5173
```

Subscribing from a local origin requires that origin to be allowed for the app
in the push service (add it under the app's CORS origins).

## Environment (backend)

| Var | Default | Notes |
| --- | ------- | ----- |
| `PORT` | `3000` | HTTP port |
| `PUSH_URL` | `https://push.lmao.cl` | Push service base URL (server-to-server) |
| `PUSH_PUBLIC_URL` | = `PUSH_URL` | Push service URL the browser subscribes against |
| `PUSH_APP_ID` | `demo-app` | App id the demo sends as |
| `PUSH_API_KEY` | — | **Required.** App key for `PUSH_APP_ID` |

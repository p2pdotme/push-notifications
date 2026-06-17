# Deploying with Docker

This guide covers running the push service in production with Docker. The repo
ships a multi-stage [`Dockerfile`](../Dockerfile) and a
[`docker-compose.yml`](../docker-compose.yml) that builds the image, persists the
SQLite database to a named volume, and wires up the required environment.

## What you get

- **Multi-stage build** — TypeScript is compiled in a `build` stage with
  toolchain packages (`python3`, `make`, `g++`) available as a `better-sqlite3`
  prebuild fallback; the `runtime` stage installs prod deps only, so the final
  image stays small (~30 MB of app on top of `node:22-slim`).
- **Capped heap** — the runtime sets
  `NODE_OPTIONS=--max-old-space-size=128 --max-semi-space-size=2` so RSS stays
  low on a small host. Raise it for high-traffic deployments (see below).
- **Persistent storage** — `/app/data` is a `VOLUME`; the SQLite file
  (`push.sqlite`) survives container restarts and rebuilds.
- **Exposed port** — the service listens on `4000`.

## Prerequisites

- Docker Engine 20.10+ with the Compose v2 plugin (`docker compose`, not the
  legacy `docker-compose`).
- VAPID keys. Generate them once and keep the private key secret:

  ```bash
  npm install
  npm run generate-vapid
  ```

  If you don't want a local Node toolchain, generate them inside a throwaway
  container instead:

  ```bash
  docker run --rm -v "$PWD":/app -w /app node:22-slim \
    sh -c "npm install --silent && npm run generate-vapid"
  ```

## 1. Configure

Copy the example env file and fill it in. Compose reads `.env` from the project
directory automatically and substitutes the `${VAR}` references in
`docker-compose.yml`.

```bash
cp .env.example .env
```

At minimum, set the secrets that have no safe default:

| Variable            | Required | Notes                                                              |
| ------------------- | -------- | ------------------------------------------------------------------ |
| `VAPID_PUBLIC_KEY`  | yes      | From `generate-vapid`. Shared with browsers.                       |
| `VAPID_PRIVATE_KEY` | yes      | From `generate-vapid`. **Secret.**                                 |
| `VAPID_SUBJECT`     | yes      | `mailto:` or `https:` contact (defaults to `mailto:dev@p2p.me`).   |
| `ADMIN_API_KEY`     | yes      | Master send/manage key. **Secret.**                                |
| `APP_KEYS`          | no       | JSON `{ "<appId>": "<secret>" }`, imported into the DB on first boot. |
| `CORS_ORIGINS`      | no       | Comma-separated allowed origins; imported on first boot. Avoid `*` in prod. |
| `AUTH_JWT_SECRET`   | dashboard | 32+ random bytes signing admin session JWTs. **Secret.**          |
| `ADMIN_WALLETS`     | dashboard | Comma-separated bootstrap admin wallet addresses.                 |

See [`.env.example`](../.env.example) and the
[Configuration table in the README](../README.md#configuration) for the full
list. Note that `DATABASE_PATH`, `PORT`, and `HOST` are set explicitly in
`docker-compose.yml` (`/app/data/push.sqlite`, `4000`, `0.0.0.0`) and don't need
to be repeated in `.env`.

Generate a strong `AUTH_JWT_SECRET`:

```bash
openssl rand -base64 48
```

## 2. Build and run

```bash
docker compose up --build -d
```

- `--build` rebuilds the image (drop it on subsequent starts if nothing changed).
- `-d` runs detached. The service restarts automatically (`restart:
  unless-stopped`) unless you stop it explicitly.

Check it's healthy:

```bash
curl http://localhost:4000/health
docker compose logs -f push
```

## 3. Verify

```bash
# Public VAPID key (browsers fetch this to subscribe)
curl http://localhost:4000/vapid-public-key

# Authenticated send (replace with your ADMIN_API_KEY)
curl -X POST http://localhost:4000/notifications/send \
  -H "x-api-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"appId":"user-app","broadcast":true,"notification":{"title":"Hello","body":"It works"}}'
```

## Data persistence & backups

The SQLite database lives in the `push-data` named volume, mounted at
`/app/data`. It outlives `docker compose down`. To back it up:

```bash
# Copy the DB out of the running container
docker compose cp push:/app/data/push.sqlite ./push.sqlite.bak
```

To wipe everything (including subscriptions and the delivery log):

```bash
docker compose down -v   # -v also removes the named volume
```

## Updating

```bash
git pull
docker compose up --build -d
```

The schema migrates automatically on boot, and the volume keeps your data across
rebuilds.

## Running the image without Compose

If you prefer plain `docker run`:

```bash
docker build -t push-notifications .

docker run -d --name push \
  -p 4000:4000 \
  --env-file .env \
  -e DATABASE_PATH=/app/data/push.sqlite \
  -v push-data:/app/data \
  --restart unless-stopped \
  push-notifications
```

## Production notes

- **Put it behind TLS.** The service speaks plain HTTP on `4000`. Terminate TLS
  at a reverse proxy (nginx, Caddy, Traefik) or your platform's load balancer and
  forward to the container. Browsers only allow push subscriptions on HTTPS
  origins.
- **Don't expose the port publicly unproxied.** Bind it to localhost
  (`-p 127.0.0.1:4000:4000`) when a proxy on the same host fronts it.
- **Lock down CORS.** Set `CORS_ORIGINS` to your real app origins; `*` is for
  local dev only. The public `/subscriptions` endpoint has no API key (browsers
  can't hold secrets), so protect it with CORS plus a rate limiter / WAF at the
  edge.
- **Heap sizing.** The default `NODE_OPTIONS` caps the V8 heap at 128 MB. For
  busier hosts, override it in `docker-compose.yml` under `environment:` or with
  `-e NODE_OPTIONS=...`, e.g. `--max-old-space-size=512`.
- **Health checks.** Point your orchestrator's liveness probe at `GET /health`.
- **Single instance.** SQLite suits one instance comfortably. For multi-instance
  HA, move the repository layer (`src/repository.ts`) to Postgres — running
  several containers against one SQLite file on a shared volume is not supported.
- **Secrets.** Prefer your platform's secrets manager over a committed `.env`.
  Compose also accepts values from the host environment, so
  `VAPID_PRIVATE_KEY=... docker compose up` or an injected env works without a
  file on disk.

## Troubleshooting

| Symptom                                   | Likely cause / fix                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `better-sqlite3` build errors on `up`     | Rare on `node:22-slim`; the build stage installs `python3`/`make`/`g++` as fallback. Run `docker compose build --no-cache`. |
| Container exits immediately               | Missing `VAPID_*` or `ADMIN_API_KEY`. Check `docker compose logs push`.            |
| Browser subscribe fails with CORS error   | Add the app origin to `CORS_ORIGINS` (or via the dashboard once running).          |
| Data lost after redeploy                  | You ran `docker compose down -v`, which deletes the volume. Use `down` without `-v`. |
| Push deliveries fail with 403/`VAPID` errors | `VAPID_SUBJECT` must be a valid `mailto:`/`https:` URL and the key pair must match the one browsers subscribed with. |

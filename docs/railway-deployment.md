# Deploying on Railway (backend) + Netlify (dashboard)

## Backend (push API) on Railway

1. **Create the service** from this repo. Railway builds the `Dockerfile`
   automatically. No volume is needed — state lives in Postgres.
2. **Add Postgres**: in the Railway project, "New → Database → PostgreSQL".
3. **Wire the connection string**: on the push service, set
   `DATABASE_URL=${{Postgres.DATABASE_URL}}` (Railway reference variable). The
   service runs its own schema migration on boot. Use the **internal** reference
   `${{Postgres.DATABASE_URL}}` — no TLS config needed. If you must use the
   **public** Postgres URL instead, append `?sslmode=require` to it (the app
   uses `pg`'s default SSL handling).
4. **Set the remaining variables** (Service → Variables):
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
   - `ADMIN_API_KEY`
   - `AUTH_DOMAIN=push.p2p.me`
   - `AUTH_JWT_SECRET` (32+ random bytes)
   - `ADMIN_WALLETS` (bootstrap admin wallet address)
   - `DASHBOARD_ORIGIN=https://<your-netlify-domain>`
   - `PORT` is provided by Railway automatically; the app reads it.
   - `APP_KEYS` (optional) — JSON `{"<appId>":"<secret>"}` to seed per-app API keys on first boot; afterward the dashboard manages keys.
5. **Health check**: set the Railway healthcheck path to `/health`.
6. **Custom domain**: map `push.p2p.me` to the service. Ensure `AUTH_DOMAIN`
   matches the host browsers see, or SIWE login will fail.

> VAPID keys are permanent — generate once with `npm run generate-vapid`, store
> them durably, and never rotate casually (rotation invalidates every existing
> subscription).

## Dashboard (admin SPA) on Netlify

The dashboard ships with `dashboard/netlify.toml` (base dir `dashboard`, SPA
fallback redirect). In Netlify:

1. New site from this repo; set **base directory = `dashboard`** (or rely on the
   committed `netlify.toml`).
2. Environment variables:
   - `VITE_API_BASE_URL=https://push.p2p.me`
   - `VITE_THIRDWEB_CLIENT_ID=<public thirdweb client id>`
3. Deploy, then set the backend's `DASHBOARD_ORIGIN` to the resulting Netlify
   origin (and re-deploy the backend). The admin plane only accepts that exact
   origin.

## First-admin bootstrap

Log in once via the dashboard to discover your embedded-wallet address (the UI
shows it when unauthorized), add it to `ADMIN_WALLETS` on Railway, and redeploy.

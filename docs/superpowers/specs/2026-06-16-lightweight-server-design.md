# Design: Ultra-lightweight push server (drop thirdweb, trim runtime)

**Date:** 2026-06-16
**Status:** Approved (design)
**Topic:** Minimise the push service's RAM, CPU, and dependency footprint without
changing observable behaviour.

## Problem

The server (`src/`) declares 6 dependencies, but `node_modules` weighs **1.0 GB**.
Roughly 970 MB is `thirdweb` and its transitive tree (`@reown` 225 MB,
`@walletconnect` 150 MB, `thirdweb` 122 MB, `@coinbase` 79 MB, `viem` 56 MB,
`@metamask`, `porto`, `@solana`, `@wagmi`, `react-dom`, `@radix-ui`, …). thirdweb
is imported **only** for the dashboard's SIWE login — four functions in
`src/auth-service.ts`. Loading that import graph on every boot dominates baseline
RSS and cold-start CPU, and bloats the Docker image.

Everything else (express, better-sqlite3, web-push, zod) is small and necessary.

Admins authenticate with **EOA wallets** (MetaMask, Rabby, Ledger), so plain
secp256k1 signature recovery is sufficient — no EIP-1271 / smart-account RPC
verification is needed.

## Goal

Make the **server** process as light as possible (RAM at idle + cold-start CPU +
image size) with **zero observable behaviour change**: same `AuthService`
interface, same HTTP API, same SQLite schema, same dashboard (untouched, still
wire-compatible).

Non-goal: the dashboard bundle (browser-side; does not affect server footprint).
Non-goal: changing the public API, the DB schema, or swapping express.

## Part 1 — Remove thirdweb from the server (≈95% of the win)

### What thirdweb actually does for us

Verified against the installed thirdweb source:

- `createLoginMessage(payload)` — a deterministic EIP-4361 string serializer
  (~30 lines, no crypto). Source read from
  `node_modules/thirdweb/dist/esm/auth/core/create-login-message.js`.
- `verifyEOASignature` = `hashMessage(message)` (EIP-191 personal_sign hash) →
  `ox.Secp256k1.recoverAddress({ payload: hash, signature })` → compare to the
  claimed address. thirdweb itself uses **`ox` 0.7.0** for these primitives.
- `generateJWT` / `verifyJWT` — issue and check a token. **Only our server**
  consumes this token; the dashboard stores it opaquely (`localStorage`) and
  replays it as a `Bearer` header. Nothing external parses it.

### The wire contract that must not break

1. Dashboard `getLoginPayload({ address })` → `GET /auth/payload?address=…` →
   **our server** returns a `LoginPayload` object `P`.
2. thirdweb **client** builds `M = createLoginMessage(P)` and signs it with the
   wallet (EIP-191 `personal_sign`) → signature `S`.
3. Dashboard `doLogin({ payload: P, signature: S })` → `POST /auth/login`.
4. **Our server** must rebuild `M' = createLoginMessage(P)`, recover the address
   from `S` over `M'`, and confirm it equals `P.address`.

For step 4 to recover the correct address, **our `createLoginMessage` must match
the thirdweb client's byte-for-byte.** We guarantee this by copying thirdweb's
exact serializer and locking it with a contract test (below).

### Approach (chosen: A)

- **Crypto primitives:** add `ox` (^0.7.0) as a direct dependency.
  Use `ox/Secp256k1` + `ox/Signature` for address recovery — the exact
  primitives thirdweb uses, so recovery semantics are identical. Use
  `@noble/hashes` (keccak_256, a transitive dep of ox, declared directly) for the
  EIP-191 message hash. `ox` is ~7 MB; its deps are `@noble/*` + `@scure/*`
  (a few MB). Total footprint after the swap: ~20–30 MB vs ~1 GB.
- **SIWE message:** copy thirdweb's `createLoginMessage` verbatim into our code
  (MIT-licensed; ~30 lines). Generation and verification use the same function,
  so they are internally consistent; the contract test proves it also matches the
  thirdweb client.
- **Payload generation:** `generatePayload(address)` returns a `LoginPayload`
  with the same field set thirdweb produces — `domain`, `address`, `statement`
  (thirdweb default), `version: "1"`, `nonce` (random 16 bytes hex), `issued_at`
  (now, ISO), `expiration_time` (now + 10 min), `invalid_before` (now). The
  dashboard signs whatever we generate.
- **JWT:** HS256 via `node:crypto` (`createHmac('sha256', secret)`), zero
  dependency. Token = `base64url(header).base64url(claims).base64url(hmac)`.
  Claims: `{ sub: address, iat, exp }` (exp e.g. 7 days). `verifyJwt` recomputes
  the HMAC with `timingSafeEqual` and checks `exp`. Returns `{ address }` (lower-
  cased `sub`) or `null` — matching the current contract.
- **Security parity with today:** verify signature + `expiration_time` +
  `domain`. thirdweb today runs without `validateNonce`, so it does not check
  nonce replay within the validity window; we match that (stateless). An optional
  in-memory single-use nonce store is noted as a future hardening but is **out of
  scope** (YAGNI; would add cross-restart/multi-instance state).

Rejected alternatives: **B** (`@noble` only) — ~2 MB but more hand-rolled crypto
glue for a marginal size gain over A; **C** (`siwe` + `viem`) — viem is 56 MB,
defeats the purpose.

### Contract test (the safety net)

Add a test that keeps `thirdweb` as a **devDependency** and asserts:

1. `ourCreateLoginMessage(P) === thirdwebCreateLoginMessage(P)` for representative
   payloads (with/without `chain_id`, `uri`, `resources`, empty `statement`).
2. Round-trip: sign a payload with thirdweb's client `signLoginPayload` using a
   known test private key → our `verifyAndIssueJwt` accepts it and returns the
   matching address; a tampered signature/address is rejected.
3. JWT round-trip: `verifyJwt(issued)` returns the address; tampered/expired
   tokens return `null`.

The runtime Docker image runs `npm install --omit=dev`, so thirdweb never ships
to production — it exists only to guard the wire contract in CI/dev.

### Config / env changes (backward compatible)

`src/config.ts`:

- `THIRDWEB_SECRET_KEY` — no longer required (was only for the thirdweb client).
- `AUTH_DOMAIN` — new name for the SIWE `domain`; **falls back** to
  `THIRDWEB_AUTH_DOMAIN` if unset, so existing `.env` files keep working.
- `AUTH_JWT_SECRET` — HS256 signing secret; **falls back** to
  `THIRDWEB_AUTH_PRIVATE_KEY` (a 32-byte hex key — good HMAC entropy) so existing
  deployments keep working with no env change.
- Update `.env.example` and `README` to document the new names and that thirdweb
  is no longer a runtime dependency.

### Files touched (Part 1)

- `src/auth-service.ts` — replace `createThirdwebAuthService` body; **keep the
  `AuthService` interface and the exported factory name unchanged** so
  `src/index.ts`, routes, `src/auth.ts`, and `test/fake-auth-service.ts` are
  untouched.
- `src/siwe.ts` (new) — copied `createLoginMessage` + EIP-191 hash + recover.
- `src/jwt.ts` (new) — HS256 issue/verify via `node:crypto`.
- `src/config.ts` — env changes above.
- `package.json` — remove `thirdweb` from `dependencies`, add to
  `devDependencies`; add `ox` + `@noble/hashes` to `dependencies`.
- `test/auth-contract.test.ts` (new) — the contract test.
- `.env.example`, `README.md` — docs.

## Part 2 — Runtime polish (the rest)

1. **Concurrency-limited fan-out** in `src/webpush.ts`. `sendToMany` currently
   does `Promise.all(subs.map(sendToOne))` — fires *every* push at once. For
   large fan-outs this spikes CPU (concurrent AES-GCM + VAPID JWT signing), RAM,
   and open sockets/FDs. Replace with a small worker pool (default 25 in flight,
   `SEND_CONCURRENCY` env). Same total throughput, flat resource curve. The
   returned `SendSummary` shape is unchanged.
2. **Low-RAM SQLite pragmas** in `src/db.ts`: keep `journal_mode=WAL` and
   `foreign_keys=ON`; add a bounded `cache_size` (e.g. `-2000` = 2 MB),
   `mmap_size = 0` (avoid mapping the DB into RSS), and a `wal_autocheckpoint`
   so the WAL file does not grow unbounded.
3. **Optional log retention.** `notification_logs` grows without bound. Add
   `LOG_RETENTION_DAYS` (default 0 = keep forever, no behaviour change unless
   configured). When set, prune rows older than N days on a low-frequency timer
   (e.g. hourly) and on startup. Bounds DB size → bounds page cache + disk.
4. **V8 heap cap in Docker.** Set
   `ENV NODE_OPTIONS="--max-old-space-size=128 --max-semi-space-size=2"` in the
   runtime stage. For a low-traffic service this keeps RSS small and makes GC
   reclaim aggressively. Documented as tunable.
5. **Slimmer Docker image.** After removing thirdweb the image shrinks on its
   own. Use `npm ci` (lockfile-exact, faster) in both stages. Build stage is much
   faster without thirdweb. Keep the python3/make/g++ fallback for better-sqlite3.
6. **Explicitly NOT done:** swapping express (small, battle-tested — replacing it
   is risk with no meaningful footprint win), changing the SQLite schema, manual
   prepared-statement caching (better-sqlite3 already caches prepared statements
   internally, so the gain is negligible), and any public-API change.

## What stays identical

`AuthService` interface, all routes, the dashboard, the HTTP API surface, and the
DB schema. No observable behaviour change — only reduced weight.

## Success criteria

- `node_modules` (production, `--omit=dev`) drops from ~1 GB to ≲50 MB.
- The server boots, `/health` returns ok, and a full SIWE login round-trip
  succeeds end-to-end with the unchanged dashboard.
- All existing tests pass; the new contract test passes; `npm run typecheck`
  passes.
- Docker runtime image is materially smaller and starts faster.

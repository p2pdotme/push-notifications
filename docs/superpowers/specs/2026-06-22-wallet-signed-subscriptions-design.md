# Wallet-signed push subscriptions — design

**Date:** 2026-06-22
**Status:** Approved (pending spec review)

## Problem

`POST /subscriptions` is intentionally unauthenticated — browsers can't hold an
API key, so the endpoint is scoped to an `appId`, origin-checked, and edge
rate-limited, but otherwise open. The request body carries a `userId`, which in
this service **is the subscriber's wallet address**. Nothing proves the caller
controls that address.

The consequence: anyone can register *their* browser's push channel under
*anyone else's* wallet address and silently receive that wallet's
notifications — an impersonation / notification-hijack hole.

## Goal

Require a subscriber to prove control of the wallet address (`userId`) they
subscribe under, by signing a server-issued challenge. Support both:

- **EOA wallets** — standard `personal_sign` / EIP-191, recovered with secp256k1.
- **Smart contract wallets** — EIP-1271 `isValidSignature`, including
  not-yet-deployed (counterfactual) wallets via EIP-6492.

## Decisions (locked)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Rollout | **Per-app opt-in flag**, default off | Service is already deployed with a live client SDK; a global flip would break un-updated apps. |
| Verification library | **viem `verifyMessage`** | Covers EOA + EIP-1271 + EIP-6492 in one call; already a transitive dependency, so near-zero footprint cost. |
| Chain | **Base** (chain ID `8453`), single chain | Where p2p.me smart wallets live; one `eth_call` keeps verification fast. |
| Replay protection | **Endpoint-bound signature + stateless expiry window** | Matches the existing admin SIWE pattern; no new nonce table. |

## Protocol (challenge → sign → subscribe)

Stateless, three steps, mirroring the existing admin SIWE flow with one
addition: the signature is **bound to the specific push channel** so a captured
signature cannot be reused to attach a different browser.

1. **Browser subscribes** via `PushManager.subscribe()` → obtains a
   `PushSubscription` with its `endpoint`.

2. **`POST /subscriptions/challenge`** with `{ appId, address, endpoint }`.
   Server validates `appId`, that `address` is a `0x`-prefixed 40-hex string,
   and that the request `Origin` is allowed for the app. It returns
   `{ payload, message }`:

   - `payload` is an EIP-4361 SIWE object:
     - `address` — the wallet to prove,
     - `domain` / `uri` — the request **Origin host** (validated against the
       app's allowed origins; anti-phishing — the user sees which site they are
       signing for),
     - `version: "1"`,
     - `statement` — the existing default statement,
     - `nonce` — `generateNonce()` (16 random bytes hex; informational here,
       freshness comes from the window),
     - `issued_at`, `expiration_time` (now + 10 min), `invalid_before`
       (now − 10 min),
     - `resources: ["push-channel:<appId>:<sha256hex(endpoint)>"]` — the
       channel binding.
   - `message` = `createLoginMessage(payload)` — the exact string to sign, so
     the client never re-implements EIP-4361 message construction.

   Server stores nothing.

3. **`POST /subscriptions`** with `{ appId, userId, subscription, payload, signature }`.

## Server verification (on `POST /subscriptions`)

When the app's flag is **on** (or whenever `payload` + `signature` are present),
the server, before upserting:

1. Re-derives the binding resource
   `push-channel:<appId>:<sha256hex(submitted subscription.endpoint)>` and
   asserts it appears in `payload.resources`. This binds the proof to **this
   exact channel** — the server trusts the submitted endpoint, not a
   client-claimed one.
2. Asserts `payload.address.toLowerCase() === userId.toLowerCase()` and that
   `userId` is a valid `0x` address.
3. Asserts `payload.domain` equals the request `Origin` host and that the
   origin is allowed for the app.
4. Asserts the expiry window: `expiration_time > now` and `invalid_before < now`.
5. Re-derives `message = createLoginMessage(payload)` (never trusts a
   client-sent message string).
6. Verifies the signature against `userId` with viem (see below).
7. On success → `upsertSubscription` with `verified_at = now`. On any failure →
   `401`.

### Replay analysis

A captured `{ payload, signature }` is bound to
`(address, appId, endpoint, 10-minute window)`. Replaying it only re-registers
the **same** channel under the **same** address — no privilege gain. An
attacker cannot:

- attach a **different endpoint** — the `sha256(endpoint)` resource won't match;
- claim a **different address** — `payload.address` is signed, and the
  signature won't verify against the swapped `userId`;
- reuse across **a different app** — `appId` is part of the bound resource;
- reuse on **a different origin** — `payload.domain` must equal the request
  Origin host.

A single-use nonce store is therefore not required for v1 (noted as future
hardening).

## Verification module (`src/subscription-verify.ts`)

New, isolated module — the audited admin auth path (`auth-service.ts`,
`siwe.ts`) is left untouched. It reuses `createLoginMessage` and
`generateNonce` from `siwe.ts`. Verification:

```ts
const ok = await publicClient.verifyMessage({ address: userId, message, signature });
```

`publicClient` is a viem `createPublicClient({ chain: base, transport: http(RPC_URL) })`.
viem's `verifyMessage` automatically:

- recovers an **EOA** via `ecrecover`, else
- calls **EIP-1271** `isValidSignature(hashMessage(message), signature)` on a
  deployed contract wallet, else
- performs the **EIP-6492** simulated-deploy check for an undeployed
  (counterfactual) smart wallet.

The module exposes:

- `buildSubscriptionChallenge({ address, appId, endpoint, originHost })` →
  `{ payload, message }`.
- `verifySubscriptionProof({ userId, appId, endpoint, originHost, payload, signature })`
  → `Promise<boolean>` performing steps 1–6 above.

The viem public client is created once (lazily) and reused. When
`SUBSCRIBE_VERIFY_RPC_URL` is unset, viem falls back to its default public Base
RPC (rate-limited; configure a dedicated endpoint for production). EOA
signatures verify offline regardless; an invalid signature fails closed
(verification returns false → 401).

## Per-app opt-in & rollout

- **DB migration** (idempotent, in `db.ts` init):
  - `ALTER TABLE apps ADD COLUMN IF NOT EXISTS require_subscription_signature integer NOT NULL DEFAULT 0;`
  - `ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS verified_at timestamptz;`
- Flag **off** → `POST /subscriptions` behaves exactly as today (no `payload`/
  `signature` needed, `verified_at` stays null). No breakage for existing apps.
- Flag **on**:
  - `userId` is **required** and must be a `0x` wallet address — a null or
    non-address `userId` → `401` (`signature_required`). Anonymous
    subscriptions are not allowed on a signature-required app.
  - missing `payload`/`signature` → `401` with a machine-readable code
    (`signature_required`);
  - invalid proof → `401`.
- **Refresh UX:** re-syncing an **already-verified** `(endpoint, userId)` pair
  is allowed **without** a new signature — the route checks for an existing
  verified row first. Users sign once, not on every app load. A **new endpoint**
  or a **changed `userId`** requires a fresh signature.
- **Admin surface:** `updateAppSchema` gains
  `requireSubscriptionSignature?: boolean`; the admin route + `repository.updateApp`
  persist it; the dashboard gets a toggle switch on the app detail view.

## Client SDK (`@p2pdotme/push-client`)

- `PushClient.subscribe(userId?, opts?)` and `usePush({ ..., signMessage? })`
  gain an optional `signMessage: (message: string) => Promise<string>`.
- `signMessage` is **wallet-agnostic** — satisfied by a thirdweb account, a
  viem/wagmi wallet client, ethers, or an injected provider. Smart-wallet
  accounts return a 1271/6492 signature transparently; the SDK does not care.
- Flow:
  - PushManager subscribe → obtain `endpoint`.
  - If `signMessage` provided: `POST /subscriptions/challenge` → `signMessage(message)`
    → `POST /subscriptions` with `{ payload, signature }`.
  - Else: legacy `POST /subscriptions` (no proof).
- If the server responds `401 signature_required` and no `signMessage` was
  supplied, the SDK throws a typed `SignatureRequiredError` so callers can
  prompt for a wallet connection.
- `sync()` follows the same branching for subscription refreshes.

## Config (`src/config.ts`)

- `SUBSCRIBE_VERIFY_RPC_URL` — Base RPC endpoint.
- `SUBSCRIBE_VERIFY_CHAIN_ID` — default `8453` (Base).

Both are **optional at startup** (validated lazily) so existing deployments that
don't use the feature keep running. When `SUBSCRIBE_VERIFY_RPC_URL` is unset,
viem falls back to its default public Base RPC (rate-limited; configure a
dedicated endpoint for production). EOA signatures verify offline regardless;
an invalid signature fails closed (returns false → 401). Documented in
`.env.example` and the README.

## Testing

- **Verifier unit tests** (`test/subscription-verify.test.ts`):
  - valid EOA proof (reuse the Hardhat key from `siwe.test.ts`),
  - tampered payload after signing,
  - expired / not-yet-valid window,
  - `payload.address` ≠ `userId`,
  - endpoint-binding mismatch (resource doesn't match submitted endpoint),
  - domain / origin mismatch.
  EOA cases need no RPC. The EIP-1271/6492 contract-wallet path is covered by an
  **integration test gated on an RPC env var** (skipped in CI when unset), since
  it requires a real Base `eth_call`.
- **Route tests** (extend `test/api.test.ts`):
  - flag-off → legacy subscribe still returns `201`, `verified_at` null;
  - flag-on + no proof → `401 signature_required`;
  - flag-on + valid EOA proof → `201`, `verified_at` set;
  - flag-on + tampered endpoint → `401`;
  - flag-on + idempotent refresh of a verified `(endpoint, userId)` → `201`
    without a new signature.
- **Contract test** (extend `test/auth-contract.test.ts` pattern): a
  thirdweb-EOA-signed challenge verifies through the new path, guarding message
  equivalence.

## Out of scope (YAGNI)

- Multi-chain verification — Base only for v1.
- Single-use nonce store — endpoint binding + expiry window suffices.
- Forcing re-verification of subscriptions stored before this feature — they are
  grandfathered with `verified_at = null`.

## Files touched (summary)

| File | Change |
| --- | --- |
| `src/config.ts` | `SUBSCRIBE_VERIFY_RPC_URL`, `SUBSCRIBE_VERIFY_CHAIN_ID`. |
| `src/db.ts` | Two idempotent `ALTER TABLE` migrations. |
| `src/subscription-verify.ts` | **New** — challenge builder + viem verifier. |
| `src/schemas.ts` | `subscribeSchema` gains optional `payload`/`signature`; challenge schema; `updateAppSchema` gains the flag. |
| `src/routes/subscriptions.ts` | `POST /challenge`; proof verification + refresh-skip logic in `POST /`. |
| `src/repository.ts` | `verified_at` in upsert; read existing verified row; `require_subscription_signature` in app read/update. |
| `src/routes/admin.ts` | Persist the flag on app update. |
| `client/src/index.ts`, `client/src/react.ts` | `signMessage` option + challenge flow + `SignatureRequiredError`. |
| `dashboard/**` | App-detail toggle for the flag. |
| `.env.example`, `README.md` | Document the new env vars + the signing flow. |
| `test/**` | Verifier, route, and contract tests above. |

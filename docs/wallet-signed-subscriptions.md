# Wallet-signed subscriptions

A guide for **app developers** integrating the signed-subscribe flow, and for
**operators** enabling and running it.

When an app turns on **Require a wallet signature to subscribe**, the push
service stops trusting the `userId` (wallet address) sent with a subscription
and instead requires the subscriber to prove control of that wallet by signing
a short-lived, channel-bound challenge. Both regular wallets (EOA) and smart
contract wallets (EIP-1271 / EIP-6492) are supported.

For the protocol-level design and threat model, see
[`docs/superpowers/specs/2026-06-22-wallet-signed-subscriptions-design.md`](./superpowers/specs/2026-06-22-wallet-signed-subscriptions-design.md).

---

## Part 1 — Developer integration guide

### The one thing you add: `signMessage`

The client SDK already handles the whole challenge → sign → subscribe round-trip.
The only thing you supply is a `signMessage` callback that asks the user's wallet
to sign a string:

```ts
type SignMessage = (message: string) => Promise<string>; // returns the signature hex
```

- `userId` must be the **address you are proving** — for a smart wallet, that is
  the **smart-account address**, not the EOA owner/signer.
- `signMessage` must produce a standard **EIP-191 `personal_sign`** signature over
  the exact `message` string. Every wallet library below does this by default, so
  you don't compute any hash yourself.
- For smart wallets you change **nothing** here — the wallet's `signMessage`
  returns an EIP-1271/6492 signature transparently, and the server verifies it.

### React (`usePush`)

```ts
import { usePush } from '@p2pdotme/push-client/react';

const push = usePush({
  serverUrl: 'https://push.p2p.me',
  appId: 'user-app',
  userId: walletAddress,                          // address to prove (smart-account addr for SCWs)
  signMessage: (message) => wallet.signMessage(message),
});

// On a user gesture:
<button disabled={!push.supported} onClick={push.subscribe}>
  Enable notifications
</button>;
```

### Vanilla (`PushClient`)

```ts
import { PushClient } from '@p2pdotme/push-client';

const push = new PushClient({ serverUrl: 'https://push.p2p.me', appId: 'user-app' });

await push.subscribe(walletAddress, {
  signMessage: (message) => wallet.signMessage(message),
});
```

### Wiring `signMessage` to your wallet

All of these return an EIP-191 `personal_sign` signature compatible with the
server's verifier.

**thirdweb** (`thirdweb/react`) — works for both in-app EOAs and smart accounts;
`account.address` is already the smart-account address when account abstraction
is enabled:

```ts
import { useActiveAccount } from 'thirdweb/react';

const account = useActiveAccount();
const push = usePush({
  serverUrl, appId,
  userId: account?.address,
  signMessage: (message) => account!.signMessage({ message }),
});
```

**wagmi** — the connected account may be an EOA or a smart-account connector
(Coinbase Smart Wallet, ZeroDev, etc.); either way `useAccount().address` is the
address to prove:

```ts
import { useAccount, useSignMessage } from 'wagmi';

const { address } = useAccount();
const { signMessageAsync } = useSignMessage();
const push = usePush({
  serverUrl, appId,
  userId: address,
  signMessage: (message) => signMessageAsync({ message }),
});
```

**viem `WalletClient`** (including an injected EIP-1193 provider via `custom`):

```ts
import { createWalletClient, custom } from 'viem';

const walletClient = createWalletClient({ transport: custom(window.ethereum) });
const [account] = await walletClient.getAddresses();

const signMessage = (message: string) =>
  walletClient.signMessage({ account, message });
```

**ethers v6** (EOA, or a 1271/6492-capable account-abstraction signer):

```ts
const signer = await provider.getSigner();
const signMessage = (message: string) => signer.signMessage(message);
```

**Raw injected provider (lowest level).** Prefer the viem path above — raw
`personal_sign` requires you to hex-encode the message, and parameter order
varies between wallets:

```ts
import { toHex } from 'viem';

const signMessage = (message: string) =>
  window.ethereum.request({ method: 'personal_sign', params: [toHex(message), address] });
```

### Handling `SignatureRequiredError`

If the app has signatures enabled but you call `subscribe()`/`sync()` **without**
a `signMessage` (or with a falsy `userId`), the SDK throws
`SignatureRequiredError`. Catch it to prompt a wallet connection:

```ts
import { SignatureRequiredError } from '@p2pdotme/push-client';

try {
  await push.subscribe(walletAddress, { signMessage });
} catch (err) {
  if (err instanceof SignatureRequiredError) {
    await connectWallet(); // then retry subscribe()
  } else {
    throw err;
  }
}
```

### Re-subscribing / refreshing

- The user signs **once**. Re-syncing the **same** push channel under the **same**
  wallet **and** the **same app** is allowed **without** a new signature, so you can
  call `subscribe()` on every app load without prompting the wallet each time.
- A **new endpoint** (the browser rotated its push subscription), a **changed
  wallet**, or a **different app** requires a **fresh signature**. Keep passing
  `signMessage` so the SDK can re-prove transparently when needed.

### Under the hood (non-JS clients)

If you aren't using the SDK, perform the two requests yourself. Send the calling
site's `Origin` header — it must be an allowed origin for the app.

```http
POST /subscriptions/challenge        Origin: https://app.example.com
{ "appId": "user-app", "address": "0xabc…", "endpoint": "https://push…/xyz" }

→ 200 { "payload": { …EIP-4361… }, "message": "user-app wants you to sign…" }
```

Sign `message` with the wallet, then:

```http
POST /subscriptions                  Origin: https://app.example.com
{
  "appId": "user-app",
  "userId": "0xabc…",
  "subscription": { "endpoint": "https://push…/xyz", "keys": { "p256dh": "…", "auth": "…" } },
  "payload":   { …the payload from the challenge, unchanged… },
  "signature": "0x…"
}

→ 201 { "id": 42, "appId": "user-app" }
```

On failure the server returns `401` with a machine-readable `code`:

| `code`               | Meaning                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| `signature_required` | The app requires a signature and none (or no verified prior channel) was supplied, or `userId` was missing / not a `0x` address. |
| `invalid_signature`  | A `payload`+`signature` was supplied but failed verification (wrong signer, tampered endpoint/origin, expired window, or bad smart-wallet signature). |

---

## Part 2 — Operator / deployment guide

### 1. Configure Base verification

Smart-wallet (EIP-1271 / EIP-6492) verification makes an on-chain
`isValidSignature` call, so the service needs a Base RPC. EOA signatures verify
**offline** and need no RPC.

```bash
# Base RPC endpoint (Alchemy / Infura / QuickNode / your node). Strongly
# recommended in production. If unset, viem falls back to Base's default PUBLIC
# RPC, which is rate-limited — fine for low volume, risky at scale.
SUBSCRIBE_VERIFY_RPC_URL=https://base-mainnet.example/v2/<key>

# Chain to verify against. Default 8453 (Base mainnet).
SUBSCRIBE_VERIFY_CHAIN_ID=8453
```

Restart the service after changing these (config is read at boot).

### 2. Roll out in the right order

Enabling the flag is a **breaking change for un-updated clients**: a client that
doesn't send a signature gets `401 signature_required`. So:

1. **Ship the updated app client first** — the one that passes `signMessage` to
   `usePush` / `PushClient.subscribe`. Verify it's live for your users.
2. **Then enable the flag** for that app (next step).

This ordering means no user is locked out mid-rollout. (Already-stored
subscriptions from before the flag are grandfathered and keep receiving
notifications; they're only re-verified on their next `subscribe()`.)

### 3. Enable the per-app flag

**Via the dashboard:** open the app's detail page and toggle **Require a wallet
signature to subscribe**.

**Via the admin API** (admin Bearer JWT from the SIWE login):

```bash
curl -X PATCH https://push.p2p.me/admin/apps/user-app \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{ "requireSubscriptionSignature": true }'
```

The flag is **per app** — other apps are unaffected and keep the open subscribe
behavior until you flip theirs.

### 4. Verify smart-wallet verification before relying on it

CI exercises the EOA path with a real signature, but the EIP-1271/6492 path needs
a live `eth_call` and is **not** covered automatically. Before depending on smart
wallets in production, do one end-to-end check with `SUBSCRIBE_VERIFY_RPC_URL`
set: subscribe from a real smart wallet (e.g. a thirdweb smart account or Coinbase
Smart Wallet) and confirm it returns `201`.

A successful signed subscribe stamps the subscription row's `verified_at`:

```sql
SELECT user_id, verified_at FROM subscriptions WHERE endpoint = '<endpoint>';
-- verified_at IS NOT NULL  → the wallet proved control
```

### 5. Monitor

Watch the subscribe endpoint's `401` responses by `code`:

- **`signature_required`** spiking → clients are subscribing without a signature.
  Usually an app shipped/enabled out of order (flag on before the new client) —
  roll the client out, or temporarily disable the flag.
- **`invalid_signature`** spiking → bad/expired signatures, origin/endpoint
  mismatches, or (for smart wallets) RPC failures/rate-limiting. Check
  `SUBSCRIBE_VERIFY_RPC_URL` health; remember EOAs still verify if the RPC is down.

### 6. Disable / roll back

Flip the flag off (dashboard toggle, or `PATCH … { "requireSubscriptionSignature": false }`).
The endpoint immediately reverts to the open, legacy behavior. Existing verified
subscriptions are unaffected.

### Reference: behavior matrix

| App flag | Request                                   | Result |
| -------- | ----------------------------------------- | ------ |
| off      | any subscribe (legacy or signed)          | `201`, `verified_at` left as-is |
| on       | `userId` null / not a `0x` address        | `401 signature_required` |
| on       | no `payload`/`signature`, no verified prior channel | `401 signature_required` |
| on       | no `payload`/`signature`, **same** app + wallet already verified for this endpoint | `201` (refresh, no re-sign) |
| on       | valid `payload`+`signature`               | `201`, `verified_at = now()` |
| on       | `payload`+`signature` that fails verification | `401 invalid_signature` |

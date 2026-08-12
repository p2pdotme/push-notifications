import { createHash } from 'node:crypto';
import {
  createPublicClient,
  http,
  HttpRequestError,
  LimitExceededRpcError,
  TimeoutError,
  type Transport,
} from 'viem';
import { base } from 'viem/chains';
import * as Hex from 'ox/Hex';
import * as PersonalMessage from 'ox/PersonalMessage';
import * as Secp256k1 from 'ox/Secp256k1';
import * as Signature from 'ox/Signature';
import type { Config } from './config.js';
import { createLoginMessage, generateNonce, type LoginPayload } from './siwe.js';

/** Verifies an (address, message, signature) triple. Returns false on any failure. */
export type SignatureVerifier = (args: {
  address: string;
  message: string;
  signature: string;
}) => Promise<boolean>;

const STATEMENT =
  'Sign to receive push notifications for this wallet. Make sure the domain above matches this site.';
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

/** Deterministic binding of a push channel to an app: `push-channel:<appId>:<sha256(endpoint)>`. */
export function channelResource(appId: string, endpoint: string): string {
  const hash = createHash('sha256').update(endpoint).digest('hex');
  return `push-channel:${appId}:${hash}`;
}

/**
 * Thrown by `viemSignatureVerifier` when a `false` verdict cannot be trusted
 * because the Base RPC behind the EIP-1271/6492 contract-wallet check did not
 * answer. viem reports "the RPC is down" and "the signature is wrong" with the
 * same plain `false`, so this error exists to tell those two cases apart
 * instead of silently treating one as the other.
 *
 * The whole error is safe to print. It names the class of the underlying
 * failure and carries nothing else, in particular no `cause`. viem's `getUrl`
 * is the identity function and its request errors embed the full RPC URL, API
 * key included, in a `message` that any logger prints by default, so attaching
 * the raw error would leave the key one careless `console.error(err)` away.
 * The class and the HTTP status are the whole of what is diagnostic anyway.
 */
export class VerifyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifyUnavailableError';
  }
}

/**
 * Whether an error means the RPC failed to answer, as opposed to answering
 * with a rejection. Measured against the installed viem rather than assumed:
 * an unreachable host and an HTTP 429 both arrive as `HttpRequestError`, a
 * request timeout as `TimeoutError`, and a JSON-RPC `-32005 over rate limit`
 * as `LimitExceededRpcError`.
 *
 * A bare `RpcRequestError` is deliberately excluded. That is what a plain
 * revert arrives as, and the ERC-6492 validator reverts on many genuinely bad
 * signatures, so counting it here would turn ordinary rejections into 503s.
 */
function isRpcUnavailable(
  err: unknown,
): err is HttpRequestError | TimeoutError | LimitExceededRpcError {
  return (
    err instanceof HttpRequestError ||
    err instanceof TimeoutError ||
    err instanceof LimitExceededRpcError
  );
}

/** A short description of an RPC failure built only from fixed text and a status code. */
function describeRpcFailure(err: HttpRequestError | TimeoutError | LimitExceededRpcError): string {
  if (err instanceof HttpRequestError) {
    return err.status ? `HttpRequestError, HTTP ${err.status}` : 'HttpRequestError';
  }
  if (err instanceof TimeoutError) return 'TimeoutError';
  return 'LimitExceededRpcError';
}

/** Wraps a transport so every error it raises is recorded before it propagates. */
function watchTransport(transport: Transport, record: (err: unknown) => void): Transport {
  return (options) => {
    const inner = transport(options);
    const request = inner.request as (...args: unknown[]) => Promise<unknown>;
    return {
      ...inner,
      request: (async (...args: unknown[]) => {
        try {
          return await request(...args);
        } catch (err) {
          record(err);
          throw err;
        }
      }) as typeof inner.request,
    };
  };
}

/**
 * Offline EIP-191 recovery. True only when `signature` is a plain wallet
 * signature that recovers to `address`. A contract-wallet signature, a
 * wrapped signature or garbage is false here, and is left to the on-chain
 * path.
 */
function recoversToAddress(address: string, message: string, signature: string): boolean {
  try {
    const recovered = Secp256k1.recoverAddress({
      payload: PersonalMessage.getSignPayload(Hex.fromString(message)),
      signature: Signature.fromHex(signature as `0x${string}`),
    });
    return recovered.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * viem-backed verifier: plain wallet recovery first, then EIP-1271 and
 * EIP-6492 against Base. Uses `SUBSCRIBE_VERIFY_RPC_URL` when set, else viem's
 * default Base RPC. Accepts an optional `transport` so tests can inject a stub
 * instead of making real network calls.
 *
 * Two things here are load bearing, both verified against the installed viem.
 *
 * The plain wallet check runs first and offline. viem's own `verifyHash` makes
 * the contract call first and only recovers offline in its catch, so an
 * ordinary wallet on a dead RPC would otherwise wait out four attempts at a
 * ten second timeout before being rescued. Recovering first removes the RPC
 * from the ordinary path entirely.
 *
 * The contract call runs behind a watched transport and a catch-all. viem
 * turns most RPC failures into a plain `false`, indistinguishable from a real
 * rejection, but not all of them: the ERC-8010 branch, which any caller can
 * select by appending a fixed 32-byte magic suffix to the signature, calls the
 * RPC with no catch of its own, and a non-canonical bool result throws out of
 * `hexToBool`. Both used to escape as raw viem errors carrying the RPC URL.
 * Now the transport records what failed, the catch-all keeps anything raw from
 * escaping, and the recorded failure decides between "unavailable" and
 * "rejected".
 */
export function viemSignatureVerifier(
  config: Config,
  transport: Transport = http(config.subscribeVerifyRpcUrl || undefined),
): SignatureVerifier {
  return async ({ address, message, signature }) => {
    if (recoversToAddress(address, message, signature)) return true;

    let rpcFailure: unknown;
    const client = createPublicClient({
      chain: base,
      transport: watchTransport(transport, (err) => {
        rpcFailure ??= err;
      }),
    });

    let verified = false;
    try {
      verified = await client.verifyMessage({
        address: address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });
    } catch {
      // Nothing raw escapes. Whether this was an unreachable RPC or a
      // malformed signature is decided below, from what the transport saw.
      verified = false;
    }
    if (verified) return true;

    if (isRpcUnavailable(rpcFailure)) {
      throw new VerifyUnavailableError(
        'Signature verification is unavailable: the Base RPC behind the smart-wallet ' +
          `check did not answer (${describeRpcFailure(rpcFailure)})`,
      );
    }
    return false;
  };
}

export interface SubscriptionVerifier {
  buildChallenge(args: {
    address: string;
    appId: string;
    endpoint: string;
    originHost: string;
  }): { payload: LoginPayload; message: string };
  verifyProof(args: {
    userId: string;
    appId: string;
    endpoint: string;
    originHost: string;
    payload: unknown;
    signature: string;
  }): Promise<boolean>;
}

export function createSubscriptionVerifier(
  config: Config,
  verifySignature: SignatureVerifier = viemSignatureVerifier(config),
): SubscriptionVerifier {
  return {
    buildChallenge({ address, appId, endpoint, originHost }) {
      const now = Date.now();
      const payload: LoginPayload = {
        address: address.toLowerCase(),
        domain: originHost,
        uri: `https://${originHost}`,
        version: '1',
        chain_id: String(config.subscribeVerifyChainId),
        statement: STATEMENT,
        nonce: generateNonce(),
        issued_at: new Date(now).toISOString(),
        expiration_time: new Date(now + CHALLENGE_TTL_MS).toISOString(),
        invalid_before: new Date(now - CHALLENGE_TTL_MS).toISOString(),
        resources: [channelResource(appId, endpoint)],
      };
      return { payload, message: createLoginMessage(payload) };
    },

    async verifyProof({ userId, appId, endpoint, originHost, payload, signature }) {
      const p = payload as LoginPayload | null;
      if (!p || typeof p.address !== 'string') return false;

      // 1. Channel binding: the signed resource must match the submitted endpoint.
      const expected = channelResource(appId, endpoint);
      if (!Array.isArray(p.resources) || !p.resources.includes(expected)) return false;

      // 2. The proven address must equal the userId being subscribed.
      if (p.address.toLowerCase() !== userId.toLowerCase()) return false;

      // 3. Domain (anti-phishing) must match the calling origin host.
      if (p.domain !== originHost) return false;

      // 4. Freshness window.
      const now = Date.now();
      const exp = Date.parse(p.expiration_time ?? '');
      if (Number.isNaN(exp) || exp < now) return false;
      const notBefore = Date.parse(p.invalid_before ?? '');
      if (Number.isNaN(notBefore) || notBefore > now) return false;

      // 5. Cryptographic check (EOA / EIP-1271 / EIP-6492).
      const message = createLoginMessage(p);
      return verifySignature({ address: userId, message, signature });
    },
  };
}

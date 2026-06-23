import { createHash } from 'node:crypto';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
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

// Inferred type of our concrete public client (base chain, http transport).
// Using a helper function lets TypeScript infer the exact return type without
// an explicit `ReturnType<typeof createPublicClient>` annotation, which would
// widen to a generic type and cause assignability errors with the base chain.
type BasePublicClient = ReturnType<typeof makeClient>;
function makeClient(rpcUrl: string) {
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl || undefined),
  });
}

/**
 * viem-backed verifier: EOA `ecrecover`, falling back to EIP-1271 and EIP-6492
 * against Base. EOA verification is offline; the contract paths use the RPC.
 * Uses `SUBSCRIBE_VERIFY_RPC_URL` when set, else viem's default Base RPC.
 */
export function viemSignatureVerifier(config: Config): SignatureVerifier {
  // Lazy singleton: avoid creating the RPC client until first use.
  let client: BasePublicClient | null = null;
  const getClient = (): BasePublicClient => {
    if (!client) {
      client = makeClient(config.subscribeVerifyRpcUrl);
    }
    return client;
  };
  return async ({ address, message, signature }) => {
    try {
      return await getClient().verifyMessage({
        address: address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });
    } catch {
      return false;
    }
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
      if (!p.expiration_time || Date.parse(p.expiration_time) < now) return false;
      if (!p.invalid_before || Date.parse(p.invalid_before) > now) return false;

      // 5. Cryptographic check (EOA / EIP-1271 / EIP-6492).
      const message = createLoginMessage(p);
      return verifySignature({ address: userId, message, signature });
    },
  };
}

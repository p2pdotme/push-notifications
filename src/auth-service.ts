import { createThirdwebClient } from 'thirdweb';
import { createAuth } from 'thirdweb/auth';
import { privateKeyToAccount } from 'thirdweb/wallets';
import type { Config } from './config.js';

/**
 * Wraps thirdweb SIWE auth behind a narrow interface so the HTTP layer never
 * imports thirdweb directly and tests can inject a fake (no network).
 * `payload` is passed through opaquely between client and thirdweb.
 */
export interface AuthService {
  /** Build a login payload for an address (sent to the client to sign). */
  generatePayload(address: string): Promise<unknown>;
  /** Verify a signed payload; on success returns the lowercased address + a JWT. */
  verifyAndIssueJwt(
    payload: unknown,
    signature: string,
  ): Promise<{ address: string; token: string } | null>;
  /** Verify a Bearer JWT; returns the lowercased address or null. */
  verifyJwt(token: string): Promise<{ address: string } | null>;
}

export function createThirdwebAuthService(config: Config): AuthService {
  const client = createThirdwebClient({ secretKey: config.thirdweb.secretKey });
  const auth = createAuth({
    domain: config.thirdweb.authDomain,
    client,
    adminAccount: privateKeyToAccount({
      client,
      privateKey: config.thirdweb.authPrivateKey,
    }),
  });

  return {
    async generatePayload(address) {
      return auth.generatePayload({ address });
    },
    async verifyAndIssueJwt(payload, signature) {
      const verified = await auth.verifyPayload({
        // thirdweb owns this payload shape; we pass it through opaquely.
        payload: payload as Parameters<typeof auth.verifyPayload>[0]['payload'],
        signature,
      });
      if (!verified.valid) return null;
      const token = await auth.generateJWT({ payload: verified.payload });
      return { address: verified.payload.address.toLowerCase(), token };
    },
    async verifyJwt(token) {
      const result = await auth.verifyJWT({ jwt: token });
      if (!result.valid) return null;
      const sub = result.parsedJWT.sub ?? '';
      return sub ? { address: sub.toLowerCase() } : null;
    },
  };
}

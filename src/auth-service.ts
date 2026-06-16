import type { Config } from './config.js';
import {
  createLoginMessage,
  generateNonce,
  recoverSiweAddress,
  type LoginPayload,
} from './siwe.js';
import { issueJwt, verifyJwt } from './jwt.js';

/**
 * SIWE (EIP-4361) auth for the dashboard, with no third-party SDK. The HTTP
 * layer depends only on this interface so tests can inject a fake. `payload` is
 * passed through opaquely between client and this module.
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

const PAYLOAD_TTL_MS = 10 * 60 * 1000; // login payload valid for 10 minutes
const JWT_TTL_SECONDS = 7 * 24 * 60 * 60; // session token valid for 7 days
const DEFAULT_STATEMENT =
  'Please ensure that the domain above matches the URL of the current website.';

export function createAuthService(config: Config): AuthService {
  const { authDomain: domain, jwtSecret: secret } = config;

  return {
    async generatePayload(address) {
      const now = Date.now();
      const payload: LoginPayload = {
        address,
        domain,
        uri: domain,
        version: '1',
        statement: DEFAULT_STATEMENT,
        nonce: generateNonce(),
        issued_at: new Date(now).toISOString(),
        expiration_time: new Date(now + PAYLOAD_TTL_MS).toISOString(),
        invalid_before: new Date(now - PAYLOAD_TTL_MS).toISOString(),
      };
      return payload;
    },

    async verifyAndIssueJwt(payload, signature) {
      const p = payload as LoginPayload | null;
      if (!p || typeof p.address !== 'string') return null;

      const recovered = recoverSiweAddress(p, signature);
      if (!recovered || recovered !== p.address.toLowerCase()) return null;
      if (p.domain !== domain) return null;

      const now = Date.now();
      if (p.expiration_time && Date.parse(p.expiration_time) < now) return null;
      if (p.invalid_before && Date.parse(p.invalid_before) > now) return null;

      return { address: recovered, token: issueJwt(secret, recovered, JWT_TTL_SECONDS) };
    },

    async verifyJwt(token) {
      return verifyJwt(secret, token);
    },
  };
}

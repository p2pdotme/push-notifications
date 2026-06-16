import { createHash, randomBytes } from 'node:crypto';

/** A freshly minted API key. The plaintext `secret` is shown to the admin once. */
export interface GeneratedApiKey {
  secret: string;
  keyHash: string;
  keyPrefix: string;
}

/** SHA-256 hex digest of an API key secret. Stored instead of the plaintext. */
export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Mint a random `pk_…` secret plus its hash and a short display prefix. */
export function generateApiKey(): GeneratedApiKey {
  const secret = `pk_${randomBytes(24).toString('hex')}`;
  return {
    secret,
    keyHash: hashApiKey(secret),
    keyPrefix: secret.slice(0, 10),
  };
}

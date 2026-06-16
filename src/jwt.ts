import { createHmac, timingSafeEqual } from 'node:crypto';

/** HMAC-SHA256 over `data` keyed by `secret`, base64url-encoded. */
function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

const encode = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj)).toString('base64url');

/** Issue an HS256 JWT carrying `sub` (the address), valid for `ttlSeconds`. */
export function issueJwt(secret: string, sub: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub, iat: now, exp: now + ttlSeconds });
  const data = `${header}.${payload}`;
  return `${data}.${sign(data, secret)}`;
}

/** Verify an HS256 JWT: signature (constant-time), structure, and expiry. */
export function verifyJwt(secret: string, token: string): { address: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, providedSig] = parts;

  const expectedSig = sign(`${header}.${payload}`, secret);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
    if (Math.floor(Date.now() / 1000) >= claims.exp) return null;
    return { address: claims.sub.toLowerCase() };
  } catch {
    return null;
  }
}

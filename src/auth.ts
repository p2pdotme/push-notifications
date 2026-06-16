import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import type { AuthContext, AdminAuthContext } from './types.js';
import { hashApiKey } from './api-keys.js';
import type { Repository } from './repository.js';
import type { AuthService } from './auth-service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      admin?: AdminAuthContext;
    }
  }
}

/** Constant-time string comparison to avoid leaking key length/content via timing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Resolves the `x-api-key` header into an AuthContext. The admin key (env) may
 * act on any app; otherwise the key is looked up by hash in the DB and scoped to
 * its app. Sending endpoints require this middleware; browser subscribe does not.
 */
export function apiKeyAuth(config: Config, repo: Repository) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const provided = req.header('x-api-key');
    if (!provided) {
      res.status(401).json({ error: 'Missing x-api-key header' });
      return;
    }

    if (safeEqual(provided, config.adminApiKey)) {
      req.auth = { isAdmin: true, appId: null };
      next();
      return;
    }

    const key = repo.findActiveApiKeyByHash(hashApiKey(provided));
    if (key) {
      repo.touchApiKey(key.id);
      req.auth = { isAdmin: false, appId: key.appId };
      next();
      return;
    }

    res.status(403).json({ error: 'Invalid API key' });
  };
}

/**
 * Ensures the authenticated caller is allowed to act on `appId`. Admin keys
 * may target any app; app keys only their own.
 */
export function assertAppAccess(auth: AuthContext | undefined, appId: string): void {
  if (!auth) {
    throw new HttpError(401, 'Not authenticated');
  }
  if (auth.isAdmin) return;
  if (auth.appId !== appId) {
    throw new HttpError(403, `Key is not authorized for app "${appId}"`);
  }
}

/** Lightweight error carrying an HTTP status, handled by the error middleware. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** True when an address is a bootstrap (env) admin or a DB-managed admin. */
export function isAdminAddress(address: string, config: Config, repo: Repository): boolean {
  const lower = address.toLowerCase();
  return config.adminWallets.includes(lower) || repo.isDbAdmin(lower);
}

/**
 * Verifies a Bearer JWT and ensures the address is whitelisted. Populates
 * `req.admin`. 401 when the token is missing/invalid, 403 when not an admin.
 */
export function requireAdmin(config: Config, repo: Repository, authService: AuthService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Self-guarding: Express 4 does not catch rejected promises from middleware,
    // so any throw here must be funnelled to the centralised error handler — a
    // bare rejection would hang the request and surface as an unhandledRejection.
    try {
      const header = req.header('authorization');
      const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) {
        res.status(401).json({ error: 'Missing Bearer token' });
        return;
      }
      const verified = await authService.verifyJwt(token);
      if (!verified) {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }
      if (!isAdminAddress(verified.address, config, repo)) {
        res.status(403).json({ error: 'Wallet not authorized' });
        return;
      }
      req.admin = { address: verified.address };
      next();
    } catch (err) {
      next(err);
    }
  };
}

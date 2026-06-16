import { Router } from 'express';
import { asyncHandler } from '../async-handler.js';
import { isAdminAddress } from '../auth.js';
import type { AuthService } from '../auth-service.js';
import type { Config } from '../config.js';
import type { Repository } from '../repository.js';

/**
 * thirdweb SIWE auth for the dashboard. `/payload` and `/login` are public;
 * `/me` requires a Bearer token. A non-whitelisted login returns 403 plus the
 * resolved address so the UI can show a bootstrap hint.
 */
export function authRouter(
  config: Config,
  repo: Repository,
  authService: AuthService,
): Router {
  const router = Router();

  router.get('/payload', asyncHandler(async (req, res) => {
    const address = String(req.query.address ?? '');
    if (!address) {
      res.status(400).json({ error: 'address query parameter is required' });
      return;
    }
    res.json(await authService.generatePayload(address));
  }));

  router.post('/login', asyncHandler(async (req, res) => {
    const { payload, signature } = req.body ?? {};
    if (payload == null || typeof signature !== 'string') {
      res.status(400).json({ error: 'payload and signature are required' });
      return;
    }
    const result = await authService.verifyAndIssueJwt(payload, signature);
    if (!result) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
    if (!isAdminAddress(result.address, config, repo)) {
      res.status(403).json({ error: 'Wallet not authorized', address: result.address });
      return;
    }
    res.json({ token: result.token, address: result.address, isAdmin: true });
  }));

  router.get('/me', asyncHandler(async (req, res) => {
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
    res.json({ address: verified.address, isAdmin: isAdminAddress(verified.address, config, repo) });
  }));

  return router;
}

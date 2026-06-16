import { Router } from 'express';
import { asyncHandler } from '../async-handler.js';
import { HttpError, requireAdmin } from '../auth.js';
import { generateApiKey } from '../api-keys.js';
import type { AuthService } from '../auth-service.js';
import type { Config } from '../config.js';
import type { Repository } from '../repository.js';
import {
  addAdminSchema,
  addOriginSchema,
  createAppSchema,
  createKeySchema,
  updateAppSchema,
} from '../schemas.js';

/** Wallet-gated CRUD for apps, API keys, CORS origins, and admins. */
export function adminRouter(
  config: Config,
  repo: Repository,
  authService: AuthService,
): Router {
  const router = Router();
  router.use(requireAdmin(config, repo, authService));

  // --- Apps -----------------------------------------------------------------
  router.get('/apps', (_req, res) => res.json(repo.listApps()));

  router.post('/apps', (req, res) => {
    const body = createAppSchema.parse(req.body);
    if (repo.getApp(body.appId)) throw new HttpError(409, `App "${body.appId}" already exists`);
    res.status(201).json(repo.createApp(body));
  });

  router.patch('/apps/:appId', (req, res) => {
    const patch = updateAppSchema.parse(req.body);
    const updated = repo.updateApp(req.params.appId as string, patch);
    if (!updated) throw new HttpError(404, 'App not found');
    res.json(updated);
  });

  router.delete('/apps/:appId', (req, res) => {
    if (!repo.deleteApp(req.params.appId as string)) throw new HttpError(404, 'App not found');
    res.sendStatus(204);
  });

  // --- API keys -------------------------------------------------------------
  router.get('/apps/:appId/keys', (req, res) => {
    const appId = req.params.appId as string;
    if (!repo.getApp(appId)) throw new HttpError(404, 'App not found');
    res.json(repo.listApiKeys(appId));
  });

  router.post('/apps/:appId/keys', (req, res) => {
    const appId = req.params.appId as string;
    if (!repo.getApp(appId)) throw new HttpError(404, 'App not found');
    const body = createKeySchema.parse(req.body);
    const gen = generateApiKey();
    const rec = repo.createApiKey({
      appId,
      keyHash: gen.keyHash,
      keyPrefix: gen.keyPrefix,
      label: body.label ?? null,
      createdBy: req.admin?.address ?? null,
    });
    // The plaintext secret is returned exactly once.
    res.status(201).json({ ...rec, secret: gen.secret });
  });

  router.delete('/keys/:id', (req, res) => {
    if (!repo.revokeApiKey(Number(req.params.id))) throw new HttpError(404, 'Key not found');
    res.sendStatus(204);
  });

  // --- CORS origins ---------------------------------------------------------
  router.get('/apps/:appId/origins', (req, res) => {
    const appId = req.params.appId as string;
    if (!repo.getApp(appId)) throw new HttpError(404, 'App not found');
    res.json(repo.listCorsOrigins(appId));
  });

  router.post('/apps/:appId/origins', (req, res) => {
    const appId = req.params.appId as string;
    if (!repo.getApp(appId)) throw new HttpError(404, 'App not found');
    const body = addOriginSchema.parse(req.body);
    res.status(201).json(repo.addCorsOrigin({ appId, origin: body.origin }));
  });

  router.delete('/origins/:id', (req, res) => {
    if (!repo.deleteCorsOrigin(Number(req.params.id))) throw new HttpError(404, 'Origin not found');
    res.sendStatus(204);
  });

  // --- Admins ---------------------------------------------------------------
  router.get('/admins', (_req, res) => {
    res.json({ bootstrap: config.adminWallets, managed: repo.listAdmins() });
  });

  router.post('/admins', (req, res) => {
    const body = addAdminSchema.parse(req.body);
    res.status(201).json(
      repo.addAdmin({ address: body.address, label: body.label ?? null, addedBy: req.admin?.address ?? null }),
    );
  });

  router.delete('/admins/:address', (req, res) => {
    if (!repo.removeAdmin(req.params.address as string)) throw new HttpError(404, 'Admin not found');
    res.sendStatus(204);
  });

  return router;
}

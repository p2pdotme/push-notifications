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

export function adminRouter(config: Config, repo: Repository, authService: AuthService): Router {
  const router = Router();
  router.use(requireAdmin(config, repo, authService));

  router.get('/apps', asyncHandler(async (_req, res) => {
    res.json(await repo.listApps());
  }));

  router.post('/apps', asyncHandler(async (req, res) => {
    const body = createAppSchema.parse(req.body);
    if (await repo.getApp(body.appId)) throw new HttpError(409, `App "${body.appId}" already exists`);
    res.status(201).json(await repo.createApp(body));
  }));

  router.patch('/apps/:appId', asyncHandler(async (req, res) => {
    const patch = updateAppSchema.parse(req.body);
    const updated = await repo.updateApp(req.params.appId as string, patch);
    if (!updated) throw new HttpError(404, 'App not found');
    res.json(updated);
  }));

  router.delete('/apps/:appId', asyncHandler(async (req, res) => {
    if (!(await repo.deleteApp(req.params.appId as string))) throw new HttpError(404, 'App not found');
    res.sendStatus(204);
  }));

  router.get('/apps/:appId/keys', asyncHandler(async (req, res) => {
    const appId = req.params.appId as string;
    if (!(await repo.getApp(appId))) throw new HttpError(404, 'App not found');
    res.json(await repo.listApiKeys(appId));
  }));

  router.post('/apps/:appId/keys', asyncHandler(async (req, res) => {
    const appId = req.params.appId as string;
    if (!(await repo.getApp(appId))) throw new HttpError(404, 'App not found');
    const body = createKeySchema.parse(req.body);
    const gen = generateApiKey();
    const rec = await repo.createApiKey({
      appId,
      keyHash: gen.keyHash,
      keyPrefix: gen.keyPrefix,
      label: body.label ?? null,
      createdBy: req.admin?.address ?? null,
    });
    res.status(201).json({ ...rec, secret: gen.secret });
  }));

  router.delete('/keys/:id', asyncHandler(async (req, res) => {
    if (!(await repo.revokeApiKey(Number(req.params.id)))) throw new HttpError(404, 'Key not found');
    res.sendStatus(204);
  }));

  router.get('/apps/:appId/origins', asyncHandler(async (req, res) => {
    const appId = req.params.appId as string;
    if (!(await repo.getApp(appId))) throw new HttpError(404, 'App not found');
    res.json(await repo.listCorsOrigins(appId));
  }));

  router.post('/apps/:appId/origins', asyncHandler(async (req, res) => {
    const appId = req.params.appId as string;
    if (!(await repo.getApp(appId))) throw new HttpError(404, 'App not found');
    const body = addOriginSchema.parse(req.body);
    res.status(201).json(await repo.addCorsOrigin({ appId, origin: body.origin }));
  }));

  router.delete('/origins/:id', asyncHandler(async (req, res) => {
    if (!(await repo.deleteCorsOrigin(Number(req.params.id)))) throw new HttpError(404, 'Origin not found');
    res.sendStatus(204);
  }));

  router.get('/admins', asyncHandler(async (_req, res) => {
    res.json({ bootstrap: config.adminWallets, managed: await repo.listAdmins() });
  }));

  router.post('/admins', asyncHandler(async (req, res) => {
    const body = addAdminSchema.parse(req.body);
    res.status(201).json(
      await repo.addAdmin({ address: body.address, label: body.label ?? null, addedBy: req.admin?.address ?? null }),
    );
  }));

  router.delete('/admins/:address', asyncHandler(async (req, res) => {
    if (!(await repo.removeAdmin(req.params.address as string))) throw new HttpError(404, 'Admin not found');
    res.sendStatus(204);
  }));

  return router;
}

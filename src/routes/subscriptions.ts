import { Router } from 'express';
import { assertAppAccess } from '../auth.js';
import { subscribeSchema, unsubscribeSchema } from '../schemas.js';
import type { AppContext } from '../server.js';

/**
 * Browser-facing subscription management. `POST /subscriptions` is called from
 * the client SDK after the user grants permission. It is intentionally not
 * behind an API key (browsers can't hold secrets), but it IS scoped to an
 * appId and rate-limited at the edge in production. `DELETE` removes a channel.
 */
export function subscriptionsRouter(ctx: AppContext): Router {
  const router = Router();

  router.post('/', (req, res) => {
    const parsed = subscribeSchema.parse(req.body);
    const record = ctx.repo.upsertSubscription({
      appId: parsed.appId,
      userId: parsed.userId ?? null,
      subscription: parsed.subscription,
      userAgent: req.header('user-agent') ?? null,
    });
    res.status(201).json({ id: record.id, appId: record.appId });
  });

  router.delete('/', (req, res) => {
    const parsed = unsubscribeSchema.parse(req.body);
    const removed = ctx.repo.deleteByEndpoint(parsed.endpoint);
    res.json({ removed });
  });

  // Admin/app-scoped: subscription counts for an app.
  router.get('/stats/:appId', ctx.requireApiKey, (req, res) => {
    const appId = req.params.appId as string;
    assertAppAccess(req.auth, appId);
    res.json(ctx.repo.countSubscriptions(appId));
  });

  return router;
}

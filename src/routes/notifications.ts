import { Router } from 'express';
import { asyncHandler } from '../async-handler.js';
import { assertAppAccess } from '../auth.js';
import { sendSchema } from '../schemas.js';
import type { SubscriptionRecord } from '../types.js';
import type { AppContext } from '../server.js';

/**
 * Server-to-server delivery API. All routes require a valid API key; an app key
 * may only target its own appId, the admin key may target any.
 */
export function notificationsRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(ctx.requireApiKey);

  router.post('/send', asyncHandler(async (req, res) => {
    const body = sendSchema.parse(req.body);
    assertAppAccess(req.auth, body.appId);

    // Resolve the target set of subscriptions.
    let targets: SubscriptionRecord[];
    if (body.broadcast) {
      targets = ctx.repo.findActive(body.appId);
    } else {
      const userIds = body.userIds ?? (body.userId ? [body.userId] : []);
      targets = userIds.flatMap((uid) => ctx.repo.findActive(body.appId, uid));
    }

    if (targets.length === 0) {
      res.status(404).json({ error: 'No active subscriptions matched the target' });
      return;
    }

    const summary = await ctx.sender.sendToMany(targets, body.notification, {
      ttl: body.ttl,
      urgency: body.urgency,
    });
    res.json(summary);
  }));

  router.get('/logs/:appId', (req, res) => {
    const appId = req.params.appId as string;
    assertAppAccess(req.auth, appId);
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    res.json(ctx.repo.recentLogs(appId, limit));
  });

  return router;
}

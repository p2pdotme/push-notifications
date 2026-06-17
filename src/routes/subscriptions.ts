import { Router } from 'express';
import { asyncHandler } from '../async-handler.js';
import { assertAppAccess, HttpError } from '../auth.js';
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

  router.post('/', asyncHandler(async (req, res) => {
    const parsed = subscribeSchema.parse(req.body);
    const origin = req.header('origin');
    if (origin && !(await ctx.repo.isOriginAllowedForApp(parsed.appId, origin))) {
      throw new HttpError(403, `Origin ${origin} is not allowed for app "${parsed.appId}"`);
    }
    const record = await ctx.repo.upsertSubscription({
      appId: parsed.appId,
      userId: parsed.userId ?? null,
      subscription: parsed.subscription,
      userAgent: req.header('user-agent') ?? null,
    });
    res.status(201).json({ id: record.id, appId: record.appId });
  }));

  router.delete('/', asyncHandler(async (req, res) => {
    const parsed = unsubscribeSchema.parse(req.body);
    const removed = await ctx.repo.deleteByEndpoint(parsed.endpoint);
    res.json({ removed });
  }));

  router.get('/stats/:appId', ctx.requireApiKey, asyncHandler(async (req, res) => {
    const appId = req.params.appId as string;
    assertAppAccess(req.auth, appId);
    res.json(await ctx.repo.countSubscriptions(appId));
  }));

  return router;
}

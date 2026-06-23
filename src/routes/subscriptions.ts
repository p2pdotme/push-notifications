import { Router } from 'express';
import { asyncHandler } from '../async-handler.js';
import { assertAppAccess, HttpError } from '../auth.js';
import { subscribeSchema, subscriptionChallengeSchema, unsubscribeSchema } from '../schemas.js';
import type { AppContext } from '../server.js';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Browser-facing subscription management. `POST /subscriptions` registers a
 * channel; when the target app enables `require_subscription_signature`, the
 * caller must prove control of the wallet `userId` with a signed challenge
 * obtained from `POST /subscriptions/challenge`. The endpoint is otherwise
 * unauthenticated (browsers can't hold API keys) but is origin-checked.
 */
export function subscriptionsRouter(ctx: AppContext): Router {
  const router = Router();

  router.post('/challenge', asyncHandler(async (req, res) => {
    const parsed = subscriptionChallengeSchema.parse(req.body);
    const origin = req.header('origin');
    if (!origin || !(await ctx.repo.isOriginAllowedForApp(parsed.appId, origin))) {
      throw new HttpError(403, `Origin ${origin ?? '(none)'} is not allowed for app "${parsed.appId}"`);
    }
    const { payload, message } = ctx.verifier.buildChallenge({
      address: parsed.address,
      appId: parsed.appId,
      endpoint: parsed.endpoint,
      originHost: new URL(origin).host,
    });
    res.json({ payload, message });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const parsed = subscribeSchema.parse(req.body);
    const origin = req.header('origin');
    if (origin && !(await ctx.repo.isOriginAllowedForApp(parsed.appId, origin))) {
      throw new HttpError(403, `Origin ${origin} is not allowed for app "${parsed.appId}"`);
    }

    const app = await ctx.repo.getApp(parsed.appId);
    let verifiedAt: string | null = null;

    if (app?.requireSubscriptionSignature) {
      const userId = parsed.userId ?? null;
      if (!userId || !ADDRESS_RE.test(userId)) {
        throw new HttpError(401, 'A wallet signature is required to subscribe', 'signature_required');
      }

      if (parsed.payload && parsed.signature) {
        if (!origin) throw new HttpError(403, 'Origin header is required to verify a subscription signature');
        const ok = await ctx.verifier.verifyProof({
          userId,
          appId: parsed.appId,
          endpoint: parsed.subscription.endpoint,
          originHost: new URL(origin).host,
          payload: parsed.payload,
          signature: parsed.signature,
        });
        if (!ok) throw new HttpError(401, 'Invalid wallet signature', 'invalid_signature');
        verifiedAt = new Date().toISOString();
      } else {
        // Allow an unsigned refresh of an already-verified (endpoint, userId).
        const existing = await ctx.repo.getSubscriptionByEndpoint(parsed.subscription.endpoint);
        const sameUser = !!existing?.userId && existing.userId.toLowerCase() === userId.toLowerCase();
        const sameApp = existing?.appId === parsed.appId;
        if (!existing || !sameUser || !sameApp || !existing.verifiedAt) {
          throw new HttpError(401, 'A wallet signature is required to subscribe', 'signature_required');
        }
        // verifiedAt stays null; the upsert's COALESCE preserves the prior timestamp.
      }
    }

    const record = await ctx.repo.upsertSubscription({
      appId: parsed.appId,
      userId: parsed.userId ?? null,
      subscription: parsed.subscription,
      userAgent: req.header('user-agent') ?? null,
      verifiedAt,
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

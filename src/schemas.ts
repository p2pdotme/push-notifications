import { z } from 'zod';

/** Validation schemas for request bodies. Keeps untrusted input honest. */

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

/** EIP-4361 SIWE payload the client signs to prove wallet control. */
export const siwePayloadSchema = z.object({
  domain: z.string().min(1),
  address: z.string().min(1),
  statement: z.string().optional(),
  uri: z.string().optional(),
  version: z.string().min(1),
  chain_id: z.string().optional(),
  nonce: z.string().min(1),
  issued_at: z.string().min(1),
  expiration_time: z.string().min(1),
  invalid_before: z.string().min(1),
  resources: z.array(z.string()).optional(),
});

export const subscribeSchema = z.object({
  appId: z.string().min(1),
  userId: z.string().min(1).nullable().optional(),
  subscription: pushSubscriptionSchema,
  /** Optional proof-of-ownership (required when the app enables signatures). */
  payload: siwePayloadSchema.optional(),
  signature: z.string().min(1).optional(),
});

export const subscriptionChallengeSchema = z.object({
  appId: z.string().min(1),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'address must be a 0x-prefixed 40-hex string'),
  endpoint: z.string().url(),
});

export const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

export const notificationPayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  icon: z.string().optional(),
  badge: z.string().optional(),
  image: z.string().optional(),
  url: z.string().optional(),
  tag: z.string().optional(),
  requireInteraction: z.boolean().optional(),
  silent: z.boolean().optional(),
  data: z.record(z.unknown()).optional(),
  actions: z
    .array(
      z.object({
        action: z.string(),
        title: z.string(),
        icon: z.string().optional(),
      }),
    )
    .optional(),
});

export const sendSchema = z
  .object({
    appId: z.string().min(1),
    /** Target a single user. */
    userId: z.string().min(1).optional(),
    /** Target several users in one call. */
    userIds: z.array(z.string().min(1)).optional(),
    /** Send to every active subscription of the app. */
    broadcast: z.boolean().optional(),
    notification: notificationPayloadSchema,
    ttl: z.number().int().min(0).optional(),
    urgency: z.enum(['very-low', 'low', 'normal', 'high']).optional(),
  })
  .refine(
    (v) => v.broadcast || v.userId || (v.userIds && v.userIds.length > 0),
    { message: 'Specify one of: userId, userIds, or broadcast=true' },
  );

export type SendRequest = z.infer<typeof sendSchema>;

export const createAppSchema = z.object({
  appId: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'appId must be lowercase alphanumeric/hyphen'),
  name: z.string().min(1).max(120),
});

export const updateAppSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    disabled: z.boolean().optional(),
    requireSubscriptionSignature: z.boolean().optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.disabled !== undefined || v.requireSubscriptionSignature !== undefined,
    { message: 'Provide at least one of: name, disabled, requireSubscriptionSignature' },
  );

export const createKeySchema = z.object({ label: z.string().min(1).max(120).optional() });

export const addOriginSchema = z.object({ origin: z.string().url() });

export const addAdminSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'address must be a 0x-prefixed 40-hex string'),
  label: z.string().min(1).max(120).optional(),
});

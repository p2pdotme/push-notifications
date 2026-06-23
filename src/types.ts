/**
 * Shared types for the push notification service.
 */

/** A Web Push subscription as produced by the browser PushManager. */
export interface PushSubscriptionJSON {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/** Notification payload delivered to the service worker. */
export interface NotificationPayload {
  title: string;
  body?: string;
  icon?: string;
  badge?: string;
  image?: string;
  /** URL opened when the notification is clicked. */
  url?: string;
  /** Tag used to collapse/replace notifications with the same tag. */
  tag?: string;
  /** Require the user to dismiss the notification manually. */
  requireInteraction?: boolean;
  /** Send silently (no sound/vibration). */
  silent?: boolean;
  /** Arbitrary structured data passed through to the client. */
  data?: Record<string, unknown>;
  /** Action buttons. */
  actions?: { action: string; title: string; icon?: string }[];
}

/** A stored subscription row. */
export interface SubscriptionRecord {
  id: number;
  appId: string;
  userId: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
  failureCount: number;
  disabled: number;
  /** When the subscriber proved control of `userId` via signature; null if unverified. */
  verifiedAt: string | null;
}

/** Identity resolved from an API key. */
export interface AuthContext {
  /** True when authenticated with the admin key (may target any app). */
  isAdmin: boolean;
  /** The appId this key is scoped to, or null for admin. */
  appId: string | null;
}

/** A managed application (tenant). */
export interface AppRecord {
  appId: string;
  name: string;
  disabled: boolean;
  /** When true, subscribing under a wallet address requires a valid signature. */
  requireSubscriptionSignature: boolean;
  createdAt: string;
}

/** API key metadata — never includes the secret or its hash. */
export interface ApiKeyRecord {
  id: number;
  appId: string;
  keyPrefix: string;
  label: string | null;
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** A per-app allowed browser origin. */
export interface CorsOriginRecord {
  id: number;
  appId: string;
  origin: string;
  createdAt: string;
}

/** A DB-managed admin wallet. */
export interface AdminRecord {
  address: string;
  label: string | null;
  addedBy: string | null;
  createdAt: string;
}

/** Identity resolved from an admin Bearer JWT. */
export interface AdminAuthContext {
  address: string;
}

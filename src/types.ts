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
}

/** Identity resolved from an API key. */
export interface AuthContext {
  /** True when authenticated with the admin key (may target any app). */
  isAdmin: boolean;
  /** The appId this key is scoped to, or null for admin. */
  appId: string | null;
}

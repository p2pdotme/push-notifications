/**
 * @p2pdotme/push-client/react
 *
 * One hook for the whole Web Push lifecycle. Drop it into any React app:
 *
 *   const push = usePush({ serverUrl: 'https://push.p2p.me', appId: 'user-app', userId });
 *   <button disabled={!push.supported} onClick={push.subscribe}>Enable notifications</button>
 *
 * `react` is an optional peer dependency — only needed if you import this entry.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PushClient, isPushSupported, type PushClientOptions } from './index.js';

export interface UsePushOptions extends PushClientOptions {
  /** User to associate the subscription with, so the backend can target them. */
  userId?: string;
  /** Sign the challenge to prove wallet control (required for signature-enabled apps). */
  signMessage?: (message: string) => Promise<string>;
}

export interface UsePush {
  /** Whether this browser supports Web Push at all. */
  supported: boolean;
  /** Current Notification permission ('default' | 'granted' | 'denied'). */
  permission: NotificationPermission;
  /** Whether an active push subscription exists for this browser. */
  subscribed: boolean;
  /** True while subscribe()/unsubscribe() is in flight. */
  loading: boolean;
  /** The last error thrown by subscribe()/unsubscribe(), if any. */
  error: Error | null;
  /** Request permission, subscribe, and sync with the server. */
  subscribe: () => Promise<void>;
  /** Remove the subscription locally and on the server. */
  unsubscribe: () => Promise<void>;
}

/**
 * Manage the push subscription for the current browser. The underlying
 * PushClient is memoized from the connection options; changing `userId` (or any
 * option) re-creates it.
 */
export function usePush(options: UsePushOptions): UsePush {
  const { userId, signMessage, serverUrl, appId, serviceWorkerUrl, vapidPublicKey } = options;

  const client = useMemo(
    () => new PushClient({ serverUrl, appId, serviceWorkerUrl, vapidPublicKey }),
    [serverUrl, appId, serviceWorkerUrl, vapidPublicKey],
  );

  const [supported] = useState(isPushSupported);
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    supported ? Notification.permission : 'denied',
  );
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Reflect any pre-existing subscription on mount.
  useEffect(() => {
    if (!supported) return;
    let active = true;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => active && setSubscribed(Boolean(sub)))
      .catch(() => active && setSubscribed(false));
    return () => {
      active = false;
    };
  }, [supported]);

  const subscribe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await client.subscribe(userId, { signMessage });
      setPermission(Notification.permission);
      setSubscribed(true);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [client, userId, signMessage]);

  const unsubscribe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await client.unsubscribe();
      setSubscribed(false);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [client]);

  return { supported, permission, subscribed, loading, error, subscribe, unsubscribe };
}

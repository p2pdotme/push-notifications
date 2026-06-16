/**
 * Example React hook wrapping @p2pdotme/push-client. Copy into any p2p.me
 * frontend. Assumes `push-sw.js` (the example service worker) is served from
 * the site root.
 */
import { useCallback, useEffect, useState } from 'react';
import { PushClient, isPushSupported } from '@p2pdotme/push-client';

const client = new PushClient({
  serverUrl: import.meta.env.VITE_PUSH_URL ?? 'https://push.p2p.me',
  appId: 'user-app',
  serviceWorkerUrl: '/push-sw.js',
});

export function usePushNotifications(userId?: string) {
  const [supported] = useState(isPushSupported());
  const [permission, setPermission] = useState<NotificationPermission>(
    supported ? Notification.permission : 'denied',
  );
  const [subscribed, setSubscribed] = useState(false);

  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribed(Boolean(sub)))
      .catch(() => setSubscribed(false));
  }, [supported]);

  const enable = useCallback(async () => {
    await client.subscribe(userId);
    setPermission(Notification.permission);
    setSubscribed(true);
  }, [userId]);

  const disable = useCallback(async () => {
    await client.unsubscribe();
    setSubscribed(false);
  }, []);

  return { supported, permission, subscribed, enable, disable };
}

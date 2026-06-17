/**
 * React usage. The `usePush` hook ships in the package itself — no need to copy
 * this file; it's just a worked example. Assumes `push-sw.js` (the example
 * service worker) is served from the site root.
 */
import { usePush } from '@p2pdotme/push-client/react';

export function NotificationToggle({ userId }: { userId?: string }) {
  const push = usePush({
    serverUrl: import.meta.env.VITE_PUSH_URL ?? 'https://push.p2p.me',
    appId: 'user-app',
    serviceWorkerUrl: '/push-sw.js',
    userId,
  });

  if (!push.supported) return <p>Push notifications aren't supported here.</p>;

  return (
    <button
      disabled={push.loading}
      onClick={push.subscribed ? push.unsubscribe : push.subscribe}
    >
      {push.subscribed ? 'Disable' : 'Enable'} notifications
    </button>
  );
}

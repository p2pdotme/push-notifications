/* eslint-disable no-restricted-globals */
/**
 * Example service worker for @p2pdotme/push-client.
 *
 * Copy this to your app's public root (e.g. /public/push-sw.js) so it is served
 * from the origin root scope, then point PushClient.serviceWorkerUrl at it.
 *
 * It receives the encrypted payload pushed by the server, renders a system
 * notification, and routes clicks to the target URL — focusing an existing tab
 * when one is already open.
 */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    payload = { title: 'Notification', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'Notification';
  const options = {
    body: payload.body,
    icon: payload.icon,
    badge: payload.badge,
    image: payload.image,
    tag: payload.tag,
    requireInteraction: payload.requireInteraction,
    silent: payload.silent,
    actions: payload.actions,
    // Stash routing info for the click handler.
    data: { url: payload.url, ...(payload.data || {}) },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Only follow http(s) / same-origin URLs from the (untrusted) push payload;
  // ignore javascript:, data:, and other schemes before focus/openWindow.
  let targetUrl = '/';
  const raw = (event.notification.data && event.notification.data.url) || '/';
  try {
    const u = new URL(raw, self.location.origin);
    if (u.protocol === 'https:' || u.protocol === 'http:') targetUrl = u.href;
  } catch (err) {
    targetUrl = '/';
  }

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client && client.url === targetUrl) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
        return undefined;
      }),
  );
});

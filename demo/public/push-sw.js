/* eslint-disable no-restricted-globals */
// Service worker for the push demo. Renders the encrypted payload pushed by the
// server as a system notification and routes clicks to the target URL.
// (Copied from client/service-worker.js.)

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
    data: { url: payload.url, ...(payload.data || {}) },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

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

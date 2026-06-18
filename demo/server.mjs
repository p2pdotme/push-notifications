// Demo backend: serves the PWA static files and forwards trigger requests to the
// push service with the app key (kept server-side, never exposed to the browser).
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Where this backend reaches the push service (server-to-server).
const PUSH_URL = process.env.PUSH_URL ?? 'https://push.lmao.cl';
// The public URL the BROWSER uses to subscribe against the push service.
const PUSH_PUBLIC_URL = process.env.PUSH_PUBLIC_URL ?? PUSH_URL;
const API_KEY = process.env.PUSH_API_KEY;
const APP_ID = process.env.PUSH_APP_ID ?? 'demo-app';
const PORT = Number(process.env.PORT ?? 3000);

if (!API_KEY) {
  // Fail fast: without the key the trigger endpoints can't authenticate.
  throw new Error('PUSH_API_KEY is required');
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '16kb' }));

// Frontend config: tells the PWA which push service to subscribe against and as
// which app. The browser talks to the push service directly (cross-origin);
// this server only proxies the authenticated /api trigger below.
app.get('/config.json', (_req, res) => {
  res.json({ pushBase: PUSH_PUBLIC_URL, appId: APP_ID });
});

app.use(express.static(path.join(dir, 'public')));

/** Forward a send to the push service and relay its summary. */
async function send(notification, target) {
  const res = await fetch(`${PUSH_URL}/notifications/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ appId: APP_ID, ...target, notification }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function notificationFrom(body) {
  return {
    title: (body?.title || 'Demo notification').slice(0, 120),
    body: (body?.body || '').slice(0, 300),
    icon: '/icon.svg',
    url: '/',
  };
}

app.post('/api/trigger', async (req, res) => {
  const userId = req.body?.userId;
  if (!userId || typeof userId !== 'string') {
    res.status(400).json({ error: 'userId is required' });
    return;
  }
  const { status, data } = await send(notificationFrom(req.body), { userId });
  res.status(status).json(data);
});

app.post('/api/broadcast', async (req, res) => {
  const { status, data } = await send(notificationFrom(req.body), { broadcast: true });
  res.status(status).json(data);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`push-demo listening on http://0.0.0.0:${PORT} -> ${PUSH_URL} (app ${APP_ID})`);
});

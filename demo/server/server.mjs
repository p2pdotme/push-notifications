// Demo backend: serves the PWA and forwards trigger requests to the push service
// using the @p2pdotme/push-client SDK (PushServer). The app key stays server-side.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PushServer, PushSendError } from '@p2pdotme/push-client/server';

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

const push = new PushServer({ serverUrl: PUSH_URL, apiKey: API_KEY, appId: APP_ID });

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

function notificationFrom(body) {
  return {
    title: (body?.title || 'Demo notification').slice(0, 120),
    body: (body?.body || '').slice(0, 300),
    icon: '/icon.svg',
    url: '/',
  };
}

/** Run a PushServer send and relay its summary, mapping SDK errors to HTTP. */
async function relay(res, run) {
  try {
    res.json(await run());
  } catch (err) {
    if (err instanceof PushSendError) {
      res.status(err.status).json(err.body ?? { error: err.message });
      return;
    }
    res.status(502).json({ error: String(err?.message ?? err) });
  }
}

app.post('/api/trigger', (req, res) => {
  const userId = req.body?.userId;
  if (!userId || typeof userId !== 'string') {
    res.status(400).json({ error: 'userId is required' });
    return;
  }
  relay(res, () => push.sendToUser(userId, notificationFrom(req.body)));
});

app.post('/api/broadcast', (req, res) => {
  relay(res, () => push.broadcast(notificationFrom(req.body)));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`push-demo (SDK) listening on :${PORT} -> ${PUSH_URL} (app ${APP_ID})`);
});

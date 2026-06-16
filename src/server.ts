import express, {
  type Application,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { ZodError } from 'zod';
import { apiKeyAuth, HttpError } from './auth.js';
import type { Config } from './config.js';
import type { Repository } from './repository.js';
import type { PushSender } from './webpush.js';
import { subscriptionsRouter } from './routes/subscriptions.js';
import { notificationsRouter } from './routes/notifications.js';

/** Shared dependencies handed to each router. */
export interface AppContext {
  config: Config;
  repo: Repository;
  sender: PushSender;
  /** API-key middleware, reused by app-scoped routes. */
  requireApiKey: ReturnType<typeof apiKeyAuth>;
}

/** Minimal CORS handling for the browser-facing endpoints. */
function cors(origins: string[]) {
  const allowAll = origins.includes('*');
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header('origin');
    if (allowAll) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-api-key');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

export function createServer(
  config: Config,
  repo: Repository,
  sender: PushSender,
): Application {
  const ctx: AppContext = {
    config,
    repo,
    sender,
    requireApiKey: apiKeyAuth(config, repo),
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(cors(config.corsOrigins));

  // Liveness + the VAPID public key clients need to subscribe.
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/vapid-public-key', (_req, res) =>
    res.json({ publicKey: config.vapid.publicKey }),
  );

  app.use('/subscriptions', subscriptionsRouter(ctx));
  app.use('/notifications', notificationsRouter(ctx));

  // Centralised error handling: Zod -> 400, HttpError -> its status, else 500.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.flatten() });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

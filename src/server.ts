import express, {
  type Application,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { ZodError } from 'zod';
import { apiKeyAuth, HttpError } from './auth.js';
import type { AuthService } from './auth-service.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
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

/** Browser CORS for subscribe/public endpoints: reflect any registered origin. */
function browserCors(repo: Repository) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header('origin');
    if (origin && repo.isOriginAllowedForAny(origin)) {
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

/** Admin-plane CORS: allow exactly the configured dashboard origin + Bearer. */
function adminCors(config: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header('origin');
    if (origin && origin === config.dashboardOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
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
  authService: AuthService,
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

  // Liveness (no CORS needed).
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Browser-facing endpoints: per-app CORS.
  app.get('/vapid-public-key', browserCors(repo), (_req, res) =>
    res.json({ publicKey: config.vapid.publicKey }),
  );
  app.use('/subscriptions', browserCors(repo), subscriptionsRouter(ctx));

  // Server-to-server delivery (x-api-key; no browser CORS).
  app.use('/notifications', notificationsRouter(ctx));

  // Admin plane: dashboard-origin CORS + SIWE auth.
  app.use('/auth', adminCors(config), authRouter(config, repo, authService));
  app.use('/admin', adminCors(config), adminRouter(config, repo, authService));

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

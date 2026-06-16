import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';
import { createServer } from './server.js';
import { PushSender } from './webpush.js';
import { createAuthService } from './auth-service.js';
import { seedFromEnv } from './seed.js';

/** Composition root: load config, wire dependencies, start listening. */
function main(): void {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const repo = new Repository(db);

  // One-time import of legacy env config (APP_KEYS / CORS_ORIGINS) into the DB.
  // After first boot the dashboard/DB is the source of truth.
  seedFromEnv(repo, {
    appKeys: config.appKeys,
    corsOrigins: config.corsOrigins.filter((o) => o !== '*'),
  });

  if (!config.dashboardOrigin) {
    // eslint-disable-next-line no-console
    console.warn(
      'WARNING: DASHBOARD_ORIGIN is empty — browsers will be blocked by CORS from ' +
        'calling /auth and /admin, so the admin dashboard cannot work. Set it to the ' +
        'dashboard origin (e.g. https://admin.push.p2p.me).',
    );
  }

  const sender = new PushSender(config, repo);
  const authService = createAuthService(config);
  const app = createServer(config, repo, sender, authService);

  const server = app.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(
      `push-notifications listening on http://${config.host}:${config.port}`,
    );
  });

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}, shutting down...`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();

import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';
import { createServer } from './server.js';
import { PushSender } from './webpush.js';
import { createThirdwebAuthService } from './auth-service.js';

/** Composition root: load config, wire dependencies, start listening. */
function main(): void {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const repo = new Repository(db);
  const sender = new PushSender(config, repo);
  const authService = createThirdwebAuthService(config);
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

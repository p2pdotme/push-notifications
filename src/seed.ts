import { hashApiKey } from './api-keys.js';
import type { Repository } from './repository.js';

/**
 * One-time migration of the legacy env config into the database. Runs only when
 * no apps exist yet, so the DB becomes the source of truth after first boot.
 * The legacy global CORS list is best-effort attached to every imported app;
 * admins refine it afterward. The `*` wildcard is skipped (per-app origins are
 * explicit allow-list entries, not wildcards).
 */
export function seedFromEnv(
  repo: Repository,
  env: { appKeys: Record<string, string>; corsOrigins: string[] },
): void {
  if (repo.listApps().length > 0) return;

  const origins = env.corsOrigins.filter((o) => o !== '*');

  for (const [appId, secret] of Object.entries(env.appKeys)) {
    repo.createApp({ appId, name: appId });
    repo.createApiKey({
      appId,
      keyHash: hashApiKey(secret),
      keyPrefix: secret.slice(0, 10),
      label: 'imported from APP_KEYS',
      createdBy: null,
    });
    for (const origin of origins) {
      repo.addCorsOrigin({ appId, origin });
    }
  }
}

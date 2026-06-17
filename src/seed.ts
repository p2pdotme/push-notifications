import { hashApiKey } from './api-keys.js';
import type { Repository } from './repository.js';

/**
 * One-time migration of the legacy env config into the database. Runs only when
 * no apps exist yet, so the DB becomes the source of truth after first boot.
 * The `*` wildcard is skipped (per-app origins are explicit allow-list entries).
 */
export async function seedFromEnv(
  repo: Repository,
  env: { appKeys: Record<string, string>; corsOrigins: string[] },
): Promise<void> {
  if ((await repo.listApps()).length > 0) return;

  const origins = env.corsOrigins.filter((o) => o !== '*');

  // All-or-nothing: a crash mid-seed must not leave a partial state that the
  // `listApps().length > 0` guard would then refuse to re-seed.
  await repo.transaction(async (tx) => {
    for (const [appId, secret] of Object.entries(env.appKeys)) {
      await tx.createApp({ appId, name: appId });
      await tx.createApiKey({
        appId,
        keyHash: hashApiKey(secret),
        keyPrefix: secret.slice(0, 10),
        label: 'imported from APP_KEYS',
        createdBy: null,
      });
      for (const origin of origins) {
        await tx.addCorsOrigin({ appId, origin });
      }
    }
  });
}

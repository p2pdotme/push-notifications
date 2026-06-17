import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../src/repository.js';
import { hashApiKey } from '../src/api-keys.js';
import { seedFromEnv } from '../src/seed.js';
import { createTestPool } from './helpers/test-db.js';

async function freshRepo(): Promise<Repository> {
  return new Repository(await createTestPool());
}

describe('seedFromEnv', () => {
  it('imports app keys and attaches origins to every app', async () => {
    const r = await freshRepo();
    await seedFromEnv(r, {
      appKeys: { 'user-app': 'user-key', 'merchant-app': 'merchant-key' },
      corsOrigins: ['https://app.p2p.me'],
    });

    assert.equal((await r.listApps()).length, 2);
    assert.equal((await r.findActiveApiKeyByHash(hashApiKey('user-key')))?.appId, 'user-app');
    assert.equal(await r.isOriginAllowedForApp('user-app', 'https://app.p2p.me'), true);
    assert.equal(await r.isOriginAllowedForApp('merchant-app', 'https://app.p2p.me'), true);
  });

  it('is a no-op when apps already exist', async () => {
    const r = await freshRepo();
    await r.createApp({ appId: 'existing', name: 'existing' });
    await seedFromEnv(r, { appKeys: { 'user-app': 'user-key' }, corsOrigins: [] });
    assert.equal((await r.listApps()).length, 1);
  });

  it('ignores the wildcard origin', async () => {
    const r = await freshRepo();
    await seedFromEnv(r, { appKeys: { 'user-app': 'user-key' }, corsOrigins: ['*'] });
    assert.equal((await r.listCorsOrigins('user-app')).length, 0);
  });
});

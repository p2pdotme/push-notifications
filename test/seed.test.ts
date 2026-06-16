import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { Repository } from '../src/repository.js';
import { hashApiKey } from '../src/api-keys.js';
import { seedFromEnv } from '../src/seed.js';

function repo() {
  return new Repository(openDatabase(':memory:'));
}

describe('seedFromEnv', () => {
  it('imports app keys and attaches origins to every app', () => {
    const r = repo();
    seedFromEnv(r, {
      appKeys: { 'user-app': 'user-key', 'merchant-app': 'merchant-key' },
      corsOrigins: ['https://app.p2p.me'],
    });

    assert.equal(r.listApps().length, 2);
    assert.equal(r.findActiveApiKeyByHash(hashApiKey('user-key'))?.appId, 'user-app');
    assert.equal(r.isOriginAllowedForApp('user-app', 'https://app.p2p.me'), true);
    assert.equal(r.isOriginAllowedForApp('merchant-app', 'https://app.p2p.me'), true);
  });

  it('is a no-op when apps already exist', () => {
    const r = repo();
    r.createApp({ appId: 'existing', name: 'existing' });
    seedFromEnv(r, { appKeys: { 'user-app': 'user-key' }, corsOrigins: [] });
    assert.equal(r.listApps().length, 1);
  });

  it('ignores the wildcard origin', () => {
    const r = repo();
    seedFromEnv(r, { appKeys: { 'user-app': 'user-key' }, corsOrigins: ['*'] });
    assert.equal(r.listCorsOrigins('user-app').length, 0);
  });
});

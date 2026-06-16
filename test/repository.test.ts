import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { Repository } from '../src/repository.js';
import { generateApiKey } from '../src/api-keys.js';

function freshRepo(): Repository {
  return new Repository(openDatabase(':memory:'));
}

describe('schema', () => {
  it('creates the admin-plane tables', () => {
    const db = openDatabase(':memory:');
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of ['apps', 'api_keys', 'cors_origins', 'admins']) {
      assert.ok(names.includes(t), `expected table ${t}`);
    }
    db.close();
  });
});

describe('repository: apps', () => {
  it('creates, lists, gets, updates, and deletes apps', () => {
    const repo = freshRepo();
    repo.createApp({ appId: 'user-app', name: 'User App' });
    assert.equal(repo.listApps().length, 1);

    const got = repo.getApp('user-app');
    assert.equal(got?.name, 'User App');
    assert.equal(got?.disabled, false);

    repo.updateApp('user-app', { name: 'Renamed', disabled: true });
    const updated = repo.getApp('user-app');
    assert.equal(updated?.name, 'Renamed');
    assert.equal(updated?.disabled, true);

    repo.deleteApp('user-app');
    assert.equal(repo.getApp('user-app'), null);
  });
});

describe('repository: api keys', () => {
  it('creates, looks up by hash, lists, and revokes', () => {
    const repo = freshRepo();
    repo.createApp({ appId: 'user-app', name: 'User App' });
    const k = generateApiKey();
    const rec = repo.createApiKey({
      appId: 'user-app',
      keyHash: k.keyHash,
      keyPrefix: k.keyPrefix,
      label: 'ci',
      createdBy: '0xabc',
    });

    const found = repo.findActiveApiKeyByHash(k.keyHash);
    assert.equal(found?.appId, 'user-app');

    assert.equal(repo.listApiKeys('user-app').length, 1);

    repo.revokeApiKey(rec.id);
    assert.equal(repo.findActiveApiKeyByHash(k.keyHash), null);
  });
});

describe('repository: cors origins', () => {
  it('adds, lists, checks per-app and global, and deletes', () => {
    const repo = freshRepo();
    repo.createApp({ appId: 'user-app', name: 'User App' });
    repo.createApp({ appId: 'merchant-app', name: 'Merchant App' });

    const o = repo.addCorsOrigin({ appId: 'user-app', origin: 'https://app.p2p.me' });
    assert.equal(repo.listCorsOrigins('user-app').length, 1);

    assert.equal(repo.isOriginAllowedForApp('user-app', 'https://app.p2p.me'), true);
    assert.equal(repo.isOriginAllowedForApp('merchant-app', 'https://app.p2p.me'), false);
    assert.equal(repo.isOriginAllowedForAny('https://app.p2p.me'), true);
    assert.equal(repo.isOriginAllowedForAny('https://evil.example'), false);

    repo.deleteCorsOrigin(o.id);
    assert.equal(repo.isOriginAllowedForAny('https://app.p2p.me'), false);
  });
});

describe('repository: admins', () => {
  it('adds (lowercased), lists, checks, and removes', () => {
    const repo = freshRepo();
    repo.addAdmin({ address: '0xAbC', label: 'me', addedBy: '0xroot' });
    assert.equal(repo.isDbAdmin('0xabc'), true);
    assert.equal(repo.isDbAdmin('0xABC'), true);
    assert.equal(repo.listAdmins().length, 1);
    repo.removeAdmin('0xabc');
    assert.equal(repo.isDbAdmin('0xabc'), false);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../src/repository.js';
import { generateApiKey } from '../src/api-keys.js';
import { createTestPool } from './helpers/test-db.js';

async function freshRepo(): Promise<Repository> {
  return new Repository(await createTestPool());
}

describe('repository: apps', () => {
  it('defaults require_subscription_signature to false and toggles it via updateApp', async () => {
    const db = await createTestPool();
    const repo = new Repository(db);
    const app = await repo.createApp({ appId: 'sig-app', name: 'Sig App' });
    assert.equal(app.requireSubscriptionSignature, false);

    const updated = await repo.updateApp('sig-app', { requireSubscriptionSignature: true });
    assert.equal(updated?.requireSubscriptionSignature, true);

    // Unrelated patches must not clear the flag.
    const renamed = await repo.updateApp('sig-app', { name: 'Renamed' });
    assert.equal(renamed?.name, 'Renamed');
    assert.equal(renamed?.requireSubscriptionSignature, true);
  });

  it('creates, lists, gets, updates, and deletes apps', async () => {
    const repo = await freshRepo();
    await repo.createApp({ appId: 'user-app', name: 'User App' });
    assert.equal((await repo.listApps()).length, 1);

    const got = await repo.getApp('user-app');
    assert.equal(got?.name, 'User App');
    assert.equal(got?.disabled, false);

    await repo.updateApp('user-app', { name: 'Renamed', disabled: true });
    const updated = await repo.getApp('user-app');
    assert.equal(updated?.name, 'Renamed');
    assert.equal(updated?.disabled, true);

    await repo.deleteApp('user-app');
    assert.equal(await repo.getApp('user-app'), null);
  });
});

describe('repository: api keys', () => {
  it('creates, looks up by hash, lists, and revokes', async () => {
    const repo = await freshRepo();
    await repo.createApp({ appId: 'user-app', name: 'User App' });
    const k = generateApiKey();
    const rec = await repo.createApiKey({
      appId: 'user-app', keyHash: k.keyHash, keyPrefix: k.keyPrefix, label: 'ci', createdBy: '0xabc',
    });
    assert.equal((await repo.findActiveApiKeyByHash(k.keyHash))?.appId, 'user-app');
    assert.equal((await repo.listApiKeys('user-app')).length, 1);
    await repo.revokeApiKey(rec.id);
    assert.equal(await repo.findActiveApiKeyByHash(k.keyHash), null);
  });

  it('stops authenticating a key when its app is disabled', async () => {
    const repo = await freshRepo();
    await repo.createApp({ appId: 'user-app', name: 'User App' });
    const k = generateApiKey();
    await repo.createApiKey({ appId: 'user-app', keyHash: k.keyHash, keyPrefix: k.keyPrefix, label: null, createdBy: null });
    assert.equal((await repo.findActiveApiKeyByHash(k.keyHash))?.appId, 'user-app');
    await repo.updateApp('user-app', { disabled: true });
    assert.equal(await repo.findActiveApiKeyByHash(k.keyHash), null);
  });

  it('records last-used on touch', async () => {
    const repo = await freshRepo();
    await repo.createApp({ appId: 'user-app', name: 'User App' });
    const k = generateApiKey();
    const rec = await repo.createApiKey({ appId: 'user-app', keyHash: k.keyHash, keyPrefix: k.keyPrefix, label: null, createdBy: null });
    assert.equal((await repo.listApiKeys('user-app'))[0]?.lastUsedAt, null);
    await repo.touchApiKey(rec.id);
    assert.notEqual((await repo.listApiKeys('user-app'))[0]?.lastUsedAt, null);
  });
});

describe('repository: cors origins', () => {
  it('adds, lists, checks per-app and global, and deletes', async () => {
    const repo = await freshRepo();
    await repo.createApp({ appId: 'user-app', name: 'User App' });
    await repo.createApp({ appId: 'merchant-app', name: 'Merchant App' });
    const o = await repo.addCorsOrigin({ appId: 'user-app', origin: 'https://app.p2p.me' });
    assert.equal((await repo.listCorsOrigins('user-app')).length, 1);
    assert.equal(await repo.isOriginAllowedForApp('user-app', 'https://app.p2p.me'), true);
    assert.equal(await repo.isOriginAllowedForApp('merchant-app', 'https://app.p2p.me'), false);
    assert.equal(await repo.isOriginAllowedForAny('https://app.p2p.me'), true);
    assert.equal(await repo.isOriginAllowedForAny('https://evil.example'), false);
    await repo.deleteCorsOrigin(o.id);
    assert.equal(await repo.isOriginAllowedForAny('https://app.p2p.me'), false);
  });
});

describe('repository: admins', () => {
  it('adds (lowercased), lists, checks, and removes', async () => {
    const repo = await freshRepo();
    await repo.addAdmin({ address: '0xAbC', label: 'me', addedBy: '0xroot' });
    assert.equal(await repo.isDbAdmin('0xabc'), true);
    assert.equal(await repo.isDbAdmin('0xABC'), true);
    assert.equal((await repo.listAdmins()).length, 1);
    await repo.removeAdmin('0xabc');
    assert.equal(await repo.isDbAdmin('0xabc'), false);
  });
});

describe('pruneOldLogs', () => {
  it('deletes only rows older than the retention window', async () => {
    const pool = await createTestPool();
    const repo = new Repository(pool);
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const fresh = new Date().toISOString();
    await pool.query(
      `INSERT INTO notification_logs (app_id, endpoint, status, created_at) VALUES ($1,$2,$3,$4::timestamptz)`,
      ['a', 'e1', 'sent', old],
    );
    await pool.query(
      `INSERT INTO notification_logs (app_id, endpoint, status, created_at) VALUES ($1,$2,$3,$4::timestamptz)`,
      ['a', 'e2', 'sent', fresh],
    );
    assert.equal(await repo.pruneOldLogs(30), 1);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM notification_logs`);
    assert.equal(rows[0].n, 1);
    await pool.end();
  });

  it('is a no-op when days <= 0', async () => {
    const pool = await createTestPool();
    const repo = new Repository(pool);
    assert.equal(await repo.pruneOldLogs(0), 0);
    await pool.end();
  });
});

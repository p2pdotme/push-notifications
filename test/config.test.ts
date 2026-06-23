import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseList, loadConfig } from '../src/config.js';

describe('parseList', () => {
  it('splits, trims, and drops empties', () => {
    assert.deepEqual(parseList('a, b ,,c'), ['a', 'b', 'c']);
  });

  it('returns an empty array for empty input', () => {
    assert.deepEqual(parseList(''), []);
    assert.deepEqual(parseList('   '), []);
  });
});

function baseEnv(): void {
  process.env.VAPID_PUBLIC_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
  process.env.ADMIN_API_KEY = 'admin';
  process.env.DATABASE_URL = 'postgresql://localhost/test';
  delete process.env.THIRDWEB_SECRET_KEY;
  delete process.env.AUTH_DOMAIN;
  delete process.env.AUTH_JWT_SECRET;
  delete process.env.THIRDWEB_AUTH_DOMAIN;
  delete process.env.THIRDWEB_AUTH_PRIVATE_KEY;
  delete process.env.SEND_CONCURRENCY;
  delete process.env.LOG_RETENTION_DAYS;
}

describe('loadConfig auth env', () => {
  it('reads AUTH_DOMAIN and AUTH_JWT_SECRET', () => {
    baseEnv();
    process.env.AUTH_DOMAIN = 'admin.push.p2p.me';
    process.env.AUTH_JWT_SECRET = 'secret';
    const c = loadConfig();
    assert.equal(c.authDomain, 'admin.push.p2p.me');
    assert.equal(c.jwtSecret, 'secret');
  });

  it('falls back to THIRDWEB_AUTH_DOMAIN / THIRDWEB_AUTH_PRIVATE_KEY', () => {
    baseEnv();
    process.env.THIRDWEB_AUTH_DOMAIN = 'legacy.example';
    process.env.THIRDWEB_AUTH_PRIVATE_KEY = '0xdeadbeef';
    const c = loadConfig();
    assert.equal(c.authDomain, 'legacy.example');
    assert.equal(c.jwtSecret, '0xdeadbeef');
  });

  it('no longer requires THIRDWEB_SECRET_KEY', () => {
    baseEnv();
    process.env.AUTH_DOMAIN = 'd';
    process.env.AUTH_JWT_SECRET = 's';
    assert.doesNotThrow(() => loadConfig());
  });

  it('defaults sendConcurrency to 25 and logRetentionDays to 0', () => {
    baseEnv();
    process.env.AUTH_DOMAIN = 'd';
    process.env.AUTH_JWT_SECRET = 's';
    const c = loadConfig();
    assert.equal(c.sendConcurrency, 25);
    assert.equal(c.logRetentionDays, 0);
  });

  it('defaults subscribe verification chain to Base (8453) and rpc url to empty', () => {
    baseEnv();
    process.env.AUTH_DOMAIN = 'd';
    process.env.AUTH_JWT_SECRET = 's';
    delete process.env.SUBSCRIBE_VERIFY_RPC_URL;
    delete process.env.SUBSCRIBE_VERIFY_CHAIN_ID;
    const c = loadConfig();
    assert.equal(c.subscribeVerifyChainId, 8453);
    assert.equal(c.subscribeVerifyRpcUrl, '');
  });

  it('reads SUBSCRIBE_VERIFY_RPC_URL and SUBSCRIBE_VERIFY_CHAIN_ID', () => {
    baseEnv();
    process.env.AUTH_DOMAIN = 'd';
    process.env.AUTH_JWT_SECRET = 's';
    process.env.SUBSCRIBE_VERIFY_RPC_URL = 'https://base-rpc.example/key';
    process.env.SUBSCRIBE_VERIFY_CHAIN_ID = '8453';
    const c = loadConfig();
    assert.equal(c.subscribeVerifyRpcUrl, 'https://base-rpc.example/key');
    assert.equal(c.subscribeVerifyChainId, 8453);
  });

  it('throws when no auth domain is set', () => {
    baseEnv();
    process.env.AUTH_JWT_SECRET = 's';
    // no AUTH_DOMAIN / THIRDWEB_AUTH_DOMAIN
    assert.throws(() => loadConfig());
  });

  it('throws when no jwt secret is set', () => {
    baseEnv();
    process.env.AUTH_DOMAIN = 'd';
    // no AUTH_JWT_SECRET / THIRDWEB_AUTH_PRIVATE_KEY
    assert.throws(() => loadConfig());
  });

  it('throws when DATABASE_URL is missing', () => {
    baseEnv();
    process.env.AUTH_DOMAIN = 'd';
    process.env.AUTH_JWT_SECRET = 's';
    delete process.env.DATABASE_URL;
    assert.throws(() => loadConfig());
  });
});

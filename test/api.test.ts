import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import webpush from 'web-push';
import type { Config } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { Repository } from '../src/repository.js';
import { PushSender } from '../src/webpush.js';
import { createServer } from '../src/server.js';

/**
 * End-to-end-ish tests against an in-memory DB. We exercise auth, validation,
 * subscription lifecycle, and targeting logic without hitting real push
 * services (no subscriptions => the send path short-circuits to 404).
 */
const vapid = webpush.generateVAPIDKeys();

const config: Config = {
  port: 0,
  host: '127.0.0.1',
  corsOrigins: ['*'],
  vapid: { publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: 'mailto:test@p2p.me' },
  databasePath: ':memory:',
  adminApiKey: 'admin-key',
  appKeys: { 'user-app': 'user-key', 'merchant-app': 'merchant-key' },
  maxFailures: 5,
  adminWallets: [],
  dashboardOrigin: 'http://localhost:5173',
  thirdweb: { secretKey: 'x', authPrivateKey: 'x', authDomain: 'localhost' },
};

let server: Server;
let base: string;

function makeSubscription(endpoint: string) {
  return { endpoint, keys: { p256dh: 'BPceUbY'.padEnd(20, 'x'), auth: 'auth'.padEnd(16, 'y') } };
}

before(async () => {
  const db = openDatabase(':memory:');
  const repo = new Repository(db);
  const sender = new PushSender(config, repo);
  const app = createServer(config, repo, sender);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
});

describe('public endpoints', () => {
  it('reports health', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });

  it('exposes the VAPID public key', async () => {
    const res = await fetch(`${base}/vapid-public-key`);
    const body = (await res.json()) as { publicKey: string };
    assert.equal(body.publicKey, vapid.publicKey);
  });
});

describe('subscriptions', () => {
  it('registers a subscription without an API key', async () => {
    const res = await fetch(`${base}/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: 'user-app',
        userId: 'alice',
        subscription: makeSubscription('https://push.example.com/a'),
      }),
    });
    assert.equal(res.status, 201);
  });

  it('rejects malformed subscriptions with 400', async () => {
    const res = await fetch(`${base}/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'user-app', subscription: { endpoint: 'not-a-url' } }),
    });
    assert.equal(res.status, 400);
  });
});

describe('auth', () => {
  it('rejects send without an API key', async () => {
    const res = await fetch(`${base}/notifications/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'user-app', userId: 'alice', notification: { title: 'hi' } }),
    });
    assert.equal(res.status, 401);
  });

  it('forbids an app key targeting another app', async () => {
    const res = await fetch(`${base}/notifications/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'merchant-key' },
      body: JSON.stringify({ appId: 'user-app', userId: 'alice', notification: { title: 'hi' } }),
    });
    assert.equal(res.status, 403);
  });

  it('returns 404 when no subscriptions match', async () => {
    const res = await fetch(`${base}/notifications/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'user-key' },
      body: JSON.stringify({ appId: 'user-app', userId: 'nobody', notification: { title: 'hi' } }),
    });
    assert.equal(res.status, 404);
  });
});

describe('stats', () => {
  it('counts subscriptions for the authorized app', async () => {
    const res = await fetch(`${base}/subscriptions/stats/user-app`, {
      headers: { 'x-api-key': 'admin-key' },
    });
    const body = (await res.json()) as { total: number; active: number };
    assert.ok(body.total >= 1);
    assert.ok(body.active >= 1);
  });
});

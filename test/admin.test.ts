import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAuthService } from './fake-auth-service.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import webpush from 'web-push';
import type { Config } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { Repository } from '../src/repository.js';
import { PushSender } from '../src/webpush.js';
import { createServer } from '../src/server.js';
import type { AuthService } from '../src/auth-service.js';

const vapid = webpush.generateVAPIDKeys();
const ADMIN = '0xadmin0000000000000000000000000000000001';

function makeConfig(): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    corsOrigins: ['*'],
    vapid: { publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: 'mailto:test@p2p.me' },
    databasePath: ':memory:',
    adminApiKey: 'admin-key',
    appKeys: {},
    maxFailures: 5,
    adminWallets: [ADMIN],
    dashboardOrigin: 'http://localhost:5173',
    thirdweb: { secretKey: 'x', authPrivateKey: 'x', authDomain: 'localhost' },
  };
}

async function startServer(config: Config): Promise<{ base: string; repo: Repository; close: () => void }> {
  const repo = new Repository(openDatabase(':memory:'));
  const sender = new PushSender(config, repo);
  const app = createServer(config, repo, sender, new FakeAuthService());
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${addr.port}`, repo, close: () => server.close() };
}

const adminHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer faketoken:${ADMIN}` };

describe('FakeAuthService', () => {
  it('round-trips a login and JWT', async () => {
    const auth = new FakeAuthService();
    const payload = await auth.generatePayload('0xAbC');
    const issued = await auth.verifyAndIssueJwt(payload, 'sig');
    assert.equal(issued?.address, '0xabc');
    const verified = await auth.verifyJwt(issued!.token);
    assert.equal(verified?.address, '0xabc');
  });

  it('rejects a malformed token', async () => {
    const auth = new FakeAuthService();
    assert.equal(await auth.verifyJwt('garbage'), null);
  });
});

describe('auth routes', () => {
  it('returns a login payload', async () => {
    const { base, close } = await startServer(makeConfig());
    const res = await fetch(`${base}/auth/payload?address=${ADMIN}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { address: string };
    assert.equal(body.address, ADMIN);
    close();
  });

  it('logs in a whitelisted admin and returns a token', async () => {
    const { base, close } = await startServer(makeConfig());
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { address: ADMIN }, signature: 'sig' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { token: string; isAdmin: boolean };
    assert.equal(body.isAdmin, true);
    assert.equal(body.token, `faketoken:${ADMIN}`);
    close();
  });

  it('rejects a non-whitelisted address with 403 + address', async () => {
    const { base, close } = await startServer(makeConfig());
    const stranger = '0xstranger00000000000000000000000000000002';
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { address: stranger }, signature: 'sig' }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { address: string };
    assert.equal(body.address, stranger);
    close();
  });

  it('reports identity via /auth/me with a Bearer token', async () => {
    const { base, close } = await startServer(makeConfig());
    const res = await fetch(`${base}/auth/me`, { headers: adminHeaders });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { address: string; isAdmin: boolean };
    assert.equal(body.address, ADMIN);
    assert.equal(body.isAdmin, true);
    close();
  });

  it('rejects /auth/me without a token', async () => {
    const { base, close } = await startServer(makeConfig());
    const res = await fetch(`${base}/auth/me`);
    assert.equal(res.status, 401);
    close();
  });
});

describe('admin routes', () => {
  it('rejects unauthenticated access', async () => {
    const { base, close } = await startServer(makeConfig());
    const res = await fetch(`${base}/admin/apps`);
    assert.equal(res.status, 401);
    close();
  });

  it('rejects a non-admin token', async () => {
    const { base, close } = await startServer(makeConfig());
    const res = await fetch(`${base}/admin/apps`, {
      headers: { Authorization: 'Bearer faketoken:0xnope000000000000000000000000000000000003' },
    });
    assert.equal(res.status, 403);
    close();
  });

  it('runs the full app/key/origin/admin lifecycle', async () => {
    const { base, close } = await startServer(makeConfig());

    let res = await fetch(`${base}/admin/apps`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ appId: 'user-app', name: 'User App' }),
    });
    assert.equal(res.status, 201);

    res = await fetch(`${base}/admin/apps`, { headers: adminHeaders });
    assert.equal(((await res.json()) as unknown[]).length, 1);

    res = await fetch(`${base}/admin/apps/user-app/keys`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ label: 'ci' }),
    });
    assert.equal(res.status, 201);
    const key = (await res.json()) as { id: number; secret: string };
    assert.match(key.secret, /^pk_/);

    res = await fetch(`${base}/admin/apps/user-app/keys`, { headers: adminHeaders });
    const keys = (await res.json()) as Record<string, unknown>[];
    assert.equal(keys.length, 1);
    assert.equal(keys[0].secret, undefined);

    res = await fetch(`${base}/admin/keys/${key.id}`, { method: 'DELETE', headers: adminHeaders });
    assert.equal(res.status, 204);

    res = await fetch(`${base}/admin/apps/user-app/origins`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ origin: 'https://app.p2p.me' }),
    });
    assert.equal(res.status, 201);
    const origin = (await res.json()) as { id: number };

    res = await fetch(`${base}/admin/apps/user-app/origins`, { headers: adminHeaders });
    assert.equal(((await res.json()) as unknown[]).length, 1);

    res = await fetch(`${base}/admin/origins/${origin.id}`, { method: 'DELETE', headers: adminHeaders });
    assert.equal(res.status, 204);

    res = await fetch(`${base}/admin/admins`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ address: '0xBEEF000000000000000000000000000000000004', label: 'teammate' }),
    });
    assert.equal(res.status, 201);

    res = await fetch(`${base}/admin/admins`, { headers: adminHeaders });
    assert.equal(((await res.json()) as { managed: unknown[] }).managed.length, 1);

    res = await fetch(`${base}/admin/admins/0xBEEF000000000000000000000000000000000004`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    assert.equal(res.status, 204);

    res = await fetch(`${base}/admin/apps/user-app`, { method: 'DELETE', headers: adminHeaders });
    assert.equal(res.status, 204);

    close();
  });

  it('validates request bodies with 400', async () => {
    const { base, close } = await startServer(makeConfig());
    const res = await fetch(`${base}/admin/apps`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ appId: 'Bad Id!', name: '' }),
    });
    assert.equal(res.status, 400);
    close();
  });
});

describe('per-app subscribe CORS enforcement', () => {
  it('allows a registered origin and blocks an unregistered one', async () => {
    const config = makeConfig();
    const { base, repo, close } = await startServer(config);
    repo.createApp({ appId: 'user-app', name: 'User App' });
    repo.addCorsOrigin({ appId: 'user-app', origin: 'https://app.p2p.me' });

    const sub = {
      appId: 'user-app',
      userId: 'alice',
      subscription: { endpoint: 'https://push.example.com/x', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(16) } },
    };

    const ok = await fetch(`${base}/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://app.p2p.me' },
      body: JSON.stringify(sub),
    });
    assert.equal(ok.status, 201);

    const blocked = await fetch(`${base}/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify(sub),
    });
    assert.equal(blocked.status, 403);

    close();
  });
});

describe('requireAdmin resilience', () => {
  it('responds 500 (does not hang) when the auth service throws', async () => {
    // The real thirdweb verifyJwt throws on malformed tokens; requireAdmin must
    // funnel that to the error handler rather than leaving the request hanging.
    const throwingAuth: AuthService = {
      async generatePayload() {
        return {};
      },
      async verifyAndIssueJwt() {
        return null;
      },
      async verifyJwt() {
        throw new Error('Invalid JWT');
      },
    };
    const config = makeConfig();
    const repo = new Repository(openDatabase(':memory:'));
    const sender = new PushSender(config, repo);
    const app = createServer(config, repo, sender, throwingAuth);
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${addr.port}/admin/apps`, {
      headers: { Authorization: 'Bearer malformed.token' },
    });
    assert.equal(res.status, 500);
    server.close();
  });
});

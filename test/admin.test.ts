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

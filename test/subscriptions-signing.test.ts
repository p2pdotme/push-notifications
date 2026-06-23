import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import webpush from 'web-push';
import * as Secp256k1 from 'ox/Secp256k1';
import * as PersonalMessage from 'ox/PersonalMessage';
import * as Signature from 'ox/Signature';
import * as Hex from 'ox/Hex';
import * as Address from 'ox/Address';
import type { Config } from '../src/config.js';
import { Repository } from '../src/repository.js';
import { PushSender } from '../src/webpush.js';
import { createServer } from '../src/server.js';
import { createSubscriptionVerifier, type SignatureVerifier } from '../src/subscription-verify.js';
import { FakeAuthService } from './fake-auth-service.js';
import { createTestPool } from './helpers/test-db.js';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDRESS = Address.fromPublicKey(Secp256k1.getPublicKey({ privateKey: PRIVATE_KEY })).toLowerCase();
const ORIGIN = 'http://app.example.com';

const vapid = webpush.generateVAPIDKeys();
const config: Config = {
  port: 0, host: '127.0.0.1', corsOrigins: ['*'],
  vapid: { publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: 'mailto:test@p2p.me' },
  databaseUrl: 'postgresql://localhost/test', adminApiKey: 'admin-key', appKeys: {},
  maxFailures: 5, adminWallets: [], dashboardOrigin: 'http://localhost:5173',
  authDomain: 'localhost', jwtSecret: 'x', sendConcurrency: 25, logRetentionDays: 0,
  subscribeVerifyRpcUrl: '', subscribeVerifyChainId: 8453,
};

const oxVerifier: SignatureVerifier = async ({ address, message, signature }) => {
  try {
    const hash = PersonalMessage.getSignPayload(Hex.fromString(message));
    const recovered = Secp256k1.recoverAddress({ payload: hash, signature: Signature.fromHex(signature as `0x${string}`) });
    return recovered.toLowerCase() === address.toLowerCase();
  } catch { return false; }
};

let server: Server;
let base: string;
let repo: Repository;

function makeSub(endpoint: string) {
  return { endpoint, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(16) } };
}

async function subscribeWithProof(endpoint: string, address = ADDRESS) {
  const chRes = await fetch(`${base}/subscriptions/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ appId: 'sig-app', address, endpoint }),
  });
  assert.equal(chRes.status, 200, 'challenge should succeed');
  const { payload, message } = (await chRes.json()) as { payload: unknown; message: string };
  const hash = PersonalMessage.getSignPayload(Hex.fromString(message));
  const signature = Signature.toHex(Secp256k1.sign({ payload: hash, privateKey: PRIVATE_KEY }));
  return fetch(`${base}/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ appId: 'sig-app', userId: address, subscription: makeSub(endpoint), payload, signature }),
  });
}

before(async () => {
  const db = await createTestPool();
  repo = new Repository(db);
  const sender = new PushSender(config, repo);
  await repo.createApp({ appId: 'sig-app', name: 'Sig App' });
  await repo.updateApp('sig-app', { requireSubscriptionSignature: true });
  await repo.addCorsOrigin({ appId: 'sig-app', origin: ORIGIN });
  await repo.createApp({ appId: 'sig-app-2', name: 'Sig App 2' });
  await repo.updateApp('sig-app-2', { requireSubscriptionSignature: true });
  await repo.addCorsOrigin({ appId: 'sig-app-2', origin: ORIGIN });
  await repo.createApp({ appId: 'open-app', name: 'Open App' });
  await repo.addCorsOrigin({ appId: 'open-app', origin: ORIGIN });
  const app = createServer(config, repo, sender, new FakeAuthService(), createSubscriptionVerifier(config, oxVerifier));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

describe('signature-required subscribe', () => {
  it('rejects subscribe without a signature (401 signature_required)', async () => {
    const res = await fetch(`${base}/subscriptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ appId: 'sig-app', userId: ADDRESS, subscription: makeSub('https://push.example.com/n1') }),
    });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code?: string }).code, 'signature_required');
  });

  it('rejects a null/non-address userId on a sig-required app', async () => {
    const res = await fetch(`${base}/subscriptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ appId: 'sig-app', userId: 'alice', subscription: makeSub('https://push.example.com/n2') }),
    });
    assert.equal(res.status, 401);
  });

  it('accepts a valid signed subscribe and records verified_at', async () => {
    const res = await subscribeWithProof('https://push.example.com/ok');
    assert.equal(res.status, 201);
    const stored = await repo.getSubscriptionByEndpoint('https://push.example.com/ok');
    assert.ok(stored?.verifiedAt, 'verified_at should be set');
  });

  it('rejects a signature bound to a different endpoint', async () => {
    const chRes = await fetch(`${base}/subscriptions/challenge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ appId: 'sig-app', address: ADDRESS, endpoint: 'https://push.example.com/sign-this' }),
    });
    const { payload, message } = (await chRes.json()) as { payload: unknown; message: string };
    const hash = PersonalMessage.getSignPayload(Hex.fromString(message));
    const signature = Signature.toHex(Secp256k1.sign({ payload: hash, privateKey: PRIVATE_KEY }));
    const res = await fetch(`${base}/subscriptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ appId: 'sig-app', userId: ADDRESS, subscription: makeSub('https://push.example.com/DIFFERENT'), payload, signature }),
    });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code?: string }).code, 'invalid_signature');
  });

  it('allows an unsigned refresh of an already-verified (endpoint, userId)', async () => {
    await subscribeWithProof('https://push.example.com/refresh');
    const res = await fetch(`${base}/subscriptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ appId: 'sig-app', userId: ADDRESS, subscription: makeSub('https://push.example.com/refresh') }),
    });
    assert.equal(res.status, 201);
  });

  it('still allows legacy unsigned subscribe on a non-sig app', async () => {
    const res = await fetch(`${base}/subscriptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ appId: 'open-app', userId: 'alice', subscription: makeSub('https://push.example.com/legacy') }),
    });
    assert.equal(res.status, 201);
  });

  it('rejects an unsigned cross-app refresh (verified on sig-app, attempt on sig-app-2)', async () => {
    // Endpoint distinct from all other tests to avoid cross-test interference.
    const endpoint = 'https://push.example.com/cross-app-refresh';
    // First: fully verify under sig-app.
    const verifyRes = await subscribeWithProof(endpoint);
    assert.equal(verifyRes.status, 201, 'initial signed subscribe should succeed');
    // Then: attempt unsigned subscribe for the SAME endpoint + SAME userId but under sig-app-2.
    const res = await fetch(`${base}/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ appId: 'sig-app-2', userId: ADDRESS, subscription: makeSub(endpoint) }),
    });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code?: string }).code, 'signature_required');
  });
});

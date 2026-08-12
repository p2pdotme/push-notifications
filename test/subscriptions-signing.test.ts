import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
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
import {
  createSubscriptionVerifier,
  VerifyUnavailableError,
  viemSignatureVerifier,
  type SignatureVerifier,
} from '../src/subscription-verify.js';
import { FakeAuthService } from './fake-auth-service.js';
import { createTestPool } from './helpers/test-db.js';
import { erc8010Malformed, erc8010WellFormed } from './helpers/erc8010.js';

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

describe('signature verifier unavailability (503) vs a genuine rejection (401)', () => {
  async function startServer(verifier: SignatureVerifier): Promise<{ srv: Server; url: string }> {
    const db = await createTestPool();
    const localRepo = new Repository(db);
    await localRepo.createApp({ appId: 'sig-app', name: 'Sig App' });
    await localRepo.updateApp('sig-app', { requireSubscriptionSignature: true });
    await localRepo.addCorsOrigin({ appId: 'sig-app', origin: ORIGIN });
    const sender = new PushSender(config, localRepo);
    const app = createServer(config, localRepo, sender, new FakeAuthService(), createSubscriptionVerifier(config, verifier));
    const srv = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    return { srv, url };
  }

  async function challengeAndSign(url: string, endpoint: string) {
    const chRes = await fetch(`${url}/subscriptions/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ appId: 'sig-app', address: ADDRESS, endpoint }),
    });
    assert.equal(chRes.status, 200, 'challenge should succeed');
    const { payload, message } = (await chRes.json()) as { payload: unknown; message: string };
    const hash = PersonalMessage.getSignPayload(Hex.fromString(message));
    const signature = Signature.toHex(Secp256k1.sign({ payload: hash, privateKey: PRIVATE_KEY }));
    return { payload, signature };
  }

  it('answers 503 verify_unavailable, not 401, when the verifier cannot tell', async () => {
    const { srv, url } = await startServer(async () => {
      throw new VerifyUnavailableError('Base RPC unavailable (simulated)');
    });
    try {
      const endpoint = 'https://push.example.com/unavailable';
      const { payload, signature } = await challengeAndSign(url, endpoint);
      const res = await fetch(`${url}/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ appId: 'sig-app', userId: ADDRESS, subscription: makeSub(endpoint), payload, signature }),
      });
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as { code?: string }).code, 'verify_unavailable');
    } finally {
      srv.close();
    }
  });

  it('still answers 401 invalid_signature for a genuine rejection', async () => {
    const { srv, url } = await startServer(async () => false);
    try {
      const endpoint = 'https://push.example.com/genuinely-bad';
      const { payload, signature } = await challengeAndSign(url, endpoint);
      const res = await fetch(`${url}/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ appId: 'sig-app', userId: ADDRESS, subscription: makeSub(endpoint), payload, signature }),
      });
      assert.equal(res.status, 401);
      assert.equal(((await res.json()) as { code?: string }).code, 'invalid_signature');
    } finally {
      srv.close();
    }
  });

  it('does not repaint an unrelated verifier bug as 503: a plain thrown error still 500s', async () => {
    const { srv, url } = await startServer(async () => {
      throw new Error('a bug unrelated to RPC availability (simulated)');
    });
    try {
      const endpoint = 'https://push.example.com/unrelated-bug';
      const { payload, signature } = await challengeAndSign(url, endpoint);
      const res = await fetch(`${url}/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ appId: 'sig-app', userId: ADDRESS, subscription: makeSub(endpoint), payload, signature }),
      });
      assert.equal(res.status, 500);
    } finally {
      srv.close();
    }
  });

  /**
   * These two run the REAL viem verifier against an unreachable RPC whose URL
   * carries a secret, which is how an operator's Alchemy key is shaped. The
   * signature is ERC-8010 wrapped: its 32-byte magic tail is caller-controlled
   * and selects a viem branch that calls the RPC with no catch of its own, so
   * an unauthenticated caller decides whether that branch is taken.
   */
  const SECRET = 'SECRET_RPC_KEY_MUST_NOT_LEAK';
  const DEAD_RPC = `http://127.0.0.1:9/v2/${SECRET}`;

  function captureConsole(): { output: () => string; restore: () => void } {
    const lines: string[] = [];
    const original = { error: console.error, warn: console.warn, log: console.log };
    const collect = (...args: unknown[]) => {
      lines.push(util.format(...args));
    };
    console.error = collect;
    console.warn = collect;
    console.log = collect;
    return {
      output: () => lines.join('\n'),
      restore: () => {
        console.error = original.error;
        console.warn = original.warn;
        console.log = original.log;
      },
    };
  }

  it('answers 503 and never writes the RPC URL anywhere when the RPC is unreachable', async () => {
    const verifier = viemSignatureVerifier({ ...config, subscribeVerifyRpcUrl: DEAD_RPC });
    const { srv, url } = await startServer(verifier);
    const console_ = captureConsole();
    try {
      const endpoint = 'https://push.example.com/dead-rpc';
      const { payload } = await challengeAndSign(url, endpoint);
      const res = await fetch(`${url}/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({
          appId: 'sig-app',
          userId: ADDRESS,
          subscription: makeSub(endpoint),
          payload,
          signature: erc8010WellFormed(),
        }),
      });
      const body = await res.text();
      const logged = console_.output();
      console_.restore();

      assert.equal(res.status, 503, `expected 503, got ${res.status}: ${body}`);
      assert.ok(!logged.includes(SECRET), `the RPC URL reached the log:\n${logged}`);
      assert.ok(!body.includes(SECRET), `the RPC URL reached the response body:\n${body}`);
      assert.match(logged, /HttpRequestError/, 'the log must name the underlying failure');
    } finally {
      console_.restore();
      srv.close();
    }
  });

  it('answers 401, not 500, for a malformed ERC-8010 wrapped signature', async () => {
    const verifier = viemSignatureVerifier({ ...config, subscribeVerifyRpcUrl: DEAD_RPC });
    const { srv, url } = await startServer(verifier);
    const console_ = captureConsole();
    try {
      const endpoint = 'https://push.example.com/malformed-8010';
      const { payload } = await challengeAndSign(url, endpoint);
      const res = await fetch(`${url}/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({
          appId: 'sig-app',
          userId: ADDRESS,
          subscription: makeSub(endpoint),
          payload,
          signature: erc8010Malformed(),
        }),
      });
      const logged = console_.output();
      console_.restore();

      assert.equal(res.status, 401);
      assert.equal(((await res.json()) as { code?: string }).code, 'invalid_signature');
      assert.ok(!logged.includes(SECRET), `the RPC URL reached the log:\n${logged}`);
    } finally {
      console_.restore();
      srv.close();
    }
  });
});

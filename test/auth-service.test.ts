import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as Secp256k1 from 'ox/Secp256k1';
import * as PersonalMessage from 'ox/PersonalMessage';
import * as Signature from 'ox/Signature';
import * as Hex from 'ox/Hex';
import * as Address from 'ox/Address';
import { createAuthService } from '../src/auth-service.js';
import { createLoginMessage, type LoginPayload } from '../src/siwe.js';
import type { Config } from '../src/config.js';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDRESS = Address.fromPublicKey(Secp256k1.getPublicKey({ privateKey: PRIVATE_KEY }));

const config = { authDomain: 'admin.push.p2p.me', jwtSecret: 'test-secret' } as Config;

function sign(p: LoginPayload): string {
  const hash = PersonalMessage.getSignPayload(Hex.fromString(createLoginMessage(p)));
  return Signature.toHex(Secp256k1.sign({ payload: hash, privateKey: PRIVATE_KEY }));
}

describe('createAuthService', () => {
  it('generates a payload, verifies a signature, issues and re-verifies a JWT', async () => {
    const svc = createAuthService(config);
    const payload = (await svc.generatePayload(ADDRESS)) as LoginPayload;
    assert.equal(payload.domain, 'admin.push.p2p.me');
    assert.ok(payload.nonce.length > 0);

    const result = await svc.verifyAndIssueJwt(payload, sign(payload));
    assert.ok(result);
    assert.equal(result!.address, ADDRESS.toLowerCase());

    const verified = await svc.verifyJwt(result!.token);
    assert.deepEqual(verified, { address: ADDRESS.toLowerCase() });
  });

  it('rejects a payload whose domain does not match', async () => {
    const svc = createAuthService(config);
    const payload = (await svc.generatePayload(ADDRESS)) as LoginPayload;
    const bad = { ...payload, domain: 'evil.example' };
    assert.equal(await svc.verifyAndIssueJwt(bad, sign(bad)), null);
  });

  it('rejects an expired payload', async () => {
    const svc = createAuthService(config);
    const payload = (await svc.generatePayload(ADDRESS)) as LoginPayload;
    const expired = { ...payload, expiration_time: '2000-01-01T00:00:00.000Z' };
    assert.equal(await svc.verifyAndIssueJwt(expired, sign(expired)), null);
  });

  it('rejects a signature from the wrong key', async () => {
    const svc = createAuthService(config);
    const payload = (await svc.generatePayload(ADDRESS)) as LoginPayload;
    const otherKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    const hash = PersonalMessage.getSignPayload(Hex.fromString(createLoginMessage(payload)));
    const wrongSig = Signature.toHex(Secp256k1.sign({ payload: hash, privateKey: otherKey }));
    assert.equal(await svc.verifyAndIssueJwt(payload, wrongSig), null);
  });
});

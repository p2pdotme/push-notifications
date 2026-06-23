import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as Secp256k1 from 'ox/Secp256k1';
import * as PersonalMessage from 'ox/PersonalMessage';
import * as Signature from 'ox/Signature';
import * as Hex from 'ox/Hex';
import * as Address from 'ox/Address';
import {
  channelResource,
  createSubscriptionVerifier,
  type SignatureVerifier,
} from '../src/subscription-verify.js';
import { createLoginMessage } from '../src/siwe.js';
import type { Config } from '../src/config.js';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDRESS = Address.fromPublicKey(Secp256k1.getPublicKey({ privateKey: PRIVATE_KEY })).toLowerCase();

const config = { subscribeVerifyRpcUrl: '', subscribeVerifyChainId: 8453 } as Config;

/** Offline EOA verifier (no network) used to exercise structural checks. */
const oxVerifier: SignatureVerifier = async ({ address, message, signature }) => {
  try {
    const hash = PersonalMessage.getSignPayload(Hex.fromString(message));
    const recovered = Secp256k1.recoverAddress({
      payload: hash,
      signature: Signature.fromHex(signature as `0x${string}`),
    });
    return recovered.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
};

function sign(message: string): string {
  const hash = PersonalMessage.getSignPayload(Hex.fromString(message));
  return Signature.toHex(Secp256k1.sign({ payload: hash, privateKey: PRIVATE_KEY }));
}

const ORIGIN = 'app.example.com';
const ENDPOINT = 'https://push.example.com/channel-1';
const APP = 'user-app';

describe('channelResource', () => {
  it('binds appId + endpoint deterministically', () => {
    const a = channelResource(APP, ENDPOINT);
    assert.match(a, /^push-channel:user-app:[0-9a-f]{64}$/);
    assert.notEqual(a, channelResource(APP, ENDPOINT + 'x'));
    assert.notEqual(a, channelResource('other', ENDPOINT));
  });
});

describe('verifyProof', () => {
  const verifier = createSubscriptionVerifier(config, oxVerifier);

  function freshProof(over: { endpoint?: string; appId?: string; originHost?: string } = {}) {
    const { payload, message } = verifier.buildChallenge({
      address: ADDRESS,
      appId: over.appId ?? APP,
      endpoint: over.endpoint ?? ENDPOINT,
      originHost: over.originHost ?? ORIGIN,
    });
    return { payload, signature: sign(message) };
  }

  it('accepts a valid EOA proof', async () => {
    const { payload, signature } = freshProof();
    const ok = await verifier.verifyProof({
      userId: ADDRESS, appId: APP, endpoint: ENDPOINT, originHost: ORIGIN, payload, signature,
    });
    assert.equal(ok, true);
  });

  it('rejects when the submitted endpoint differs from the signed one', async () => {
    const { payload, signature } = freshProof({ endpoint: ENDPOINT });
    const ok = await verifier.verifyProof({
      userId: ADDRESS, appId: APP, endpoint: 'https://push.example.com/OTHER',
      originHost: ORIGIN, payload, signature,
    });
    assert.equal(ok, false);
  });

  it('rejects when userId does not match the signer/payload address', async () => {
    const { payload, signature } = freshProof();
    const ok = await verifier.verifyProof({
      userId: '0x' + '1'.repeat(40), appId: APP, endpoint: ENDPOINT, originHost: ORIGIN, payload, signature,
    });
    assert.equal(ok, false);
  });

  it('rejects when the origin host does not match the signed domain', async () => {
    const { payload, signature } = freshProof({ originHost: ORIGIN });
    const ok = await verifier.verifyProof({
      userId: ADDRESS, appId: APP, endpoint: ENDPOINT, originHost: 'evil.example.com', payload, signature,
    });
    assert.equal(ok, false);
  });

  it('rejects an expired payload', async () => {
    const { payload, message } = verifier.buildChallenge({
      address: ADDRESS, appId: APP, endpoint: ENDPOINT, originHost: ORIGIN,
    });
    const expired = { ...payload, expiration_time: '2000-01-01T00:00:00.000Z' };
    // Sign the tampered message so only the time check (not the signature) fails.
    const ok = await verifier.verifyProof({
      userId: ADDRESS, appId: APP, endpoint: ENDPOINT, originHost: ORIGIN,
      payload: expired, signature: sign(message),
    });
    assert.equal(ok, false);
  });

  it('rejects a payload with a garbage (NaN) expiration_time', async () => {
    const { payload } = verifier.buildChallenge({
      address: ADDRESS, appId: APP, endpoint: ENDPOINT, originHost: ORIGIN,
    });
    const tampered = { ...payload, expiration_time: 'not-a-date' };
    // Sign the tampered message so only the freshness check (not the signature) fails.
    const ok = await verifier.verifyProof({
      userId: ADDRESS, appId: APP, endpoint: ENDPOINT, originHost: ORIGIN,
      payload: tampered, signature: sign(createLoginMessage(tampered)),
    });
    assert.equal(ok, false);
  });

  it('rejects a garbage signature', async () => {
    const { payload } = freshProof();
    const ok = await verifier.verifyProof({
      userId: ADDRESS, appId: APP, endpoint: ENDPOINT, originHost: ORIGIN,
      payload, signature: '0xnotreal',
    });
    assert.equal(ok, false);
  });
});

describe('viem verifier (integration — needs RPC)', () => {
  const RPC = process.env.SUBSCRIBE_VERIFY_RPC_URL;
  it('verifies a real EOA signature through viem (offline)', async (t) => {
    const { viemSignatureVerifier } = await import('../src/subscription-verify.js');
    const verify = viemSignatureVerifier({ subscribeVerifyRpcUrl: RPC ?? '', subscribeVerifyChainId: 8453 } as Config);
    const message = 'hello viem';
    const hash = PersonalMessage.getSignPayload(Hex.fromString(message));
    const signature = Signature.toHex(Secp256k1.sign({ payload: hash, privateKey: PRIVATE_KEY }));
    assert.equal(await verify({ address: ADDRESS, message, signature }), true);
  });

  it('rejects a wrong-address EOA signature', async function (t) {
    if (!RPC) return t.skip('set SUBSCRIBE_VERIFY_RPC_URL to run the contract-wallet fallback path');
    const { viemSignatureVerifier } = await import('../src/subscription-verify.js');
    const verify = viemSignatureVerifier({ subscribeVerifyRpcUrl: RPC, subscribeVerifyChainId: 8453 } as Config);
    const message = 'hello viem';
    const hash = PersonalMessage.getSignPayload(Hex.fromString(message));
    const signature = Signature.toHex(Secp256k1.sign({ payload: hash, privateKey: PRIVATE_KEY }));
    assert.equal(await verify({ address: '0x' + '2'.repeat(40), message, signature }), false);
  });
});

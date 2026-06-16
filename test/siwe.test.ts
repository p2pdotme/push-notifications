import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as Secp256k1 from 'ox/Secp256k1';
import * as PersonalMessage from 'ox/PersonalMessage';
import * as Signature from 'ox/Signature';
import * as Hex from 'ox/Hex';
import * as Address from 'ox/Address';
import { createLoginMessage, recoverSiweAddress, type LoginPayload } from '../src/siwe.js';

// Hardhat account #0 — a well-known test key. Never use in production.
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDRESS = Address.fromPublicKey(Secp256k1.getPublicKey({ privateKey: PRIVATE_KEY }));

function payload(over: Partial<LoginPayload> = {}): LoginPayload {
  return {
    domain: 'admin.push.p2p.me',
    address: ADDRESS,
    statement: 'Please ensure that the domain above matches the URL of the current website.',
    uri: 'admin.push.p2p.me',
    version: '1',
    nonce: 'abc123',
    issued_at: '2026-06-16T00:00:00.000Z',
    expiration_time: '2026-06-16T00:10:00.000Z',
    invalid_before: '2026-06-15T23:50:00.000Z',
    ...over,
  };
}

function signPayload(p: LoginPayload): string {
  const hash = PersonalMessage.getSignPayload(Hex.fromString(createLoginMessage(p)));
  return Signature.toHex(Secp256k1.sign({ payload: hash, privateKey: PRIVATE_KEY }));
}

describe('createLoginMessage', () => {
  it('produces the EIP-4361 header and ordered fields', () => {
    const msg = createLoginMessage(payload());
    assert.ok(msg.startsWith('admin.push.p2p.me wants you to sign in with your Ethereum account:'));
    assert.ok(msg.includes('\nVersion: 1\n'));
    assert.ok(msg.includes('Nonce: abc123'));
    assert.ok(msg.includes('Expiration Time: 2026-06-16T00:10:00.000Z'));
    assert.ok(msg.includes('Not Before: 2026-06-15T23:50:00.000Z'));
  });
});

describe('recoverSiweAddress', () => {
  it('recovers the signer for a valid signature', () => {
    const p = payload();
    assert.equal(recoverSiweAddress(p, signPayload(p)), ADDRESS.toLowerCase());
  });

  it('returns a different address if the payload is tampered after signing', () => {
    const p = payload();
    const sig = signPayload(p);
    const tampered = payload({ nonce: 'different' });
    assert.notEqual(recoverSiweAddress(tampered, sig), ADDRESS.toLowerCase());
  });

  it('returns null for a malformed signature', () => {
    assert.equal(recoverSiweAddress(payload(), 'not-a-signature'), null);
  });
});

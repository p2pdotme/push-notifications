import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  subscribeSchema,
  subscriptionChallengeSchema,
  updateAppSchema,
} from '../src/schemas.js';

describe('subscriptionChallengeSchema', () => {
  it('accepts a valid address + endpoint', () => {
    const v = subscriptionChallengeSchema.parse({
      appId: 'user-app',
      address: '0x' + 'a'.repeat(40),
      endpoint: 'https://push.example.com/abc',
    });
    assert.equal(v.appId, 'user-app');
  });

  it('rejects a non-address', () => {
    assert.throws(() =>
      subscriptionChallengeSchema.parse({ appId: 'a', address: 'nope', endpoint: 'https://x' }),
    );
  });
});

describe('subscribeSchema', () => {
  it('accepts an optional payload + signature', () => {
    const v = subscribeSchema.parse({
      appId: 'user-app',
      userId: '0x' + 'b'.repeat(40),
      subscription: { endpoint: 'https://push.example.com/a', keys: { p256dh: 'p', auth: 'a' } },
      payload: {
        domain: 'app.example.com', address: '0x' + 'b'.repeat(40), version: '1',
        nonce: 'n', issued_at: 't', expiration_time: 't', invalid_before: 't',
        resources: ['push-channel:user-app:deadbeef'],
      },
      signature: '0xsig',
    });
    assert.equal(v.signature, '0xsig');
  });

  it('still accepts the legacy body without proof', () => {
    const v = subscribeSchema.parse({
      appId: 'user-app',
      userId: 'alice',
      subscription: { endpoint: 'https://push.example.com/a', keys: { p256dh: 'p', auth: 'a' } },
    });
    assert.equal(v.payload, undefined);
  });
});

describe('updateAppSchema', () => {
  it('accepts requireSubscriptionSignature alone', () => {
    const v = updateAppSchema.parse({ requireSubscriptionSignature: true });
    assert.equal(v.requireSubscriptionSignature, true);
  });
});

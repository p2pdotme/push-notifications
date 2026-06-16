import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateApiKey, hashApiKey } from '../src/api-keys.js';

describe('api-keys', () => {
  it('generates a prefixed secret with a matching hash and prefix', () => {
    const k = generateApiKey();
    assert.match(k.secret, /^pk_[A-Za-z0-9]{32,}$/);
    assert.equal(k.keyHash, hashApiKey(k.secret));
    assert.ok(k.secret.startsWith(k.keyPrefix));
    assert.equal(k.keyPrefix.length, 10); // "pk_" + 7 chars
  });

  it('hashes deterministically and differs per secret', () => {
    assert.equal(hashApiKey('pk_abc'), hashApiKey('pk_abc'));
    assert.notEqual(hashApiKey('pk_abc'), hashApiKey('pk_def'));
  });
});

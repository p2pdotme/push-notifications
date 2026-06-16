import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { issueJwt, verifyJwt } from '../src/jwt.js';

const SECRET = 'unit-test-secret';

describe('jwt', () => {
  it('round-trips and lowercases the address', () => {
    const token = issueJwt(SECRET, '0xAbC', 3600);
    assert.deepEqual(verifyJwt(SECRET, token), { address: '0xabc' });
  });

  it('rejects a token signed with a different secret', () => {
    const token = issueJwt(SECRET, '0xabc', 3600);
    assert.equal(verifyJwt('other-secret', token), null);
  });

  it('rejects an expired token', () => {
    const token = issueJwt(SECRET, '0xabc', -1);
    assert.equal(verifyJwt(SECRET, token), null);
  });

  it('rejects a structurally invalid token', () => {
    assert.equal(verifyJwt(SECRET, 'garbage'), null);
    assert.equal(verifyJwt(SECRET, 'a.b'), null);
  });
});

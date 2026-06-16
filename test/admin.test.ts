import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAuthService } from './fake-auth-service.js';

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

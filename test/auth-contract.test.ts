import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createThirdwebClient } from 'thirdweb';
import { privateKeyToAccount } from 'thirdweb/wallets';
import { signLoginPayload } from 'thirdweb/auth';
import { recoverSiweAddress, type LoginPayload } from '../src/siwe.js';
import { createAuthService } from '../src/auth-service.js';
import type { Config } from '../src/config.js';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const client = createThirdwebClient({ secretKey: 'contract-test' });
const account = privateKeyToAccount({ client, privateKey: PRIVATE_KEY });

const config = { authDomain: 'admin.push.p2p.me', jwtSecret: 'test-secret' } as Config;

describe('thirdweb client ⇄ our verifier contract', () => {
  it('our verifier recovers the signer of a thirdweb-signed payload', async () => {
    const svc = createAuthService(config);
    const payload = (await svc.generatePayload(account.address)) as LoginPayload;

    // thirdweb's CLIENT builds the EIP-4361 message its own way and signs it.
    const { signature } = await signLoginPayload({ payload, account });

    assert.equal(recoverSiweAddress(payload, signature), account.address.toLowerCase());

    const result = await svc.verifyAndIssueJwt(payload, signature);
    assert.ok(result, 'thirdweb-signed payload must be accepted');
    assert.equal(result!.address, account.address.toLowerCase());
  });

  it('rejects a thirdweb-signed payload if the address is swapped', async () => {
    const svc = createAuthService(config);
    const payload = (await svc.generatePayload(account.address)) as LoginPayload;
    const { signature } = await signLoginPayload({ payload, account });
    const tampered = { ...payload, address: '0x0000000000000000000000000000000000000001' };
    assert.equal(await svc.verifyAndIssueJwt(tampered, signature), null);
  });
});

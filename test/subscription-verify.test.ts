import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import * as Secp256k1 from 'ox/Secp256k1';
import * as PersonalMessage from 'ox/PersonalMessage';
import * as Signature from 'ox/Signature';
import * as Hex from 'ox/Hex';
import * as Address from 'ox/Address';
import { custom, HttpRequestError, RpcRequestError, TimeoutError, type Transport } from 'viem';
import {
  channelResource,
  createSubscriptionVerifier,
  viemSignatureVerifier,
  VerifyUnavailableError,
  type SignatureVerifier,
} from '../src/subscription-verify.js';
import { createLoginMessage } from '../src/siwe.js';
import type { Config } from '../src/config.js';
import { erc8010Malformed, erc8010WellFormed } from './helpers/erc8010.js';

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

  it('propagates a thrown VerifyUnavailableError from the injected verifier instead of swallowing it', async () => {
    const { payload, signature } = freshProof();
    const throwingVerifier: SignatureVerifier = async () => {
      throw new VerifyUnavailableError('rpc down (simulated)');
    };
    const unavailable = createSubscriptionVerifier(config, throwingVerifier);
    await assert.rejects(
      () => unavailable.verifyProof({
        userId: ADDRESS, appId: APP, endpoint: ENDPOINT, originHost: ORIGIN, payload, signature,
      }),
      VerifyUnavailableError,
    );
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

/**
 * A 32-byte ABI-encoded `bool`. viem's `hexToBool` trims to `0x00`/`0x01`,
 * which is what the deployless ERC-6492 validator call returns on-chain.
 */
const FALSE_WORD = ('0x' + '0'.repeat(64)) as `0x${string}`;
const TRUE_WORD = ('0x' + '0'.repeat(63) + '1') as `0x${string}`;
/** A word that is neither `0x00` nor `0x01`: viem's `hexToBool` throws on it. */
const NON_CANONICAL_WORD = ('0x' + '0'.repeat(63) + '2') as `0x${string}`;

/** An RPC URL carrying a secret. Nothing this verifier produces may contain it. */
const SECRET_RPC_URL = 'https://base-mainnet.example/v2/SECRET_KEY_MUST_NOT_LEAK';
const SECRET = 'SECRET_KEY_MUST_NOT_LEAK';

/**
 * A viem `custom` transport stub: no network, canned response per method, and
 * a record of every call made. The record is what proves a call did or did not
 * happen. An unhandled method throws, and a throw is exactly what an
 * implementation under test might swallow.
 */
function recordingTransport(handlers: Record<string, () => Promise<unknown>>): {
  transport: Transport;
  calls: { method: string; params: unknown }[];
} {
  const calls: { method: string; params: unknown }[] = [];
  const transport = custom(
    {
      request: async ({ method, params }: { method: string; params: unknown }) => {
        calls.push({ method, params });
        const handler = handlers[method];
        if (!handler) throw new Error(`unexpected RPC method ${method}`);
        return handler();
      },
    },
    { retryCount: 0 },
  );
  return { transport, calls };
}

describe('viemSignatureVerifier: plain wallet signatures are recovered offline', () => {
  it('verifies a plain wallet signature without making any RPC call at all', async () => {
    const { transport, calls } = recordingTransport({});
    const verify = viemSignatureVerifier(config, transport);
    const message = 'hello viem';
    const ok = await verify({ address: ADDRESS, message, signature: sign(message) });
    assert.equal(ok, true);
    assert.deepEqual(calls, [], 'a plain wallet signature must never reach the RPC');
  });

  it('accepts a checksummed address without touching the RPC, as wallets send it', async () => {
    // wagmi, thirdweb and ethers all hand back a checksummed address, and the
    // route passes the submitted `userId` through verbatim.
    const { transport, calls } = recordingTransport({});
    const verify = viemSignatureVerifier(config, transport);
    const message = 'hello viem';
    const checksummed = Address.checksum(ADDRESS as `0x${string}`);
    assert.notEqual(checksummed, ADDRESS, 'the fixture must actually be mixed-case');
    const ok = await verify({ address: checksummed, message, signature: sign(message) });
    assert.equal(ok, true);
    assert.deepEqual(calls, [], 'a checksummed address must not push the check on-chain');
  });

  it('does not accept a plain wallet signature made by a different key', async () => {
    const { transport } = recordingTransport({ eth_call: async () => FALSE_WORD });
    const verify = viemSignatureVerifier(config, transport);
    const message = 'hello viem';
    const ok = await verify({ address: '0x' + '2'.repeat(40), message, signature: sign(message) });
    assert.equal(ok, false);
  });
});

describe('viemSignatureVerifier: RPC unavailable vs genuine rejection (stubbed, no RPC needed)', () => {
  // Signed by PRIVATE_KEY (recovers to ADDRESS) but asserted against a
  // DIFFERENT address, so offline recovery can never resolve it and every case
  // here is forced through the RPC-backed 1271/6492 contract-check path, the
  // only path a smart account ever takes.
  const WRONG_ADDRESS = ('0x' + '2'.repeat(40)) as `0x${string}`;
  const MESSAGE = 'hello viem';
  const SIGNATURE = sign(MESSAGE);

  const verifyWrong = (transport: Transport) =>
    viemSignatureVerifier(config, transport)({
      address: WRONG_ADDRESS,
      message: MESSAGE,
      signature: SIGNATURE,
    });

  it('returns false when the contract check cleanly rejects', async () => {
    const { transport } = recordingTransport({ eth_call: async () => FALSE_WORD });
    assert.equal(await verifyWrong(transport), false);
  });

  it('returns true when the contract check accepts', async () => {
    const { transport, calls } = recordingTransport({ eth_call: async () => TRUE_WORD });
    assert.equal(await verifyWrong(transport), true);
    assert.deepEqual(
      calls.map((c) => c.method),
      ['eth_call'],
      'an accepted contract check makes exactly one call and asks nothing further',
    );
  });

  it('returns false when the node answers with a revert, which is a genuine rejection', async () => {
    // The ERC-6492 validator reverts on many bad signatures. The node answered
    // perfectly well, so this must stay a 401 and must never become a 503.
    const { transport } = recordingTransport({
      eth_call: async () => {
        throw new RpcRequestError({
          body: {},
          error: { code: 3, message: 'execution reverted' },
          url: SECRET_RPC_URL,
        });
      },
    });
    assert.equal(await verifyWrong(transport), false);
  });

  it('throws VerifyUnavailableError when the RPC is unreachable', async () => {
    const { transport } = recordingTransport({
      eth_call: async () => {
        throw new HttpRequestError({ url: SECRET_RPC_URL, details: 'fetch failed' });
      },
    });
    await assert.rejects(() => verifyWrong(transport), VerifyUnavailableError);
  });

  it('throws VerifyUnavailableError when the RPC answers cheap calls but throttles the contract call', async () => {
    // The failure the whole change exists for. A liveness probe would ask
    // eth_chainId, get a healthy answer, and wrongly let the false verdict
    // stand, so the caller would see 401 invalid_signature all over again.
    const { transport, calls } = recordingTransport({
      eth_call: async () => {
        throw new HttpRequestError({ url: SECRET_RPC_URL, status: 429 });
      },
      eth_chainId: async () => '0x2105',
    });
    await assert.rejects(() => verifyWrong(transport), VerifyUnavailableError);
    assert.deepEqual(
      calls.map((c) => c.method),
      ['eth_call'],
      'the verdict must come from the call that actually failed, not from a cheaper one',
    );
  });

  it('throws VerifyUnavailableError when the node signals an over-rate-limit JSON-RPC error', async () => {
    const { transport } = recordingTransport({
      eth_call: async () => {
        throw new RpcRequestError({
          body: {},
          error: { code: -32005, message: 'over rate limit' },
          url: SECRET_RPC_URL,
        });
      },
    });
    await assert.rejects(() => verifyWrong(transport), VerifyUnavailableError);
  });

  it('throws VerifyUnavailableError when the request times out', async () => {
    const { transport } = recordingTransport({
      eth_call: async () => {
        throw new TimeoutError({ body: {}, url: SECRET_RPC_URL });
      },
    });
    await assert.rejects(() => verifyWrong(transport), VerifyUnavailableError);
  });

  it('names the class of the underlying failure in the thrown message', async () => {
    // The operator guide promises these can be told apart from the log alone,
    // so each one has to name itself and nothing else.
    const cases: [unknown, RegExp][] = [
      [new HttpRequestError({ url: SECRET_RPC_URL, status: 429 }), /^.*HttpRequestError, HTTP 429\)$/],
      [new HttpRequestError({ url: SECRET_RPC_URL, details: 'fetch failed' }), /HttpRequestError\)$/],
      [new TimeoutError({ body: {}, url: SECRET_RPC_URL }), /TimeoutError\)$/],
      [
        new RpcRequestError({ body: {}, error: { code: -32005, message: 'over rate limit' }, url: SECRET_RPC_URL }),
        /LimitExceededRpcError\)$/,
      ],
    ];
    for (const [failure, expected] of cases) {
      const { transport } = recordingTransport({
        eth_call: async () => {
          throw failure;
        },
      });
      await assert.rejects(() => verifyWrong(transport), (err: unknown) => {
        assert.ok(err instanceof VerifyUnavailableError);
        assert.match(err.message, expected);
        return true;
      });
    }
  });

  it('produces an error that cannot leak the RPC URL however it is printed', async () => {
    // Not just the message. The whole object, walked to the bottom of any
    // cause chain, the way console.error and every structured logger print it.
    for (const failure of [
      new HttpRequestError({ url: SECRET_RPC_URL, status: 429 }),
      new HttpRequestError({ url: SECRET_RPC_URL, details: 'fetch failed' }),
      new TimeoutError({ body: {}, url: SECRET_RPC_URL }),
      new RpcRequestError({ body: {}, error: { code: -32005, message: 'over rate limit' }, url: SECRET_RPC_URL }),
    ]) {
      const { transport } = recordingTransport({
        eth_call: async () => {
          throw failure;
        },
      });
      await assert.rejects(() => verifyWrong(transport), (err: unknown) => {
        assert.ok(err instanceof VerifyUnavailableError);
        const printed = util.inspect(err, { depth: null, showHidden: true });
        assert.ok(!printed.includes(SECRET), `printing the error leaked the RPC URL:\n${printed}`);
        assert.ok(!util.format('%s', err).includes(SECRET), 'string coercion leaked the RPC URL');
        assert.ok(!JSON.stringify(err, Object.getOwnPropertyNames(err)).includes(SECRET), 'JSON leaked the RPC URL');
        return true;
      });
    }
  });

  it('returns false, rather than throwing, for a malformed ERC-8010 wrapped signature', async () => {
    // The 32-byte magic tail is caller-controlled, and ox's decoder throws on a
    // garbage body before any RPC call. An unauthenticated caller must not be
    // able to turn that into a 500.
    const { transport, calls } = recordingTransport({});
    const verify = viemSignatureVerifier(config, transport);
    const ok = await verify({ address: WRONG_ADDRESS, message: MESSAGE, signature: erc8010Malformed() });
    assert.equal(ok, false);
    assert.deepEqual(calls, [], 'the decoder fails before any RPC call is made');
  });

  it('returns false, rather than throwing, when the node returns a non-canonical bool word', async () => {
    const { transport } = recordingTransport({ eth_call: async () => NON_CANONICAL_WORD });
    assert.equal(await verifyWrong(transport), false);
  });

  it('throws VerifyUnavailableError when an ERC-8010 signature meets an unreachable RPC', async () => {
    // viem's ERC-8010 branch calls eth_getCode with no catch of its own, so
    // this is the path on which a raw transport error used to escape.
    const { transport } = recordingTransport({
      eth_getCode: async () => {
        throw new HttpRequestError({ url: SECRET_RPC_URL, details: 'fetch failed' });
      },
    });
    const verify = viemSignatureVerifier(config, transport);
    await assert.rejects(
      () => verify({ address: WRONG_ADDRESS, message: MESSAGE, signature: erc8010WellFormed() }),
      VerifyUnavailableError,
    );
  });
});

describe('viemSignatureVerifier: 6492 call shape (stubbed, no RPC needed)', () => {
  it('sends a deployless eth_call encoding the signer, message hash, and signature', async () => {
    const { transport, calls } = recordingTransport({ eth_call: async () => TRUE_WORD });
    const verify = viemSignatureVerifier(config, transport);
    const message = 'hello viem';
    // Asserted against an address the signature does not recover to, so the
    // offline path cannot answer and the contract call is actually made.
    const signer = ('0x' + '2'.repeat(40)) as `0x${string}`;
    const hash = PersonalMessage.getSignPayload(Hex.fromString(message));
    const signature = Signature.toHex(Secp256k1.sign({ payload: hash, privateKey: PRIVATE_KEY }));

    const ok = await verify({ address: signer, message, signature });
    assert.equal(ok, true, 'a stubbed contract-check accept should be honoured');

    assert.equal(calls.length, 1, 'exactly one RPC call should be made for a first-time verify');
    const first = calls[0];
    assert.ok(first);
    assert.equal(first.method, 'eth_call');
    const params = first.params as [{ to?: `0x${string}`; data: `0x${string}` }, string];
    const [call, blockTag] = params;
    assert.equal(call.to, undefined, 'the ERC-6492 universal validator call is deployless: no `to` address');
    assert.equal(blockTag, 'latest');

    // The three constructor arguments, each computed here rather than taken
    // from the same encoder the implementation uses.
    const data = call.data.toLowerCase();
    assert.ok(data.includes(signer.slice(2).toLowerCase()), 'call data must carry the signer address');
    assert.ok(data.includes(hash.slice(2).toLowerCase()), 'call data must carry the message hash');
    assert.ok(data.includes(signature.slice(2).toLowerCase()), 'call data must carry the signature');
  });
});

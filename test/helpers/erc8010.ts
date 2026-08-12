/**
 * Builders for ERC-8010 wrapped signatures.
 *
 * viem's `verifyHash` routes to its ERC-8010 branch whenever the last 32 bytes
 * of the signature equal a fixed magic value (ox `SignatureErc8010.magicBytes`,
 * validated by comparing the tail). The signature is an unvalidated string from
 * an unauthenticated request body, so any caller can select that branch. These
 * helpers build both shapes so tests can exercise it:
 *
 * - `erc8010WellFormed` unwraps cleanly, so viem reaches `eth_getCode`, which
 *   it calls with no catch of its own.
 * - `erc8010Malformed` throws inside ox's decoder before any RPC call happens.
 */

/** ox `SignatureErc8010.magicBytes`, without the leading `0x`. */
const MAGIC = '8010'.repeat(16);

const word = (hex: string): string => hex.padStart(64, '0');

function wrap(suffix: string): `0x${string}` {
  const length = (suffix.length / 2).toString(16).padStart(64, '0');
  return `0x${'aa'.repeat(65)}${suffix}${length}${MAGIC}`;
}

/**
 * Suffix ABI is `(uint256 chainId, address delegation, uint256 nonce,
 * uint8 yParity, uint256 r, uint256 s), address to, bytes data`: six static
 * tuple words, the `to` address, an offset to `data`, then an empty `data`.
 */
export function erc8010WellFormed(): `0x${string}` {
  return wrap(
    word('2105') + word('1'.repeat(40)) + word('0') + word('0') + word('1') + word('1') +
      word('2'.repeat(40)) + word('100') + word('0'),
  );
}

/** Correct magic tail, garbage body: ox's decoder throws before any RPC call. */
export function erc8010Malformed(): `0x${string}` {
  return wrap(word('ff'));
}

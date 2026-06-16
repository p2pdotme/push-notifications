import { randomBytes } from 'node:crypto';
import * as Hex from 'ox/Hex';
import * as PersonalMessage from 'ox/PersonalMessage';
import * as Secp256k1 from 'ox/Secp256k1';
import * as Signature from 'ox/Signature';

/** EIP-4361 / CAIP-122 login payload (same shape the thirdweb client signs). */
export interface LoginPayload {
  domain: string;
  address: string;
  statement: string;
  uri?: string;
  version: string;
  chain_id?: string;
  nonce: string;
  issued_at: string;
  expiration_time: string;
  invalid_before: string;
  resources?: string[];
}

/**
 * Build the EIP-4361 message to sign. Copied verbatim from thirdweb's internal
 * `createLoginMessage` so the bytes we verify match exactly what the dashboard's
 * thirdweb client produces. The Task 5 contract test guards this equivalence.
 */
export function createLoginMessage(payload: LoginPayload): string {
  const typeField = 'Ethereum';
  const header = `${payload.domain} wants you to sign in with your ${typeField} account:`;
  let prefix = [header, payload.address].join('\n');
  prefix = [prefix, payload.statement].join('\n\n');
  if (payload.statement) {
    prefix += '\n';
  }
  const suffixArray: string[] = [];
  if (payload.uri) {
    suffixArray.push(`URI: ${payload.uri}`);
  }
  suffixArray.push(`Version: ${payload.version}`);
  if (payload.chain_id) {
    suffixArray.push(`Chain ID: ${payload.chain_id}`);
  }
  suffixArray.push(`Nonce: ${payload.nonce}`);
  suffixArray.push(`Issued At: ${payload.issued_at}`);
  suffixArray.push(`Expiration Time: ${payload.expiration_time}`);
  if (payload.invalid_before) {
    suffixArray.push(`Not Before: ${payload.invalid_before}`);
  }
  if (payload.resources) {
    suffixArray.push(['Resources:', ...payload.resources.map((x) => `- ${x}`)].join('\n'));
  }
  const suffix = suffixArray.join('\n');
  return [prefix, suffix].join('\n');
}

/** 16 random bytes as hex — single-use nonce for a login payload. */
export function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Recover the EOA address that signed this payload (EIP-191 personal_sign over
 * the EIP-4361 message), lowercased. Returns null on any malformed input —
 * honouring a "bad input is a failure, not a throw" contract.
 */
export function recoverSiweAddress(payload: LoginPayload, signature: string): string | null {
  try {
    const message = createLoginMessage(payload);
    const hash = PersonalMessage.getSignPayload(Hex.fromString(message));
    const address = Secp256k1.recoverAddress({
      payload: hash,
      signature: Signature.fromHex(signature as `0x${string}`),
    });
    return address.toLowerCase();
  } catch {
    return null;
  }
}

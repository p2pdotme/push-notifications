import type { AuthService } from '../src/auth-service.js';

/**
 * Deterministic in-memory AuthService for tests. A "token" is the literal
 * string `faketoken:<address>` so tests can forge an admin Bearer header
 * directly without running the full SIWE flow.
 */
export class FakeAuthService implements AuthService {
  async generatePayload(address: string): Promise<unknown> {
    return { address, nonce: 'test-nonce' };
  }

  async verifyAndIssueJwt(
    payload: unknown,
    _signature: string,
  ): Promise<{ address: string; token: string } | null> {
    const address = (payload as { address?: string }).address?.toLowerCase();
    if (!address) return null;
    return { address, token: `faketoken:${address}` };
  }

  async verifyJwt(token: string): Promise<{ address: string } | null> {
    const prefix = 'faketoken:';
    if (!token.startsWith(prefix)) return null;
    return { address: token.slice(prefix.length).toLowerCase() };
  }
}

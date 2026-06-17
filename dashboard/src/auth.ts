import { API_BASE_URL } from './client.js';

const TOKEN_KEY = 'push_admin_jwt';

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string): void => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

/**
 * thirdweb ConnectButton auth config. getLoginPayload/doLogin call our backend;
 * the issued JWT is stored in localStorage and sent as a Bearer token by api.ts.
 */
export const authConfig = {
  isLoggedIn: async (): Promise<boolean> => {
    const token = getToken();
    if (!token) return false;
    const res = await fetch(`${API_BASE_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  },

  getLoginPayload: async (params: { address: string; chainId?: number }) => {
    // A fresh sign-in attempt has started — clear any stale "not authorized"
    // banner so it doesn't linger if this attempt succeeds.
    window.dispatchEvent(new Event('push-admin-login-start'));
    const res = await fetch(`${API_BASE_URL}/auth/payload?address=${params.address}`);
    if (!res.ok) throw new Error('Failed to get login payload');
    return res.json();
  },

  doLogin: async (params: unknown): Promise<void> => {
    const res = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string; address?: string };
      // A 403 means the signature was valid but the wallet isn't an admin yet.
      // Surface the resolved address so the UI can tell the operator exactly
      // which wallet to add to ADMIN_WALLETS.
      if (res.status === 403 && err.address) {
        window.dispatchEvent(
          new CustomEvent('push-admin-not-authorized', { detail: { address: err.address } }),
        );
      }
      const hint = err.address ? ` Your wallet: ${err.address}` : '';
      throw new Error(`${err.error ?? 'Login failed'}.${hint}`);
    }
    const body = (await res.json()) as { token: string };
    setToken(body.token);
    window.dispatchEvent(new Event('push-admin-authorized'));
  },

  doLogout: async (): Promise<void> => {
    clearToken();
  },
};

import { API_BASE_URL } from './client.js';
import { clearToken, getToken } from './auth.js';

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    clearToken();
    // Tell the app shell to drop the wallet session and return to the login gate.
    window.dispatchEvent(new Event('push-admin-unauthorized'));
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? (null as T) : ((await res.json()) as T);
}

export interface AppRecord { appId: string; name: string; disabled: boolean; requireSubscriptionSignature: boolean; createdAt: string }
export interface ApiKeyRecord {
  id: number; appId: string; keyPrefix: string; label: string | null;
  createdBy: string | null; createdAt: string; lastUsedAt: string | null; revokedAt: string | null;
}
export interface IssuedKey extends ApiKeyRecord { secret: string }
export interface CorsOriginRecord { id: number; appId: string; origin: string; createdAt: string }
export interface AdminRecord { address: string; label: string | null; addedBy: string | null; createdAt: string }

export const api = {
  listApps: () => req<AppRecord[]>('/admin/apps'),
  createApp: (b: { appId: string; name: string }) => req<AppRecord>('/admin/apps', { method: 'POST', body: JSON.stringify(b) }),
  deleteApp: (appId: string) => req<null>(`/admin/apps/${appId}`, { method: 'DELETE' }),
  updateApp: (appId: string, b: { name?: string; disabled?: boolean; requireSubscriptionSignature?: boolean }) =>
    req<AppRecord>(`/admin/apps/${appId}`, { method: 'PATCH', body: JSON.stringify(b) }),

  listKeys: (appId: string) => req<ApiKeyRecord[]>(`/admin/apps/${appId}/keys`),
  createKey: (appId: string, b: { label?: string }) => req<IssuedKey>(`/admin/apps/${appId}/keys`, { method: 'POST', body: JSON.stringify(b) }),
  revokeKey: (id: number) => req<null>(`/admin/keys/${id}`, { method: 'DELETE' }),

  listOrigins: (appId: string) => req<CorsOriginRecord[]>(`/admin/apps/${appId}/origins`),
  addOrigin: (appId: string, b: { origin: string }) => req<CorsOriginRecord>(`/admin/apps/${appId}/origins`, { method: 'POST', body: JSON.stringify(b) }),
  deleteOrigin: (id: number) => req<null>(`/admin/origins/${id}`, { method: 'DELETE' }),

  listAdmins: () => req<{ bootstrap: string[]; managed: AdminRecord[] }>('/admin/admins'),
  addAdmin: (b: { address: string; label?: string }) => req<AdminRecord>('/admin/admins', { method: 'POST', body: JSON.stringify(b) }),
  removeAdmin: (address: string) => req<null>(`/admin/admins/${address}`, { method: 'DELETE' }),
};

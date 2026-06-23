import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type ApiKeyRecord, type CorsOriginRecord } from '../api.js';

export function AppDetail() {
  const { appId = '' } = useParams();
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [origins, setOrigins] = useState<CorsOriginRecord[]>([]);
  const [label, setLabel] = useState('');
  const [origin, setOrigin] = useState('');
  const [issued, setIssued] = useState<string>('');
  const [error, setError] = useState('');
  const [requireSig, setRequireSig] = useState(false);

  const load = async () => {
    try {
      const apps = await api.listApps();
      const app = apps.find((a) => a.appId === appId);
      setRequireSig(app?.requireSubscriptionSignature ?? false);
      setKeys(await api.listKeys(appId));
      setOrigins(await api.listOrigins(appId));
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, [appId]);

  const issue = async () => {
    setError('');
    try {
      const k = await api.createKey(appId, { label: label || undefined });
      setIssued(k.secret); setLabel('');
      await load();
    } catch (e) { setError((e as Error).message); }
  };

  const revoke = async (id: number) => { await api.revokeKey(id); await load(); };
  const addOrigin = async () => {
    setError('');
    try { await api.addOrigin(appId, { origin }); setOrigin(''); await load(); }
    catch (e) { setError((e as Error).message); }
  };
  const removeOrigin = async (id: number) => { await api.deleteOrigin(id); await load(); };

  const toggleRequireSig = async () => {
    setError('');
    try {
      const next = !requireSig;
      await api.updateApp(appId, { requireSubscriptionSignature: next });
      setRequireSig(next);
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <section>
      <h1>{appId}</h1>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      <h3>Subscription security</h3>
      <label>
        <input type="checkbox" checked={requireSig} onChange={toggleRequireSig} />{' '}
        Require a wallet signature to subscribe (EOA + smart wallets)
      </label>

      <h3>API keys</h3>
      {issued && (
        <p style={{ background: '#fffbcc', padding: 8 }}>
          New key (copy now, shown once): <code>{issued}</code>
        </p>
      )}
      <ul>
        {keys.map((k) => (
          <li key={k.id}>
            <code>{k.keyPrefix}…</code> {k.label ?? ''} {k.revokedAt ? '(revoked)' : ''}
            {!k.revokedAt && <> <button onClick={() => revoke(k.id)}>revoke</button></>}
          </li>
        ))}
      </ul>
      <input placeholder="label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
      <button onClick={issue}>Issue key</button>

      <h3>CORS origins</h3>
      <ul>
        {origins.map((o) => (
          <li key={o.id}>{o.origin} <button onClick={() => removeOrigin(o.id)}>remove</button></li>
        ))}
      </ul>
      <input placeholder="https://app.example.com" value={origin} onChange={(e) => setOrigin(e.target.value)} />
      <button onClick={addOrigin}>Add origin</button>
    </section>
  );
}

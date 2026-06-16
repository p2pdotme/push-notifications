import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AppRecord } from '../api.js';

export function Apps() {
  const [apps, setApps] = useState<AppRecord[]>([]);
  const [appId, setAppId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const load = () => api.listApps().then(setApps).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    setError('');
    try {
      await api.createApp({ appId, name });
      setAppId(''); setName('');
      await load();
    } catch (e) { setError((e as Error).message); }
  };

  const remove = async (id: string) => {
    if (!confirm(`Delete app ${id}? This removes its keys and origins.`)) return;
    await api.deleteApp(id);
    await load();
  };

  return (
    <section>
      <h1>Apps</h1>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <ul>
        {apps.map((a) => (
          <li key={a.appId}>
            <Link to={`/apps/${a.appId}`}>{a.appId}</Link> — {a.name}{a.disabled ? ' (disabled)' : ''}
            {' '}<button onClick={() => remove(a.appId)}>delete</button>
          </li>
        ))}
      </ul>
      <h3>Create app</h3>
      <input placeholder="app-id" value={appId} onChange={(e) => setAppId(e.target.value)} />
      <input placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} />
      <button onClick={create}>Create</button>
    </section>
  );
}

import { useEffect, useState } from 'react';
import { api, type AdminRecord } from '../api.js';

export function Admins() {
  const [bootstrap, setBootstrap] = useState<string[]>([]);
  const [managed, setManaged] = useState<AdminRecord[]>([]);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try { const r = await api.listAdmins(); setBootstrap(r.bootstrap); setManaged(r.managed); }
    catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, []);

  const add = async () => {
    setError('');
    try { await api.addAdmin({ address, label: label || undefined }); setAddress(''); setLabel(''); await load(); }
    catch (e) { setError((e as Error).message); }
  };
  const remove = async (a: string) => { await api.removeAdmin(a); await load(); };

  return (
    <section>
      <h1>Admins</h1>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <h3>Bootstrap (env, read-only)</h3>
      <ul>{bootstrap.map((a) => <li key={a}><code>{a}</code></li>)}</ul>
      <h3>Managed</h3>
      <ul>
        {managed.map((a) => (
          <li key={a.address}><code>{a.address}</code> {a.label ?? ''} <button onClick={() => remove(a.address)}>remove</button></li>
        ))}
      </ul>
      <input placeholder="0x… address" value={address} onChange={(e) => setAddress(e.target.value)} />
      <input placeholder="label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
      <button onClick={add}>Add admin</button>
    </section>
  );
}

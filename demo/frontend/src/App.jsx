import { useEffect, useState } from 'react';
import { usePush } from '@p2pdotme/push-client/react';

// A stable per-browser id so the backend can target "this device".
function getUserId() {
  let id = localStorage.getItem('demo-user-id');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
    localStorage.setItem('demo-user-id', id);
  }
  return id;
}

export function App() {
  const [config, setConfig] = useState(null); // { pushBase, appId }
  const [title, setTitle] = useState('Hello from demo.lmao.cl!');
  const [body, setBody] = useState('Your test notification arrived 🎉');
  const [status, setStatus] = useState({ msg: '', kind: '' });
  const userId = getUserId();

  // The PWA subscribes directly against the central push service; the backend
  // tells us which one (pushBase) and as which app (appId).
  useEffect(() => {
    fetch('/config.json')
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig({ pushBase: '', appId: 'demo-app' }));
  }, []);

  const push = usePush({
    serverUrl: config?.pushBase ?? '',
    appId: config?.appId ?? 'demo-app',
    serviceWorkerUrl: '/push-sw.js',
    userId,
  });

  const ready = Boolean(config);

  async function enable() {
    setStatus({ msg: 'Enabling…', kind: '' });
    try {
      await push.subscribe();
      setStatus({ msg: 'Done. Now send a notification.', kind: 'ok' });
    } catch (err) {
      setStatus({ msg: err.message, kind: 'err' });
    }
  }

  async function send(broadcast) {
    setStatus({ msg: 'Sending…', kind: '' });
    try {
      const payload = broadcast ? { title, body } : { userId, title, body };
      const res = await fetch(broadcast ? '/api/broadcast' : '/api/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      const label = broadcast ? 'Broadcast' : 'Sent';
      setStatus({
        msg: `${label}: sent=${data.sent ?? 0} failed=${data.failed ?? 0} expired=${data.expired ?? 0}`,
        kind: 'ok',
      });
    } catch (err) {
      setStatus({ msg: err.message, kind: 'err' });
    }
  }

  const line = push.error ? { msg: push.error.message, kind: 'err' } : status;

  return (
    <main>
      <div className="card">
        <h1>
          <img src="/icon.svg" alt="" /> Push Demo
        </h1>
        <p className="sub">Subscribe and fire a real web push notification (React + usePush).</p>

        <button
          className="primary"
          disabled={!push.supported || !ready || push.loading || push.subscribed}
          onClick={enable}
        >
          {push.subscribed ? 'Notifications enabled ✓' : 'Enable notifications'}
        </button>

        {!push.supported && <p className="sub">This browser does not support web push.</p>}

        <hr />

        <label htmlFor="title">Title</label>
        <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <label htmlFor="body">Message</label>
        <input id="body" value={body} onChange={(e) => setBody(e.target.value)} />

        <div className="row" style={{ marginTop: 14 }}>
          <button className="primary" disabled={!push.subscribed} onClick={() => send(false)}>
            Send to this device
          </button>
          <button className="ghost" disabled={!push.subscribed} onClick={() => send(true)}>
            Broadcast to everyone
          </button>
        </div>

        <div className={'status' + (line.kind ? ' ' + line.kind : '')}>{line.msg}</div>
        {push.subscribed && <div className="uid">userId: {userId}</div>}
      </div>
    </main>
  );
}

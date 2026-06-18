// Vanilla push-subscribe demo. Mirrors the @p2pdotme/push-client subscribe flow
// inline so the PWA needs no build step. Same-origin: /vapid-public-key and
// /subscriptions are proxied to the push backend by Caddy.
const APP_ID = 'demo-app';

const els = {
  enable: document.getElementById('enable'),
  send: document.getElementById('send'),
  broadcast: document.getElementById('broadcast'),
  title: document.getElementById('title'),
  body: document.getElementById('body'),
  status: document.getElementById('status'),
  uid: document.getElementById('uid'),
};

function userId() {
  let id = localStorage.getItem('demo-user-id');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
    localStorage.setItem('demo-user-id', id);
  }
  return id;
}

function setStatus(msg, kind) {
  els.status.textContent = msg;
  els.status.className = 'status' + (kind ? ' ' + kind : '');
}

function urlB64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function enableNotifications() {
  if (!supported) throw new Error('Este navegador no soporta web push.');
  const reg = await navigator.serviceWorker.register('/push-sw.js');
  await navigator.serviceWorker.ready;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permiso de notificaciones denegado.');

  const { publicKey } = await (await fetch('/vapid-public-key')).json();
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlB64ToUint8Array(publicKey),
  });

  const res = await fetch('/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId: APP_ID, userId: userId(), subscription }),
  });
  if (!res.ok) throw new Error('No se pudo registrar la suscripción.');
}

async function trigger(broadcast) {
  const title = els.title.value.trim() || 'Demo';
  const body = els.body.value.trim() || '';
  const payload = broadcast ? { title, body } : { userId: userId(), title, body };
  const res = await fetch(broadcast ? '/api/broadcast' : '/api/trigger', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function markSubscribed() {
  els.send.disabled = false;
  els.broadcast.disabled = false;
  els.enable.textContent = 'Notificaciones activadas ✓';
  els.enable.disabled = true;
  els.uid.textContent = 'userId: ' + userId();
}

els.enable.addEventListener('click', async () => {
  els.enable.disabled = true;
  setStatus('Activando…');
  try {
    await enableNotifications();
    markSubscribed();
    setStatus('Listo. Ahora envía una notificación.', 'ok');
  } catch (err) {
    els.enable.disabled = false;
    setStatus(err.message, 'err');
  }
});

function wireSend(button, broadcast, label) {
  button.addEventListener('click', async () => {
    setStatus('Enviando…');
    try {
      const r = await trigger(broadcast);
      setStatus(`${label}: sent=${r.sent ?? 0} failed=${r.failed ?? 0} expired=${r.expired ?? 0}`, 'ok');
    } catch (err) {
      setStatus(err.message, 'err');
    }
  });
}
wireSend(els.send, false, 'Enviado');
wireSend(els.broadcast, true, 'Broadcast');

// If this browser is already subscribed (return visit), unlock the send buttons.
(async () => {
  if (!supported) {
    els.enable.disabled = true;
    setStatus('Este navegador no soporta web push.', 'err');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration('/push-sw.js');
    const existing = reg && (await reg.pushManager.getSubscription());
    if (existing && Notification.permission === 'granted') markSubscribed();
  } catch {
    /* ignore — first visit */
  }
})();

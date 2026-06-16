/**
 * Minimal server-to-server example: send a notification from any p2p.me backend.
 *
 *   PUSH_URL=https://push.p2p.me \
 *   PUSH_API_KEY=your-app-key \
 *   node examples/send.mjs alice
 */
const PUSH_URL = process.env.PUSH_URL ?? 'http://localhost:4000';
const API_KEY = process.env.PUSH_API_KEY ?? 'change-me-user-app-key';
const APP_ID = process.env.PUSH_APP_ID ?? 'user-app';
const userId = process.argv[2] ?? 'alice';

const res = await fetch(`${PUSH_URL}/notifications/send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
  body: JSON.stringify({
    appId: APP_ID,
    userId,
    notification: {
      title: 'Payment received',
      body: 'You received 25 USDC.',
      url: 'https://app.p2p.me/transactions',
      icon: '/icons/icon-192.png',
      data: { txId: '0xabc123' },
    },
    urgency: 'high',
  }),
});

console.log(res.status, await res.json());

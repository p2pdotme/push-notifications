/**
 * Minimal server-to-server example using the PushServer helper from
 * @p2pdotme/push-client/server. Send a notification from any p2p.me backend:
 *
 *   PUSH_URL=https://push.p2p.me \
 *   PUSH_API_KEY=your-app-key \
 *   node examples/send.mjs alice
 */
import { PushServer } from '@p2pdotme/push-client/server';

const push = new PushServer({
  serverUrl: process.env.PUSH_URL ?? 'http://localhost:4000',
  apiKey: process.env.PUSH_API_KEY ?? 'change-me-user-app-key',
  appId: process.env.PUSH_APP_ID ?? 'user-app',
});

const userId = process.argv[2] ?? 'alice';

const summary = await push.sendToUser(
  userId,
  {
    title: 'Payment received',
    body: 'You received 25 USDC.',
    url: 'https://app.p2p.me/transactions',
    icon: '/icons/icon-192.png',
    data: { txId: '0xabc123' },
  },
  { urgency: 'high' },
);

console.log(`sent=${summary.sent} failed=${summary.failed} expired=${summary.expired}`);

import webpush from 'web-push';

/**
 * Generates a fresh VAPID (RFC 8292) ECDSA P-256 key pair. Run once per
 * deployment; store the keys as VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.
 * Rotating the keys invalidates all existing subscriptions, so keep them stable.
 *
 *   npm run generate-vapid
 */
const keys = webpush.generateVAPIDKeys();

// eslint-disable-next-line no-console
console.log(
  [
    '# Add these to your .env (keep the private key secret):',
    `VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `VAPID_PRIVATE_KEY=${keys.privateKey}`,
    '',
    '# The public key is also what browser clients use to subscribe.',
  ].join('\n'),
);

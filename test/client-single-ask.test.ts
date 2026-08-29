import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { PushClient } from '../client/src/index';

// WebKit consumes the tap's transient activation on the FIRST
// Notification.requestPermission call and refuses any later call with
// "denied" before it reads the stored permission (WebCore Notification.cpp,
// consumeTransientActivation, shipping since at least WebKit-7620). This stub
// models exactly that: the first ask answers honestly, and every later ask
// answers denied however the stored permission reads.

const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

function defineGlobal(name: string, value: unknown) {
  if (!savedGlobals.has(name)) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

afterEach(() => {
  for (const [name, desc] of savedGlobals) {
    if (desc) Object.defineProperty(globalThis, name, desc);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  savedGlobals.clear();
});

const VAPID_KEY = Buffer.from(new Uint8Array([1, 2, 3, 4])).toString('base64url');

/** `firstAnswer` is what the user does with the prompt when one is shown:
 *  'granted' allows, 'denied' blocks, 'default' dismisses it without choosing. */
function stubEnvironment(
  initial: NotificationPermission,
  firstAnswer: NotificationPermission = 'granted',
) {
  let asks = 0;
  const notification = {
    permission: initial,
    requestPermission: async () => {
      asks += 1;
      // The first ask still answers honestly. An undecided permission gets
      // whatever the user does with the prompt, and an already settled one
      // reads back as it stands. Only LATER asks are refused out of hand,
      // because by then the activation the first ask spent is gone.
      if (asks === 1) {
        if (notification.permission === 'default') {
          notification.permission = firstAnswer;
        }
        return notification.permission;
      }
      return 'denied' as NotificationPermission;
    },
  };
  const subscription = {
    endpoint: 'https://push.example/endpoint/1',
    options: { userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3, 4]).buffer },
    unsubscribe: async () => true,
    toJSON: () => ({ endpoint: 'https://push.example/endpoint/1', keys: { p256dh: 'p', auth: 'a' } }),
  };
  const registration = {
    pushManager: {
      getSubscription: async () => subscription,
      subscribe: async () => subscription,
    },
  };
  defineGlobal('navigator', {
    serviceWorker: { register: async () => registration, ready: Promise.resolve(registration) },
  });
  defineGlobal('window', { PushManager: class {}, Notification: notification });
  defineGlobal('PushManager', class {});
  defineGlobal('Notification', notification);
  defineGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ publicKey: VAPID_KEY }) }));
  return { notification, askCount: () => asks };
}

test('subscribe() never re-asks a permission the page already holds', async () => {
  const env = stubEnvironment('default');
  // What a caller that settles the prompt itself does, inside the tap,
  // before calling subscribe().
  await Notification.requestPermission();
  assert.equal(env.notification.permission, 'granted');
  const client = new PushClient({ serverUrl: 'https://push.example', appId: 'app' });
  const sub = await client.subscribe();
  assert.ok(sub);
  assert.equal(env.askCount(), 1);
});

test('subscribe() still asks once when the permission is undecided', async () => {
  const env = stubEnvironment('default');
  const client = new PushClient({ serverUrl: 'https://push.example', appId: 'app' });
  const sub = await client.subscribe();
  assert.ok(sub);
  assert.equal(env.askCount(), 1);
});

test('subscribe() reports a stored denial without asking again', async () => {
  const env = stubEnvironment('denied');
  const client = new PushClient({ serverUrl: 'https://push.example', appId: 'app' });
  await assert.rejects(client.subscribe(), /not granted \(denied\)/);
  assert.equal(env.askCount(), 0);
});

test('subscribe() reports a dismissed prompt and does not go on to subscribe', async () => {
  const env = stubEnvironment('default', 'default');
  const client = new PushClient({ serverUrl: 'https://push.example', appId: 'app' });
  await assert.rejects(client.subscribe(), /not granted \(default\)/);
  assert.equal(env.askCount(), 1);
});

test('subscribe() never asks when the permission is already granted', async () => {
  const env = stubEnvironment('granted');
  const client = new PushClient({ serverUrl: 'https://push.example', appId: 'app' });
  const sub = await client.subscribe();
  assert.ok(sub);
  assert.equal(env.askCount(), 0);
});

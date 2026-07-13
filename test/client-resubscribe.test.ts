import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { PushClient } from '../client/src/index';

// Base64url-encoded VAPID keys used by the fakes below.
const OLD_KEY_BYTES = new Uint8Array([1, 2, 3, 4]);
const NEW_KEY_BYTES = new Uint8Array([9, 8, 7, 6]);
const NEW_KEY = Buffer.from(NEW_KEY_BYTES).toString('base64url');

class FakeSubscription {
  endpoint: string;
  options: { userVisibleOnly: boolean; applicationServerKey: ArrayBuffer | null };
  unsubscribed = false;

  constructor(endpoint: string, applicationServerKey: Uint8Array | null) {
    this.endpoint = endpoint;
    this.options = {
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey
        ? applicationServerKey.buffer.slice(0) as ArrayBuffer
        : null,
    };
  }

  async unsubscribe(): Promise<boolean> {
    this.unsubscribed = true;
    return true;
  }

  toJSON() {
    return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } };
  }
}

function makeFakePushEnvironment(existing: FakeSubscription | null) {
  const state = {
    current: existing,
    subscribeCalls: [] as Array<{ applicationServerKey: BufferSource }>,
    syncedEndpoints: [] as string[],
  };

  const pushManager = {
    async getSubscription() {
      return state.current;
    },
    async subscribe(opts: { userVisibleOnly: boolean; applicationServerKey: BufferSource }) {
      state.subscribeCalls.push({ applicationServerKey: opts.applicationServerKey });
      const keyBytes =
        opts.applicationServerKey instanceof Uint8Array
          ? opts.applicationServerKey
          : new Uint8Array(opts.applicationServerKey as ArrayBuffer);
      state.current = new FakeSubscription('https://push.example/new-endpoint', keyBytes);
      return state.current;
    },
  };

  const registration = { pushManager };

  defineGlobal('navigator', {
    serviceWorker: {
      register: async () => registration,
      ready: Promise.resolve(registration),
    },
  });
  defineGlobal('window', { PushManager: class {}, Notification: class {} });
  defineGlobal('Notification', {
    permission: 'granted',
    requestPermission: async () => 'granted',
  });
  defineGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/subscriptions') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { subscription: { endpoint: string } };
      state.syncedEndpoints.push(body.subscription.endpoint);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ publicKey: NEW_KEY }),
    };
  });

  return state;
}

function defineGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

const savedGlobals: Record<string, PropertyDescriptor | undefined> = {};
const STUBBED = ['navigator', 'window', 'Notification', 'fetch'];
beforeEach(() => {
  for (const name of STUBBED) {
    savedGlobals[name] = Object.getOwnPropertyDescriptor(globalThis, name);
  }
});
afterEach(() => {
  for (const name of STUBBED) {
    const desc = savedGlobals[name];
    if (desc) Object.defineProperty(globalThis, name, desc);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

function makeClient() {
  return new PushClient({
    serverUrl: 'https://push.example',
    appId: 'test-app',
    vapidPublicKey: NEW_KEY,
  });
}

test('subscribe replaces an existing subscription created with a different applicationServerKey', async () => {
  const stale = new FakeSubscription('https://push.example/old-endpoint', OLD_KEY_BYTES);
  const state = makeFakePushEnvironment(stale);

  const subscription = await makeClient().subscribe('0xabc');

  assert.equal(stale.unsubscribed, true, 'stale subscription should be unsubscribed');
  assert.equal(state.subscribeCalls.length, 1, 'a fresh subscription should be created');
  assert.equal(subscription.endpoint, 'https://push.example/new-endpoint');
  assert.deepEqual(state.syncedEndpoints, ['https://push.example/new-endpoint']);
});

test('subscribe replaces an existing subscription that has no applicationServerKey', async () => {
  const stale = new FakeSubscription('https://push.example/legacy-endpoint', null);
  const state = makeFakePushEnvironment(stale);

  const subscription = await makeClient().subscribe('0xabc');

  assert.equal(stale.unsubscribed, true);
  assert.equal(state.subscribeCalls.length, 1);
  assert.equal(subscription.endpoint, 'https://push.example/new-endpoint');
});

test('subscribe reuses an existing subscription whose applicationServerKey matches', async () => {
  const current = new FakeSubscription('https://push.example/current-endpoint', NEW_KEY_BYTES);
  const state = makeFakePushEnvironment(current);

  const subscription = await makeClient().subscribe('0xabc');

  assert.equal(current.unsubscribed, false, 'matching subscription must not be dropped');
  assert.equal(state.subscribeCalls.length, 0, 'no new subscription should be created');
  assert.equal(subscription.endpoint, 'https://push.example/current-endpoint');
  assert.deepEqual(state.syncedEndpoints, ['https://push.example/current-endpoint']);
});

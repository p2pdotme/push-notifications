/**
 * @p2pdotme/push-client
 *
 * Framework-agnostic browser helper for the self-hosted push service. Drop it
 * into any p2p.me frontend (React, Vue, vanilla). It handles the full Web Push
 * subscription lifecycle: registering a service worker, requesting permission,
 * subscribing via the PushManager, and syncing the subscription with the
 * server. No Firebase SDK required.
 */

export interface PushClientOptions {
  /** Base URL of the push service, e.g. "https://push.p2p.me". */
  serverUrl: string;
  /** Identifier of the calling app, must match a configured appId on the server. */
  appId: string;
  /** Path to the service worker file served by your app. Default: "/push-sw.js". */
  serviceWorkerUrl?: string;
  /**
   * VAPID public key. If omitted, it is fetched from the server's
   * /vapid-public-key endpoint on first subscribe.
   */
  vapidPublicKey?: string;
}

export class PushNotSupportedError extends Error {
  constructor() {
    super('Push notifications are not supported in this browser');
    this.name = 'PushNotSupportedError';
  }
}

/** Thrown when the app requires a wallet signature but no `signMessage` was supplied. */
export class SignatureRequiredError extends Error {
  constructor() {
    super('This app requires a wallet signature to subscribe; pass a signMessage callback');
    this.name = 'SignatureRequiredError';
  }
}

export interface SubscribeOptions {
  /**
   * Sign the server-issued challenge message to prove control of the wallet
   * `userId`. Works with any wallet (EOA or smart wallet) — return the
   * signature hex. Required when the target app enables signature enforcement.
   */
  signMessage?: (message: string) => Promise<string>;
}

/** True when the browser exposes the APIs required for Web Push. */
export function isPushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Convert a base64url VAPID key into the Uint8Array the PushManager expects. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  // Back the array with a concrete ArrayBuffer so it satisfies BufferSource.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

export class PushClient {
  private readonly serverUrl: string;
  private readonly appId: string;
  private readonly serviceWorkerUrl: string;
  private vapidPublicKey?: string;

  constructor(options: PushClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/$/, '');
    this.appId = options.appId;
    this.serviceWorkerUrl = options.serviceWorkerUrl ?? '/push-sw.js';
    this.vapidPublicKey = options.vapidPublicKey;
  }

  /** Current Notification permission state. */
  get permission(): NotificationPermission {
    return Notification.permission;
  }

  /** Register the service worker (idempotent — the browser dedupes by URL). */
  async registerServiceWorker(): Promise<ServiceWorkerRegistration> {
    if (!isPushSupported()) throw new PushNotSupportedError();
    return navigator.serviceWorker.register(this.serviceWorkerUrl);
  }

  /** Prompt the user for notification permission. */
  async requestPermission(): Promise<NotificationPermission> {
    if (!isPushSupported()) throw new PushNotSupportedError();
    return Notification.requestPermission();
  }

  /**
   * Full happy-path subscribe: ensure permission, subscribe via PushManager,
   * and register the subscription with the server. Associate it with `userId`
   * so the backend can target this user later. Returns the PushSubscription.
   */
  async subscribe(userId?: string, opts?: SubscribeOptions): Promise<PushSubscription> {
    if (!isPushSupported()) throw new PushNotSupportedError();

    const permission = await this.requestPermission();
    if (permission !== 'granted') {
      throw new Error(`Notification permission was not granted (${permission})`);
    }

    const registration = await this.registerServiceWorker();
    await navigator.serviceWorker.ready;

    const key = await this.getVapidPublicKey();
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      }));

    await this.sync(subscription, userId, opts?.signMessage);
    return subscription;
  }

  /** Send (or refresh) the subscription on the server, signing a proof when asked. */
  async sync(
    subscription: PushSubscription,
    userId?: string,
    signMessage?: (message: string) => Promise<string>,
  ): Promise<void> {
    let proof: { payload: unknown; signature: string } | undefined;
    if (signMessage && userId) {
      proof = await this.requestProof(subscription, userId, signMessage);
    }

    const res = await fetch(`${this.serverUrl}/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: this.appId,
        userId: userId ?? null,
        subscription: subscription.toJSON(),
        ...(proof ?? {}),
      }),
    });

    if (res.status === 401) {
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      if (body.code === 'signature_required') throw new SignatureRequiredError();
      throw new Error('Subscription rejected: invalid wallet signature');
    }
    if (!res.ok) {
      throw new Error(`Failed to register subscription: ${res.status}`);
    }
  }

  /** Fetch a challenge for this channel and sign it. */
  private async requestProof(
    subscription: PushSubscription,
    address: string,
    signMessage: (message: string) => Promise<string>,
  ): Promise<{ payload: unknown; signature: string }> {
    const res = await fetch(`${this.serverUrl}/subscriptions/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, address, endpoint: subscription.endpoint }),
    });
    if (!res.ok) throw new Error(`Failed to obtain subscription challenge: ${res.status}`);
    const { payload, message } = (await res.json()) as { payload: unknown; message: string };
    const signature = await signMessage(message);
    return { payload, signature };
  }

  /** Unsubscribe locally and remove the channel from the server. */
  async unsubscribe(): Promise<boolean> {
    if (!isPushSupported()) throw new PushNotSupportedError();
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return false;

    const res = await fetch(`${this.serverUrl}/subscriptions`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    // Only drop the local subscription once the server confirms removal; otherwise
    // throw so the caller can retry (a failed delete self-heals via 410-pruning,
    // but we shouldn't report success on a server error).
    if (!res.ok) throw new Error(`Failed to remove subscription: ${res.status}`);
    return subscription.unsubscribe();
  }

  private async getVapidPublicKey(): Promise<string> {
    if (this.vapidPublicKey) return this.vapidPublicKey;
    const res = await fetch(`${this.serverUrl}/vapid-public-key`);
    if (!res.ok) throw new Error('Failed to fetch VAPID public key');
    const { publicKey } = (await res.json()) as { publicKey: string };
    this.vapidPublicKey = publicKey;
    return publicKey;
  }
}

import webpush, { type PushSubscription, WebPushError } from 'web-push';
import type { Config } from './config.js';
import type { Repository } from './repository.js';
import type { NotificationPayload, SubscriptionRecord } from './types.js';

export interface SendResult {
  endpoint: string;
  success: boolean;
  statusCode?: number;
  /** True when the subscription was gone (404/410) and has been pruned. */
  expired?: boolean;
  error?: string;
}

export interface SendSummary {
  sent: number;
  failed: number;
  expired: number;
  results: SendResult[];
}

/**
 * Thin wrapper around the `web-push` library. `web-push` performs the heavy
 * lifting mandated by the Web Push standards: deriving an ECDH shared secret
 * with the browser's public key, encrypting the payload with AES-128-GCM
 * (RFC 8291), and signing the VAPID JWT (RFC 8292) that proves to the push
 * service we own the application server. Push services never see plaintext.
 */
export class PushSender {
  constructor(
    private readonly config: Config,
    private readonly repo: Repository,
  ) {
    webpush.setVapidDetails(
      config.vapid.subject,
      config.vapid.publicKey,
      config.vapid.privateKey,
    );
  }

  /** Fan out one payload to many subscriptions, recording outcomes. */
  async sendToMany(
    subs: SubscriptionRecord[],
    payload: NotificationPayload,
    options: { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high' } = {},
  ): Promise<SendSummary> {
    const results = await Promise.all(
      subs.map((sub) => this.sendToOne(sub, payload, options)),
    );
    return {
      sent: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success && !r.expired).length,
      expired: results.filter((r) => r.expired).length,
      results,
    };
  }

  private async sendToOne(
    sub: SubscriptionRecord,
    payload: NotificationPayload,
    options: { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high' },
  ): Promise<SendResult> {
    const pushSubscription: PushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };

    try {
      const res = await webpush.sendNotification(
        pushSubscription,
        JSON.stringify(payload),
        { TTL: options.ttl ?? 60 * 60 * 24, urgency: options.urgency ?? 'normal' },
      );
      this.repo.markSuccess(sub.id);
      this.repo.logDelivery({
        appId: sub.appId,
        userId: sub.userId,
        endpoint: sub.endpoint,
        title: payload.title,
        status: 'sent',
        statusCode: res.statusCode,
        error: null,
      });
      return { endpoint: sub.endpoint, success: true, statusCode: res.statusCode };
    } catch (err) {
      return this.handleError(sub, payload, err);
    }
  }

  private handleError(
    sub: SubscriptionRecord,
    payload: NotificationPayload,
    err: unknown,
  ): SendResult {
    const statusCode = err instanceof WebPushError ? err.statusCode : undefined;
    // 404 (Not Found) / 410 (Gone) mean the subscription is permanently dead.
    const expired = statusCode === 404 || statusCode === 410;

    if (expired) {
      this.repo.deleteByEndpoint(sub.endpoint);
    } else {
      this.repo.markFailure(sub.id, this.config.maxFailures);
    }

    const message = err instanceof Error ? err.message : String(err);
    this.repo.logDelivery({
      appId: sub.appId,
      userId: sub.userId,
      endpoint: sub.endpoint,
      title: payload.title,
      status: expired ? 'expired' : 'failed',
      statusCode: statusCode ?? null,
      error: message,
    });

    return { endpoint: sub.endpoint, success: false, statusCode, expired, error: message };
  }
}

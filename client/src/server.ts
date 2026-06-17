/**
 * @p2pdotme/push-client/server
 *
 * Tiny, dependency-free helper for sending notifications from any backend
 * (Node, Bun, Deno, edge workers — anything with global `fetch`). Wraps the
 * push service's server-to-server API so you never hand-roll the fetch:
 *
 *   const push = new PushServer({
 *     serverUrl: process.env.PUSH_URL!,
 *     apiKey: process.env.PUSH_API_KEY!,
 *     appId: 'user-app',
 *   });
 *   await push.sendToUser('alice', { title: 'Payment received', body: 'You got 25 USDC.' });
 */

export interface NotificationAction {
  action: string;
  title: string;
  icon?: string;
}

/** Web notification payload. Mirrors the service's accepted fields. */
export interface NotificationPayload {
  title: string;
  body?: string;
  icon?: string;
  badge?: string;
  image?: string;
  /** URL opened when the notification is clicked. */
  url?: string;
  tag?: string;
  requireInteraction?: boolean;
  silent?: boolean;
  data?: Record<string, unknown>;
  actions?: NotificationAction[];
}

export interface SendOptions {
  /** Seconds the push service should retain the message if undelivered. */
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
}

/** Per-recipient delivery outcome returned by the service. */
export interface SendResult {
  endpoint: string;
  success: boolean;
  statusCode?: number;
  expired?: boolean;
  error?: string;
}

/** Aggregate result of a send call. */
export interface SendSummary {
  sent: number;
  failed: number;
  expired: number;
  results: SendResult[];
}

export interface DeliveryLog {
  appId: string;
  userId: string | null;
  endpoint: string;
  success: boolean;
  statusCode: number | null;
  error: string | null;
  createdAt: string;
}

export interface PushServerOptions {
  /** Base URL of the push service, e.g. "https://push.p2p.me". */
  serverUrl: string;
  /** App API key (the `x-api-key` header). Keep this server-side only. */
  apiKey: string;
  /** Identifier of the calling app; the key must be authorized for it. */
  appId: string;
}

export class PushSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'PushSendError';
  }
}

export class PushServer {
  private readonly serverUrl: string;
  private readonly apiKey: string;
  private readonly appId: string;

  constructor(options: PushServerOptions) {
    this.serverUrl = options.serverUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.appId = options.appId;
  }

  /** Send to a single user. */
  sendToUser(
    userId: string,
    notification: NotificationPayload,
    options: SendOptions = {},
  ): Promise<SendSummary> {
    return this.send({ userId }, notification, options);
  }

  /** Send to several users in one call. */
  sendToUsers(
    userIds: string[],
    notification: NotificationPayload,
    options: SendOptions = {},
  ): Promise<SendSummary> {
    return this.send({ userIds }, notification, options);
  }

  /** Send to every active subscription of the app. */
  broadcast(
    notification: NotificationPayload,
    options: SendOptions = {},
  ): Promise<SendSummary> {
    return this.send({ broadcast: true }, notification, options);
  }

  /** Most recent delivery log entries for this app (newest first). */
  async logs(limit = 100): Promise<DeliveryLog[]> {
    const res = await fetch(
      `${this.serverUrl}/notifications/logs/${encodeURIComponent(this.appId)}?limit=${limit}`,
      { headers: { 'x-api-key': this.apiKey } },
    );
    if (!res.ok) {
      throw new PushSendError(`Failed to fetch logs: ${res.status}`, res.status, await safeBody(res));
    }
    return (await res.json()) as DeliveryLog[];
  }

  /** Low-level send; prefer sendToUser / sendToUsers / broadcast. */
  private async send(
    target: { userId?: string; userIds?: string[]; broadcast?: boolean },
    notification: NotificationPayload,
    options: SendOptions,
  ): Promise<SendSummary> {
    const res = await fetch(`${this.serverUrl}/notifications/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
      body: JSON.stringify({
        appId: this.appId,
        ...target,
        notification,
        ttl: options.ttl,
        urgency: options.urgency,
      }),
    });

    if (!res.ok) {
      throw new PushSendError(
        `Push send failed: ${res.status}`,
        res.status,
        await safeBody(res),
      );
    }
    return (await res.json()) as SendSummary;
  }
}

async function safeBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

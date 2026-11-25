import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { LOCAL_PUSH_FLAG, PUSH_NOT_CONFIGURED, isPushKey, truncateError } from './notification-delivery.util';

export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  p256dh: string;
  authSecret: string;
}

export interface PushMessage {
  notificationId: string;
  eventId: string;
  title: string;
  body: string;
  url: string;
}

export interface PushSendResult {
  state: 'SENT' | 'FAILED' | 'SKIPPED';
  error?: string | null;
  /** The push service rejected the subscription itself (HTTP 404/410): stop delivering to it. */
  permanent?: boolean;
}

export interface PushSender {
  readonly kind: 'web-push' | 'unconfigured' | 'local';
  send(subscription: PushSubscriptionRecord, message: PushMessage): Promise<PushSendResult>;
}

interface WebPushLike {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(subscription: unknown, payload: string, options: unknown): Promise<unknown>;
}

/**
 * Real pushes need the payload encryption of RFC 8291/8292, which is what `web-push` implements.
 * It is an optional dependency: when it is not installed we do not invent a transport, the
 * dispatcher records SKIPPED and the admin panel says what is missing.
 */
async function loadWebPush(): Promise<WebPushLike | null> {
  try {
    const specifier = 'web-push';
    const loaded = (await import(specifier)) as { default?: WebPushLike } & WebPushLike;
    const mod = (loaded.default ?? loaded) as WebPushLike;
    return typeof mod.sendNotification === 'function' ? mod : null;
  } catch {
    return null;
  }
}

export function readPushConfig(env: NodeJS.ProcessEnv = process.env) {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? '';
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? '';
  const subject = env.VAPID_SUBJECT?.trim() || 'mailto:ops@jetino.app';
  const configured = isPushKey(publicKey) && privateKey.length >= 40 && /^(mailto:|https?:\/\/)/.test(subject);
  return { publicKey, privateKey, subject, configured, allowLocal: env[LOCAL_PUSH_FLAG] === '1' };
}

export class UnconfiguredPushSender implements PushSender {
  readonly kind = 'unconfigured' as const;

  async send(): Promise<PushSendResult> {
    return { state: 'SKIPPED', error: PUSH_NOT_CONFIGURED };
  }
}

/**
 * Only selected when JETINO_ALLOW_LOCAL_PUSH=1 (the integration drill): the payload is appended to
 * a file the test reads back. A deployment without VAPID keys still records SKIPPED, never SENT.
 */
export class LocalPushSender implements PushSender {
  readonly kind = 'local' as const;

  constructor(private readonly logFile: string) {}

  async send(subscription: PushSubscriptionRecord, message: PushMessage): Promise<PushSendResult> {
    const line = `${JSON.stringify({ at: new Date().toISOString(), subscription: this.logFile, target: subscription.id, message })}\n`;
    await appendFile(this.logFile, line, 'utf8');
    return { state: 'SENT', error: null };
  }
}

export class WebPushSender implements PushSender {
  readonly kind = 'web-push' as const;

  constructor(private readonly push: WebPushLike) {}

  async send(subscription: PushSubscriptionRecord, message: PushMessage): Promise<PushSendResult> {
    const payload = JSON.stringify({
      title: message.title,
      body: message.body,
      tag: message.notificationId,
      data: { eventId: message.eventId, notificationId: message.notificationId, url: message.url },
    });
    try {
      await this.push.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.authSecret } },
        payload,
        { TTL: 3600, urgency: 'normal', topic: message.eventId.slice(0, 32) },
      );
      return { state: 'SENT', error: null };
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        return { state: 'FAILED', error: truncateError(`push service rejected the subscription (HTTP ${status})`), permanent: true };
      }
      return { state: 'FAILED', error: truncateError(error instanceof Error ? error.message : String(error)) };
    }
  }
}

@Injectable()
export class PushSenderFactory {
  private static readonly unconfigured = new UnconfiguredPushSender();
  private cached: WebPushSender | null = null;
  private cachedSignature = '';

  /** Resolved per dispatch so keys added later take effect without a restart. */
  async resolve(): Promise<PushSender> {
    const config = readPushConfig();
    if (config.allowLocal) return new LocalPushSender(process.env[`${LOCAL_PUSH_FLAG}_FILE`] ?? '/tmp/jetino-push.log');
    if (!config.configured) return PushSenderFactory.unconfigured;
    const signature = createHash('sha256').update(`${config.publicKey}:${config.subject}`).digest('hex');
    if (this.cached && this.cachedSignature === signature) return this.cached;
    const push = await loadWebPush();
    if (!push) return PushSenderFactory.unconfigured;
    push.setVapidDetails(config.subject, config.publicKey, config.privateKey);
    this.cached = new WebPushSender(push);
    this.cachedSignature = signature;
    return this.cached;
  }

  isConfigured(): boolean {
    const config = readPushConfig();
    return config.allowLocal || config.configured;
  }

  describe() {
    const config = readPushConfig();
    return {
      configured: this.isConfigured(),
      vapidReady: config.configured,
      subject: config.subject,
      allowLocal: config.allowLocal,
    };
  }

  /** The browser needs the public key to subscribe; a clear refusal beats a silent failure. */
  requirePublicKey(): string {
    const config = readPushConfig();
    if (!config.configured) throw new BadRequestException('کلید عمومی وب‌پوش تنظیم نشده است؛ اعلان مرورگر فعال نیست.');
    return config.publicKey;
  }
}

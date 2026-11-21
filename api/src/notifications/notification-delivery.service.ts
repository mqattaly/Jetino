import { BadRequestException, Injectable, Logger, NotFoundException, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import {
  DISPATCH_BATCH_LIMIT,
  DELIVERY_STATES,
  MAX_DELIVERY_ATTEMPTS,
  MAX_PUSH_FAILURES,
  PUSH_EVENT_GROUP_KEYS,
  allPushEventTypes,
  endpointMatches,
  eventsForGroup,
  groupOfEvent,
  isPushEventGroup,
  isPushKey,
  isUuid,
  leaseIntervalSql,
  pushStateSummary,
  retryDelaySql,
  truncateError,
  type DeliveryChannel,
  type DeliveryState,
  type PushEventGroup,
} from './notification-delivery.util';
import { PushSenderFactory, type PushMessage, type PushSubscriptionRecord } from './push-sender';

const MAX_ENDPOINT_LENGTH = 2048;

interface SubscriptionBody {
  endpoint?: unknown;
  p256dh?: unknown;
  auth?: unknown;
  userAgent?: unknown;
}

interface QueueRow {
  id: number;
  notificationId: string;
  userId: string;
  channel: DeliveryChannel;
  attempts: number;
  pushSubscriptionId: number | null;
  eventType: string;
  title: string;
  body: string;
  data: unknown;
  subscriptionId: string | null;
  endpoint: string | null;
  p256dh: string | null;
  authSecret: string | null;
}

@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly senders: PushSenderFactory,
  ) {}

  // ---------------------------------------------------------------- subscriptions

  /** Idempotent by endpoint: the same browser re-subscribing must not double-deliver. */
  async upsertSubscription(userId: string, input: unknown) {
    if (!isUuid(userId)) throw new BadRequestException('شناسهٔ کاربر معتبر نیست.');
    const body = (input ?? {}) as SubscriptionBody;
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    if (!endpointMatches(endpoint) || endpoint.length > MAX_ENDPOINT_LENGTH) {
      throw new BadRequestException('آدرس سرویس اعلان معتبر نیست.');
    }
    if (!isPushKey(body.p256dh) || !isPushKey(body.auth)) throw new BadRequestException('کلیدهای اعلان مرورگر معتبر نیستند.');
    const userAgent = typeof body.userAgent === 'string' ? body.userAgent.trim().slice(0, 200) : null;

    const result = await this.pool.query(
      `INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth_secret,user_agent)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth_secret = EXCLUDED.auth_secret,
             user_agent = EXCLUDED.user_agent, failures = 0, active = true, updated_at = now()
       RETURNING id, (xmax = 0) AS created`,
      [userId, endpoint, String(body.p256dh).trim(), String(body.auth).trim(), userAgent],
    );
    const row = result.rows[0] as { id: string; created: boolean };
    return { id: row.id, created: Boolean(row.created), pushReady: this.senders.isConfigured() };
  }

  async unsubscribe(userId: string, input: unknown) {
    const body = (input ?? {}) as { endpoint?: unknown };
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    if (!endpoint) throw new BadRequestException('آدرس سرویس اعلان لازم است.');
    const result = await this.pool.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
    return { removed: result.rowCount ?? 0 };
  }

  async listMySubscriptions(userId: string) {
    const result = await this.pool.query(
      `SELECT id, endpoint, user_agent AS "userAgent", failures, active, updated_at AS "updatedAt"
       FROM push_subscriptions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 20`,
      [userId],
    );
    return { items: result.rows, pushReady: this.senders.isConfigured() };
  }

  async pushConfig() {
    const described = this.senders.describe();
    return { ...described, publicKey: described.vapidReady ? this.senders.requirePublicKey() : null };
  }

  /** Which push groups this account still receives. */
  async getPreferences(userId: string) {
    const result = await this.pool.query('SELECT event_type AS "eventType" FROM push_event_opt_outs WHERE user_id = $1', [userId]);
    const muted = new Set((result.rows as { eventType: string }[]).map((row) => row.eventType));
    return {
      groups: PUSH_EVENT_GROUP_KEYS.map((key) => {
        const events = eventsForGroup(key);
        const off = events.filter((event) => muted.has(event)).length;
        return { key, enabled: off === 0, partiallyMuted: off > 0 && off < events.length, events: [...events] };
      }),
      mutedEvents: [...muted],
    };
  }

  /**
   * The whole set is written at once (PUT semantics): silencing a group inserts one row per event
   * type it covers, enabling it deletes them. The inbox keeps every row either way.
   */
  async setPreferences(userId: string, input: unknown) {
    if (!isUuid(userId)) throw new BadRequestException('شناسهٔ کاربر معتبر نیست.');
    const body = (input ?? {}) as { groups?: unknown };
    if (!Array.isArray(body.groups) || body.groups.length > PUSH_EVENT_GROUP_KEYS.length) {
      throw new BadRequestException('گروه‌های اعلان باید فهرست کوتاهی از نام‌ها باشند.');
    }
    const enabled = new Set<PushEventGroup>();
    for (const item of body.groups) {
      if (!isPushEventGroup(item)) throw new BadRequestException('گروه اعلان ناشناخته است.');
      enabled.add(item);
    }
    const wanted = allPushEventTypes().filter((event) => {
      const group = groupOfEvent(event);
      return group === null || !enabled.has(group);
    });

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM push_event_opt_outs WHERE user_id = $1', [userId]);
      for (const eventType of wanted) {
        await client.query('INSERT INTO push_event_opt_outs(user_id,event_type) VALUES($1,$2) ON CONFLICT DO NOTHING', [userId, eventType]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { mutedEvents: wanted.length, enabledGroups: [...enabled] };
  }

  // ---------------------------------------------------------------- delivery ledger

  /**
   * The ledger rows themselves are written by the notifications trigger (see 015); this is the
   * read side. A user may only ever see the delivery state of their own inbox row.
   */
  async deliveryForNotification(userId: string, notificationId: string) {
    if (!isUuid(notificationId)) throw new NotFoundException('اعلان پیدا نشد.');
    const inbox = await this.pool.query('SELECT id, event_type AS "eventType", title FROM notifications WHERE id = $1 AND user_id = $2', [
      notificationId,
      userId,
    ]);
    if (!inbox.rowCount) throw new NotFoundException('اعلان پیدا نشد.');
    const result = await this.pool.query(
      `SELECT id, channel, state, attempts, next_attempt_at AS "nextAttemptAt", last_error AS "lastError", sent_at AS "sentAt"
       FROM notification_deliveries WHERE notification_id = $1 ORDER BY channel, id`,
      [notificationId],
    );
    const rows = result.rows as { channel: DeliveryChannel; state: DeliveryState }[];
    return {
      notificationId,
      deliveries: result.rows,
      push: pushStateSummary({
        sent: rows.filter((row) => row.channel === 'PUSH' && row.state === 'SENT').length,
        pending: rows.filter((row) => row.channel === 'PUSH' && row.state === 'PENDING').length,
        failed: rows.filter((row) => row.channel === 'PUSH' && row.state === 'FAILED').length,
        skipped: rows.filter((row) => row.channel === 'PUSH' && row.state === 'SKIPPED').length,
      }),
    };
  }

  /** Push state of every row on the current inbox page, in one query. */
  async pushStates(notificationIds: readonly string[]) {
    const states = new Map<string, ReturnType<typeof pushStateSummary> & { lastError: string | null }>();
    const ids = notificationIds.filter(isUuid);
    if (!ids.length) return states;
    const result = await this.pool.query(
      `SELECT notification_id AS "notificationId",
               count(*) FILTER (WHERE state = 'SENT') AS sent,
               count(*) FILTER (WHERE state = 'PENDING') AS pending,
               count(*) FILTER (WHERE state = 'FAILED') AS failed,
               count(*) FILTER (WHERE state = 'SKIPPED') AS skipped,
               max(last_error) FILTER (WHERE state IN ('FAILED','SKIPPED')) AS "lastError"
       FROM notification_deliveries
       WHERE channel = 'PUSH' AND notification_id = ANY($1::uuid[])
       GROUP BY notification_id`,
      [[...ids]],
    );
    for (const row of result.rows as {
      notificationId: string;
      sent: string;
      pending: string;
      failed: string;
      skipped: string;
      lastError: string | null;
    }[]) {
      const counts = {
        sent: Number(row.sent),
        pending: Number(row.pending),
        failed: Number(row.failed),
        skipped: Number(row.skipped),
      };
      states.set(row.notificationId, { ...pushStateSummary(counts), lastError: row.lastError });
    }
    return states;
  }

  async stats() {
    const result = await this.pool.query(
      `SELECT count(*) FILTER (WHERE channel = 'PUSH') AS "pushTotal",
               count(*) FILTER (WHERE channel = 'PUSH' AND state = 'PENDING') AS "pushPending",
               count(*) FILTER (WHERE channel = 'PUSH' AND state = 'SENT') AS "pushSent",
               count(*) FILTER (WHERE channel = 'PUSH' AND state = 'FAILED') AS "pushFailed",
               count(*) FILTER (WHERE channel = 'PUSH' AND state = 'SKIPPED') AS "pushSkipped",
               count(*) FILTER (WHERE channel = 'IN_APP' AND state = 'SENT') AS "inAppSent"
       FROM notification_deliveries`,
    );
    const subscriptions = await this.pool.query(
      'SELECT count(*) FILTER (WHERE active) AS active, count(*) AS total FROM push_subscriptions',
    );
    const counters = result.rows[0] as Record<string, string>;
    const subscriptionCounters = subscriptions.rows[0] as Record<string, string>;
    return {
      push: {
        total: Number(counters.pushTotal ?? 0),
        pending: Number(counters.pushPending ?? 0),
        sent: Number(counters.pushSent ?? 0),
        failed: Number(counters.pushFailed ?? 0),
        skipped: Number(counters.pushSkipped ?? 0),
      },
      inAppSent: Number(counters.inAppSent ?? 0),
      subscriptions: {
        active: Number(subscriptionCounters.active ?? 0),
        total: Number(subscriptionCounters.total ?? 0),
      },
      retryAfter: { attempts: MAX_DELIVERY_ATTEMPTS, failures: MAX_PUSH_FAILURES },
      sender: this.senders.describe(),
    };
  }

  async recentDeliveries(state?: unknown) {
    const wanted =
      typeof state === 'string' && (DELIVERY_STATES as readonly string[]).includes(state.toUpperCase()) ? state.toUpperCase() : null;
    const result = await this.pool.query(
      `SELECT d.id, d.notification_id AS "notificationId", d.user_id AS "userId", d.channel, d.state, d.attempts,
               d.next_attempt_at AS "nextAttemptAt", d.last_error AS "lastError", d.sent_at AS "sentAt",
               n.event_type AS "eventType", n.title, u.phone
       FROM notification_deliveries AS d
       JOIN notifications AS n ON n.id = d.notification_id
       JOIN users AS u ON u.id = d.user_id
       WHERE ($1::varchar IS NULL OR d.state = $1)
       ORDER BY d.created_at DESC, d.id DESC LIMIT 100`,
      [wanted],
    );
    return { items: result.rows };
  }

  // ---------------------------------------------------------------- dispatcher

  /**
   * Sends what is due. Rows are claimed with FOR UPDATE SKIP LOCKED, so two workers (or a cron
   * overlapping with itself) never deliver the same row twice. IN_APP needs no transport: the
   * inbox row is the delivery.
   */
  async dispatch(limit = DISPATCH_BATCH_LIMIT) {
    const batch = Math.max(1, Math.min(Number(limit) || DISPATCH_BATCH_LIMIT, DISPATCH_BATCH_LIMIT));
    const due = await this.pool.query(
      `SELECT d.id
       FROM notification_deliveries AS d
       WHERE d.state = 'PENDING' AND d.next_attempt_at <= now() AND d.attempts < $1
       ORDER BY d.created_at, d.id
       LIMIT $2`,
      [MAX_DELIVERY_ATTEMPTS, batch],
    );
    const ids = (due.rows as { id: string | number }[]).map((row) => Number(row.id));
    const sender = await this.senders.resolve();
    const summary = { due: ids.length, claimed: 0, sent: 0, failed: 0, skipped: 0, exhausted: 0, detached: 0, sender: sender.kind };

    for (const id of ids) {
      const row = await this.claim(id);
      if (!row) continue; // another worker holds the lease; the row stays in the queue
      summary.claimed += 1;
      if (row.channel === 'IN_APP') {
        await this.markSent(row.id);
        summary.sent += 1;
        continue;
      }
      if (!row.subscriptionId || !row.endpoint) {
        await this.markSkipped(row.id, 'no-active-subscription');
        summary.skipped += 1;
        continue;
      }
      const result = await sender.send(subscriptionOf(row), messageOf(row));
      if (result.state === 'SENT') {
        await this.markSent(row.id);
        summary.sent += 1;
      } else if (result.state === 'SKIPPED') {
        await this.markSkipped(row.id, result.error ?? null);
        summary.skipped += 1;
      } else if (result.permanent && row.pushSubscriptionId !== null) {
        summary.detached += await this.detachSubscription(row.pushSubscriptionId, result.error ?? 'push failed');
        summary.failed += 1;
      } else {
        summary.failed += 1;
        if (await this.markFailure(row, result.error ?? 'push failed')) summary.exhausted += 1;
      }
    }
    if (summary.failed) this.logger.warn(`push deliveries failed: ${summary.failed} of ${summary.claimed}`);
    return summary;
  }

  /**
   * The lease is the claim: one atomic statement takes the row and pushes its due time out, so two
   * workers (an overlap, a cron plus a manual run) can never both send it. A held row is retried
   * after the lease, which makes delivery at-least-once — the duplicate guard is the unique
   * (notification, channel, subscription) row, not a lock we would have to hold across the network.
   */
  private async claim(id: number): Promise<QueueRow | null> {
    const result = await this.pool.query(
      `WITH claimed AS (
         UPDATE notification_deliveries AS d
         SET attempts = d.attempts + 1, next_attempt_at = now() + ${leaseIntervalSql()}, updated_at = now()
         WHERE d.id = $1 AND d.state = 'PENDING' AND d.next_attempt_at <= now() AND d.attempts < $2
         RETURNING d.id, d.notification_id, d.user_id, d.channel, d.attempts, d.push_subscription_id
       )
       SELECT c.id, c.notification_id AS "notificationId", c.user_id AS "userId", c.channel, c.attempts,
              c.push_subscription_id AS "pushSubscriptionId",
              n.event_type AS "eventType", n.title, n.body, n.data,
              p.id AS "subscriptionId", p.endpoint, p.p256dh, p.auth_secret AS "authSecret"
       FROM claimed AS c
       JOIN notifications AS n ON n.id = c.notification_id
       LEFT JOIN push_subscriptions AS p ON p.id = c.push_subscription_id AND p.active`,
      [id, MAX_DELIVERY_ATTEMPTS],
    );
    return (result.rows[0] as QueueRow | undefined) ?? null;
  }

  /** Manual retry from the admin panel: only FAILED rows go back to the queue. */
  async retryDelivery(idInput: unknown) {
    const id = Number(idInput);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('شناسه ارسال معتبر نیست.');
    const result = await this.pool.query(
      `UPDATE notification_deliveries
       SET state = 'PENDING', attempts = 0, next_attempt_at = now(), updated_at = now()
       WHERE id = $1 AND state = 'FAILED'
       RETURNING id`,
      [id],
    );
    if (!result.rowCount) throw new NotFoundException('این ارسال قابل تلاش دوباره نیست.');
    return { retried: 1 };
  }

  /** The attempt was already counted by the claim, so a send only records the outcome. */
  private async markSent(id: number) {
    await this.pool.query(
      `UPDATE notification_deliveries
       SET state = 'SENT', last_error = NULL, sent_at = now(), updated_at = now()
       WHERE id = $1`,
      [id],
    );
  }

  private async markSkipped(id: number, error: string | null) {
    await this.pool.query(
      `UPDATE notification_deliveries
       SET state = 'SKIPPED', last_error = $2, updated_at = now()
       WHERE id = $1`,
      [id, truncateError(error)],
    );
  }

  /** Returns true when the row will not be retried again: the attempt ceiling has been reached. */
  private async markFailure(row: QueueRow, error: string) {
    const result = await this.pool.query(
      `UPDATE notification_deliveries
       SET state = CASE WHEN attempts >= $2 THEN 'FAILED' ELSE 'PENDING' END,
           last_error = $3,
           next_attempt_at = now() + ${retryDelaySql(row.attempts)},
           updated_at = now()
       WHERE id = $1
       RETURNING state`,
      [row.id, MAX_DELIVERY_ATTEMPTS, truncateError(error)],
    );
    return (result.rows[0] as { state: DeliveryState } | undefined)?.state === 'FAILED';
  }

  /** A subscription the push service no longer knows about is deactivated, and its queue is drained. */
  private async detachSubscription(subscriptionId: number, error: string) {
    await this.pool.query('UPDATE push_subscriptions SET active = false, failures = failures + 1, updated_at = now() WHERE id = $1', [
      subscriptionId,
    ]);
    const result = await this.pool.query(
      `UPDATE notification_deliveries
       SET state = 'FAILED', last_error = $2, updated_at = now()
       WHERE push_subscription_id = $1 AND state = 'PENDING'`,
      [subscriptionId, truncateError(error)],
    );
    return result.rowCount ?? 0;
  }
}

function subscriptionOf(row: QueueRow): PushSubscriptionRecord {
  return {
    id: String(row.subscriptionId),
    endpoint: row.endpoint ?? '',
    p256dh: row.p256dh ?? '',
    authSecret: row.authSecret ?? '',
  };
}

function messageOf(row: QueueRow): PushMessage {
  const data = (row.data ?? {}) as { eventId?: unknown };
  return {
    notificationId: row.notificationId,
    eventId: typeof data.eventId === 'string' ? data.eventId : row.notificationId,
    title: row.title,
    body: row.body,
    url: '/notifications',
  };
}

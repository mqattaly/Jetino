import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NotificationDeliveryService } from './notification-delivery.service';
import { PushSenderFactory, readPushConfig, WebPushSender, UnconfiguredPushSender } from './push-sender';
import {
  MAX_DELIVERY_ATTEMPTS,
  MAX_PUSH_FAILURES,
  allPushEventTypes,
  backoffSecondsFor,
  buildDeliveryPlan,
  endpointMatches,
  groupOfEvent,
  isPushKey,
  pushStateSummary,
  retryDelaySql,
  truncateError,
} from './notification-delivery.util';

type Recorded = { sql: string; values: unknown[] };

function fakePool(handler: (sql: string, values: unknown[]) => { rows: unknown[]; rowCount: number }) {
  const calls: Recorded[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    return handler(sql, values);
  };
  const client = { query, release() {} };
  return { calls, pool: { query, connect: async () => client } as never };
}

function serviceWith(pool: never, sender: { state: 'SENT' | 'FAILED' | 'SKIPPED'; error?: string | null; permanent?: boolean } = { state: 'SENT' }) {
  const senders = {
    resolve: async () => ({ kind: 'local' as const, send: async () => sender }),
    isConfigured: () => true,
    describe: () => ({ configured: true, vapidReady: true, subject: 'mailto:ops@jetino.app', allowLocal: false }),
    requirePublicKey: () => 'BPublic_Key_With_Enough_Length_For_Validation',
  } as unknown as PushSenderFactory;
  return new NotificationDeliveryService(pool, senders);
}

const NOTICE_ID = '123e4567-e89b-12d3-a456-426614174000';
const USER_ID = '223e4567-e89b-12d3-b456-426614174001';
const ENDPOINT = 'https://push.example.com/s/abc123';
const SUBSCRIPTION = { endpoint: ENDPOINT, p256dh: 'BDo_GttfSRr3iyjNR3mLpVvXkqFtQwZ1Yd6yqk7QZ8A', auth: 'tZK6z4rQp7YhY3m7QwA2xg' };

describe('delivery plan', () => {
  it('gives every recipient exactly one inbox row and no push row while the channel is off', () => {
    const plan = buildDeliveryPlan(NOTICE_ID, { userIds: [USER_ID, USER_ID, ''], pushConfigured: false });
    assert.equal(plan.length, 1);
    assert.deepEqual(plan[0], { notificationId: NOTICE_ID, userId: USER_ID, channel: 'IN_APP', subscriptionId: null });
  });

  it('adds one push row per recipient only when the push keys are present', () => {
    const plan = buildDeliveryPlan(NOTICE_ID, { userIds: [USER_ID, '323e4567-e89b-12d3-c456-426614174002'], pushConfigured: true });
    assert.equal(plan.length, 4);
    assert.deepEqual(
      plan.map((row) => `${row.userId.slice(0, 4)}:${row.channel}`),
      [`${USER_ID.slice(0, 4)}:IN_APP`, `${USER_ID.slice(0, 4)}:PUSH`, '323e:IN_APP', '323e:PUSH'],
    );
  });

  it('backs off between retries and stops at the attempt ceiling', () => {
    assert.equal(backoffSecondsFor(1), 30);
    assert.equal(backoffSecondsFor(2), 120);
    assert.equal(backoffSecondsFor(3), 600);
    assert.equal(backoffSecondsFor(99), 1800);
    assert.match(retryDelaySql(1), /^interval '30 seconds'$/);
    assert.equal(MAX_DELIVERY_ATTEMPTS, 5);
    assert.ok(MAX_PUSH_FAILURES > MAX_DELIVERY_ATTEMPTS);
  });

  it('reports pending over sent and skipped over failed', () => {
    assert.deepEqual(pushStateSummary({ sent: 1, pending: 1, failed: 0, skipped: 0 }), { state: 'PENDING' });
    assert.deepEqual(pushStateSummary({ sent: 1, pending: 0, failed: 3, skipped: 0 }), { state: 'SENT' });
    assert.deepEqual(pushStateSummary({ sent: 0, pending: 0, failed: 1, skipped: 4 }), { state: 'FAILED' });
    assert.deepEqual(pushStateSummary({ sent: 0, pending: 0, failed: 0, skipped: 2 }), { state: 'SKIPPED' });
    assert.deepEqual(pushStateSummary({ sent: 0, pending: 0, failed: 0, skipped: 0 }), { state: 'NONE' });
  });

  it('validates the pieces that end up in the database', () => {
    assert.equal(endpointMatches(ENDPOINT), true);
    assert.equal(endpointMatches('http://push.example.com/x'), false);
    assert.equal(endpointMatches('https://'), false);
    assert.equal(isPushKey(SUBSCRIPTION.p256dh), true);
    assert.equal(isPushKey('short'), false);
    assert.equal(truncateError(`  first\n line ${'x'.repeat(400)}`)!.length, 300);
    assert.equal(truncateError('   '), null);
  });
});

describe('push config', () => {
  it('stays unconfigured without both VAPID keys', () => {
    assert.equal(readPushConfig({}).configured, false);
    assert.equal(readPushConfig({ VAPID_PUBLIC_KEY: 'BDo_GttfSRr3iyjNR3mLpVvXkqFtQwZ1Yd6yqk7QZ8A' }).configured, false);
    const full = readPushConfig({
      VAPID_PUBLIC_KEY: 'BDo_GttfSRr3iyjNR3mLpVvXkqFtQwZ1Yd6yqk7QZ8A',
      VAPID_PRIVATE_KEY: 'YmVmN2MxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5MGFiY2RlZjAxMjM0',
      VAPID_SUBJECT: 'mailto:ops@jetino.app',
    });
    assert.equal(full.configured, true);
    assert.equal(readPushConfig({ VAPID_SUBJECT: 'ops@jetino.app' }).configured, false);
  });

  it('skips instead of faking a send when no transport exists', async () => {
    assert.deepEqual(await new UnconfiguredPushSender().send(), { state: 'SKIPPED', error: 'push-not-configured' });
  });

  it('treats a rejected subscription as permanent and everything else as retryable', async () => {
    const rejected = (statusCode: number) =>
      new WebPushSender({
        setVapidDetails: () => {},
        sendNotification: async () => {
          throw Object.assign(new Error('gone'), { statusCode });
        },
      });
    const failed = await rejected(410).send({ id: '1', endpoint: ENDPOINT, p256dh: SUBSCRIPTION.p256dh, authSecret: SUBSCRIPTION.auth }, { notificationId: NOTICE_ID, eventId: 'ORDER_NEW', title: 'a', body: 'b', url: '/notifications' });
    assert.equal(failed.state, 'FAILED');
    assert.equal(failed.permanent, true);
    assert.match(failed.error!, /HTTP 410/);

    const transient = await new WebPushSender({
      setVapidDetails: () => {},
      sendNotification: async () => {
        throw new Error('socket hang up');
      },
    } as never).send({ id: '1', endpoint: ENDPOINT, p256dh: SUBSCRIPTION.p256dh, authSecret: SUBSCRIPTION.auth }, { notificationId: NOTICE_ID, eventId: 'ORDER_NEW', title: 'a', body: 'b', url: '/notifications' });
    assert.equal(transient.state, 'FAILED');
    assert.equal(transient.permanent, undefined);
    assert.equal(transient.error, 'socket hang up');
  });
});

describe('subscriptions', () => {
  it('refuses a non-https endpoint and weak keys before touching the database', async () => {
    const { calls, pool } = fakePool(() => ({ rows: [], rowCount: 0 }));
    const service = serviceWith(pool);
    await assert.rejects(service.upsertSubscription(USER_ID, { ...SUBSCRIPTION, endpoint: 'http://x.example.com/1' }), BadRequestException);
    await assert.rejects(service.upsertSubscription(USER_ID, { ...SUBSCRIPTION, p256dh: 'nope' }), BadRequestException);
    assert.equal(calls.length, 0);
  });

  it('re-registers the same browser instead of stacking subscriptions', async () => {
    const { calls, pool } = fakePool(() => ({ rows: [{ id: '7', created: false }], rowCount: 1 }));
    const result = await serviceWith(pool).upsertSubscription(USER_ID, { ...SUBSCRIPTION, userAgent: 'Chrome' });
    assert.deepEqual(result, { id: '7', created: false, pushReady: true });
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /INSERT INTO push_subscriptions\(user_id,endpoint,p256dh,auth_secret,user_agent\)/);
    assert.match(calls[0].sql, /ON CONFLICT \(endpoint\) DO UPDATE/);
    assert.match(calls[0].sql, /failures = 0, active = true/);
    assert.deepEqual(calls[0].values, [USER_ID, ENDPOINT, SUBSCRIPTION.p256dh, SUBSCRIPTION.auth, 'Chrome']);
  });

  it('deletes only the caller’s own subscription when unsubscribing', async () => {
    const { calls, pool } = fakePool(() => ({ rows: [], rowCount: 1 }));
    assert.deepEqual(await serviceWith(pool).unsubscribe(USER_ID, { endpoint: ENDPOINT }), { removed: 1 });
    assert.match(calls[0].sql, /WHERE user_id = \$1 AND endpoint = \$2/);
    await assert.rejects(serviceWith(fakePool(() => ({ rows: [], rowCount: 0 })).pool).unsubscribe(USER_ID, {}), BadRequestException);
  });
});

describe('event preferences', () => {
  it('expands a disabled group into one row per event type', async () => {
    const { calls, pool } = fakePool(() => ({ rows: [], rowCount: 0 }));
    const result = await serviceWith(pool).setPreferences(USER_ID, { groups: ['ORDER_STATUS'] });
    assert.deepEqual(result, { mutedEvents: allPushEventTypes().length - 6, enabledGroups: ['ORDER_STATUS'] });
    assert.match(calls[0].sql, /^BEGIN$/);
    assert.match(calls[1].sql, /DELETE FROM push_event_opt_outs WHERE user_id = \$1/);
    assert.equal(calls.filter((call) => call.sql.includes('INSERT INTO push_event_opt_outs')).length, allPushEventTypes().length - 6);
    assert.match(calls.at(-1)!.sql, /^COMMIT$/);
    // only the group that was named stays loud: this is PUT, not a patch
    assert.equal(calls.some((call) => call.values?.includes('ORDER_CONFIRMED')), false);
    assert.equal(calls.some((call) => call.values?.includes('DELIVERY_ASSIGNED')), true);
    assert.equal(calls.some((call) => call.values?.includes('ORDER_NEW')), true);
  });

  it('refuses an unknown group rather than silently ignoring it', async () => {
    const { calls, pool } = fakePool(() => ({ rows: [], rowCount: 0 }));
    await assert.rejects(serviceWith(pool).setPreferences(USER_ID, { groups: ['ORDERS'] }), BadRequestException);
    await assert.rejects(serviceWith(pool).setPreferences(USER_ID, { groups: 'ORDER_STATUS' }), BadRequestException);
    assert.equal(calls.length, 0);
  });

  it('reads the muted set back as group state', async () => {
    const { pool } = fakePool((sql) =>
      sql.includes('push_event_opt_outs')
        ? { rows: [{ eventType: 'ORDER_DELIVERED' }, { eventType: 'ORDER_CONFIRMED' }], rowCount: 2 }
        : { rows: [], rowCount: 0 },
    );
    const result = await serviceWith(pool).getPreferences(USER_ID);
    const orderStatus = result.groups.find((group: { key: string }) => group.key === 'ORDER_STATUS')!;
    assert.equal(orderStatus.enabled, false);
    assert.equal(orderStatus.partiallyMuted, true);
    assert.equal(result.groups.find((group: { key: string }) => group.key === 'SHOP')!.enabled, true);
    assert.deepEqual(result.mutedEvents, ['ORDER_DELIVERED', 'ORDER_CONFIRMED']);
    assert.equal(groupOfEvent('ORDER_NEW'), 'SHOP');
    assert.equal(groupOfEvent('UNKNOWN_EVENT'), null);
  });
});

describe('dispatch', () => {
  const queueRow = (over: Record<string, unknown> = {}) => ({
    id: 11,
    notificationId: NOTICE_ID,
    userId: USER_ID,
    channel: 'IN_APP',
    attempts: 1,
    pushSubscriptionId: null,
    eventType: 'ORDER_NEW',
    title: 'سفارش تازه',
    body: 'برای بررسی ثبت شد',
    data: { orderId: 'order-1' },
    subscriptionId: null,
    endpoint: null,
    p256dh: null,
    authSecret: null,
    ...over,
  });
  const pushRow = (over: Record<string, unknown> = {}) =>
    queueRow({
      channel: 'PUSH',
      subscriptionId: '9',
      pushSubscriptionId: 9,
      endpoint: ENDPOINT,
      p256dh: SUBSCRIPTION.p256dh,
      authSecret: SUBSCRIPTION.auth,
      ...over,
    });

  /** The due list answers with ids only; the claim CTE answers with the row, if it is still ours. */
  const dispatchPool = (row: Record<string, unknown> | null, updateRows: Record<string, unknown> = {}) =>
    fakePool((sql) => {
      if (sql.startsWith('SELECT d.id')) return row ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (sql.includes('WITH claimed AS')) return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      return { rows: [updateRows], rowCount: 1 };
    });

  it('lists only due rows under the attempt ceiling, without holding a lock across the send', async () => {
    const { calls, pool } = dispatchPool(null);
    const summary = await serviceWith(pool).dispatch();
    assert.deepEqual(summary, { due: 0, claimed: 0, sent: 0, failed: 0, skipped: 0, exhausted: 0, detached: 0, sender: 'local' });
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /WHERE d\.state = 'PENDING' AND d\.next_attempt_at <= now\(\) AND d\.attempts < \$1/);
    assert.deepEqual(calls[0].values, [MAX_DELIVERY_ATTEMPTS, 50]);
    // a FOR UPDATE lock would have to be held across the HTTP call to the push service
    assert.doesNotMatch(calls[0].sql, /FOR UPDATE/);
  });

  it('walks away from a row another worker leased', async () => {
    const { calls, pool } = fakePool((sql) => {
      if (sql.startsWith('SELECT d.id')) return { rows: [{ id: 11 }], rowCount: 1 };
      if (sql.includes('WITH claimed AS')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    const summary = await serviceWith(pool).dispatch();
    assert.deepEqual({ due: summary.due, claimed: summary.claimed, sent: summary.sent }, { due: 1, claimed: 0, sent: 0 });
    assert.equal(calls.length, 2, 'a lost claim must not write anything');
  });

  it('leases a row by counting the attempt and pushing its due time out', async () => {
    const { calls, pool } = dispatchPool(queueRow());
    await serviceWith(pool).dispatch();
    const claim = calls.find((call) => call.sql.includes('WITH claimed AS'))!;
    assert.match(claim.sql, /SET attempts = d\.attempts \+ 1, next_attempt_at = now\(\) \+ interval '120 seconds'/);
    assert.match(claim.sql, /WHERE d\.id = \$1 AND d\.state = 'PENDING' AND d\.next_attempt_at <= now\(\) AND d\.attempts < \$2/);
    assert.deepEqual(claim.values, [11, MAX_DELIVERY_ATTEMPTS]);
  });

  it('marks an inbox row sent without any transport', async () => {
    const { calls, pool } = dispatchPool(queueRow());
    const summary = await serviceWith(pool).dispatch();
    assert.deepEqual({ sent: summary.sent, claimed: summary.claimed, sender: summary.sender }, { sent: 1, claimed: 1, sender: 'local' });
    const update = calls.find((call) => call.sql.includes("SET state = 'SENT'"))!;
    assert.match(update.sql, /last_error = NULL, sent_at = now\(\)/);
    assert.deepEqual(update.values, [11]);
  });

  it('records SKIPPED for a push row whose subscription is gone, without failing it', async () => {
    const { calls, pool } = dispatchPool(pushRow({ id: 12, subscriptionId: null, pushSubscriptionId: null, endpoint: null }));
    const summary = await serviceWith(pool).dispatch();
    assert.equal(summary.skipped, 1);
    assert.equal(summary.failed, 0);
    const update = calls.find((call) => call.sql.includes("SET state = 'SKIPPED'"))!;
    assert.deepEqual(update.values, [12, 'no-active-subscription']);
  });

  it('retries a transient failure with backoff and stops at the ceiling', async () => {
    const first = dispatchPool(pushRow({ id: 13 }), { state: 'PENDING' });
    const summaryFirst = await serviceWith(first.pool, { state: 'FAILED', error: 'timeout' }).dispatch();
    assert.deepEqual({ failed: summaryFirst.failed, exhausted: summaryFirst.exhausted }, { failed: 1, exhausted: 0 });
    const retry = first.calls.find((call) => call.sql.includes("SET state = CASE WHEN attempts >= $2 THEN 'FAILED' ELSE 'PENDING' END"))!;
    assert.match(retry.sql, /interval '30 seconds'/, 'one attempt spent means the first, shortest wait');
    assert.deepEqual(retry.values, [13, MAX_DELIVERY_ATTEMPTS, 'timeout']);

    const last = dispatchPool(pushRow({ id: 13, attempts: MAX_DELIVERY_ATTEMPTS }), { state: 'FAILED' });
    const summaryLast = await serviceWith(last.pool, { state: 'FAILED', error: 'timeout' }).dispatch();
    assert.deepEqual({ failed: summaryLast.failed, exhausted: summaryLast.exhausted }, { failed: 1, exhausted: 1 });
    const final = last.calls.find((call) => call.sql.includes("SET state = CASE WHEN attempts >= $2 THEN 'FAILED' ELSE 'PENDING' END"))!;
    assert.match(final.sql, /interval '1800 seconds'/);
  });

  it('deactivates a subscription the push service rejected and drains its queue', async () => {
    const { calls, pool } = fakePool((sql) => {
      if (sql.startsWith('SELECT d.id')) return { rows: [{ id: 14 }], rowCount: 1 };
      if (sql.includes('WITH claimed AS')) return { rows: [pushRow({ id: 14 })], rowCount: 1 };
      return { rows: [], rowCount: 3 };
    });
    const summary = await serviceWith(pool, {
      state: 'FAILED',
      error: 'push service rejected the subscription (HTTP 410)',
      permanent: true,
    }).dispatch();
    assert.deepEqual({ failed: summary.failed, detached: summary.detached, exhausted: summary.exhausted }, { failed: 1, detached: 3, exhausted: 0 });
    const deactivate = calls.find((call) => call.sql.includes('UPDATE push_subscriptions'))!;
    assert.match(deactivate.sql, /SET active = false, failures = failures \+ 1/);
    assert.deepEqual(deactivate.values, [9]);
    const drained = calls.find((call) => call.sql.includes("WHERE push_subscription_id = $1 AND state = 'PENDING'"))!;
    assert.deepEqual(drained.values, [9, 'push service rejected the subscription (HTTP 410)']);
  });

  it('keeps the batch inside the configured ceiling', async () => {
    const { calls, pool } = dispatchPool(null);
    await serviceWith(pool).dispatch(10_000);
    assert.deepEqual(calls[0].values, [MAX_DELIVERY_ATTEMPTS, 50]);
    await serviceWith(dispatchPool(null).pool).dispatch(0);
    assert.equal(calls.length, 1, 'a second service on another pool must not touch these calls');
  });
});

describe('queue read side', () => {
  it('only exposes another user’s delivery rows through the staff queue', async () => {
    const { calls, pool } = fakePool(() => ({ rows: [], rowCount: 0 }));
    const service = serviceWith(pool);
    await assert.rejects(service.deliveryForNotification(USER_ID, 'not-a-uuid'), NotFoundException);
    await service.recentDeliveries('sent');
    assert.deepEqual(calls[0].values, ['SENT']);
    await service.recentDeliveries('everything');
    assert.deepEqual(calls[1].values, [null]);
  });

  it('refuses to re-queue a delivery that is not failed', async () => {
    const { calls, pool } = fakePool(() => ({ rows: [], rowCount: 0 }));
    await assert.rejects(serviceWith(pool).retryDelivery('0'), BadRequestException);
    await assert.rejects(serviceWith(pool).retryDelivery('-3'), BadRequestException);
    await assert.rejects(serviceWith(pool).retryDelivery('abc'), BadRequestException);
    assert.equal(calls.length, 0);
    await assert.rejects(serviceWith(fakePool(() => ({ rows: [], rowCount: 0 })).pool).retryDelivery('42'), NotFoundException);
    const { calls: ok, pool: okPool } = fakePool(() => ({ rows: [{ id: '42' }], rowCount: 1 }));
    assert.deepEqual(await serviceWith(okPool).retryDelivery('42'), { retried: 1 });
    assert.match(ok[0].sql, /WHERE id = \$1 AND state = 'FAILED'/);
  });
});

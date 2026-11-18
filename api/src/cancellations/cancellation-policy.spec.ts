import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CANCELLABLE, DEFAULT_POLICY, POLICY_OPTIONS, decide, parsePolicy, parsePolicyUpdate, readPolicy, rejectionMessage } from './cancellation-policy';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe('cancellation policy decisions', () => {
  it('grants the cancel alone only while the business has not answered', () => {
    assert.deepEqual(decide(DEFAULT_POLICY, { status: 'PENDING_BUSINESS', createdAt: minutesAgo(1) }), { allowed: true, code: 'POLICY' });
    for (const status of ['CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'DRIVER_ASSIGNED', 'OUT_FOR_DELIVERY']) {
      assert.equal(decide(DEFAULT_POLICY, { status, createdAt: minutesAgo(1) }).allowed, false, `${status} must not be self-service by default`);
    }
  });

  it('sends anything still open to a human, and blocks what already reached an outcome', () => {
    assert.equal(decide(DEFAULT_POLICY, { status: 'CONFIRMED', createdAt: minutesAgo(1) }).code, 'STAFF_ONLY');
    for (const status of ['DELIVERED', 'REJECTED', 'UNDER_REVIEW']) {
      assert.equal(decide(DEFAULT_POLICY, { status, createdAt: minutesAgo(1) }).code, 'SETTLED', `${status} is closed`);
    }
    assert.equal(decide(DEFAULT_POLICY, { status: 'CANCELLED', createdAt: minutesAgo(1) }).code, 'CANCELLED');
  });

  it('follows the statuses an operator opted into', () => {
    const policy = { autoCancelStatuses: ['PENDING_BUSINESS', 'CONFIRMED', 'PREPARING'], windowMinutes: 0 };
    assert.deepEqual(decide(policy, { status: 'PREPARING', createdAt: minutesAgo(90) }), { allowed: true, code: 'POLICY' });
    assert.equal(decide(policy, { status: 'READY_FOR_PICKUP', createdAt: minutesAgo(1) }).code, 'STAFF_ONLY');
    assert.equal(decide(policy, { status: 'DRIVER_ASSIGNED', createdAt: minutesAgo(1) }).code, 'STAFF_ONLY', 'a courier is already committed');
  });

  it('applies the time window only when one is configured', () => {
    const windowed = { autoCancelStatuses: ['PENDING_BUSINESS'], windowMinutes: 15 };
    assert.equal(decide(windowed, { status: 'PENDING_BUSINESS', createdAt: minutesAgo(5) }).allowed, true);
    assert.equal(decide(windowed, { status: 'PENDING_BUSINESS', createdAt: minutesAgo(15) }).allowed, true, 'the last minute is still inside the window');
    assert.equal(decide(windowed, { status: 'PENDING_BUSINESS', createdAt: minutesAgo(16) }).code, 'WINDOW');
    assert.equal(decide(windowed, { status: 'PENDING_BUSINESS', createdAt: minutesAgo(-2) }).code, 'WINDOW', 'a clock skew must not grant extra time');
    assert.equal(decide(windowed, { status: 'CONFIRMED', createdAt: minutesAgo(120) }).code, 'STAFF_ONLY', 'policy is checked before the window');
  });

  it('explains every refusal with the word the customer searched for', () => {
    for (const status of ['CONFIRMED', 'DELIVERED', 'CANCELLED']) {
      assert.match(rejectionMessage(decide(DEFAULT_POLICY, { status, createdAt: minutesAgo(1) })), /لغو/);
    }
    assert.match(rejectionMessage(decide({ autoCancelStatuses: ['PENDING_BUSINESS'], windowMinutes: 5 }, { status: 'PENDING_BUSINESS', createdAt: minutesAgo(60) })), /ثبت شد/);
  });
});

describe('cancellation policy parsing', () => {
  it('falls back to the defaults instead of trusting the row', () => {
    assert.deepEqual(parsePolicy(undefined), DEFAULT_POLICY);
    assert.deepEqual(parsePolicy({ auto_statuses: 'NOPE,,CONFIRMED', window_minutes: '99999' }), { autoCancelStatuses: ['CONFIRMED'], windowMinutes: 0 });
    assert.deepEqual(parsePolicy({ auto_statuses: 'DELIVERED', window_minutes: -5 }), DEFAULT_POLICY, 'a closed status can never be self-cancellable');
    assert.deepEqual(parsePolicy({ auto_statuses: ' PENDING_BUSINESS , CONFIRMED ', window_minutes: 30 }), { autoCancelStatuses: ['PENDING_BUSINESS', 'CONFIRMED'], windowMinutes: 30 });
  });

  it('refuses what an operator typed by hand', () => {
    assert.deepEqual(parsePolicyUpdate({ windowMinutes: 0 }), { windowMinutes: 0 });
    assert.deepEqual(parsePolicyUpdate({ autoCancelStatuses: 'CONFIRMED, CONFIRMED' }), { autoCancelStatuses: ['CONFIRMED'] });
    assert.throws(() => parsePolicyUpdate({}), /حداقل یک قاعده/);
    assert.throws(() => parsePolicyUpdate({ autoCancelStatuses: [] }), /حداقل یک وضعیت/);
    assert.throws(() => parsePolicyUpdate({ autoCancelStatuses: ['DELIVERED'] }), /DELIVERED/);
    assert.throws(() => parsePolicyUpdate({ windowMinutes: 1441 }), /۱۴۴۰/);
    assert.throws(() => parsePolicyUpdate({ windowMinutes: 1.5 }), /۰ تا ۱۴۴۰/);
  });

  it('reads the single row the migration seeds', async () => {
    const seen: string[] = [];
    const policy = await readPolicy({ query: async (sql: string) => { seen.push(sql); return { rows: [{ auto_statuses: 'PENDING_BUSINESS,CONFIRMED', window_minutes: 10 }] }; } });
    assert.deepEqual(policy, { autoCancelStatuses: ['PENDING_BUSINESS', 'CONFIRMED'], windowMinutes: 10 });
    assert.match(seen[0], /FROM cancellation_policies WHERE id=1/);
    assert.deepEqual(await readPolicy({ query: async () => ({ rows: [] }) }), DEFAULT_POLICY);
  });

  it('keeps the two status lists telling the same story', () => {
    assert.deepEqual(POLICY_OPTIONS, CANCELLABLE.slice(0, POLICY_OPTIONS.length), 'everything a customer may be granted is still cancellable');
    assert.ok(!POLICY_OPTIONS.includes('DRIVER_ASSIGNED'));
    assert.ok(!CANCELLABLE.includes('DELIVERED'), 'a staff decision must not resurrect a delivered order');
  });
});

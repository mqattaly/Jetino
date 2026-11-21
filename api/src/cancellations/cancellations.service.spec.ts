import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { CancellationsService } from './cancellations.service';

const staff = { sub: 'a0000000-0000-4000-8000-0000000000a1', roles: ['OPERATIONS_MANAGER'] };
const owner = { sub: 'a0000000-0000-4000-8000-0000000000b1', roles: ['BUSINESS_OWNER'] };
const stranger = { sub: 'a0000000-0000-4000-8000-0000000000c2', roles: ['CUSTOMER'] };
const orderId = 'b0000000-0000-4000-8000-000000000001';
const requestId = 'c0000000-0000-4000-8000-000000000001';
const customer = 'a0000000-0000-4000-8000-0000000000c1';

type Answer = { rows: unknown[]; rowCount: number };
const queryRow: Answer = { rows: [{ auto_statuses: 'PENDING_BUSINESS', window_minutes: 0 }], rowCount: 1 };

/** The service talks to the pool and to a transaction with the same statements, so one resolver covers both. */
function harness(resolver: (sql: string, values: unknown[]) => Answer | null) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[] = []): Promise<Answer> => {
    calls.push({ sql, values });
    return resolver(sql, values) ?? { rows: [], rowCount: 1 };
  };
  const client = { query, release() {} };
  const pool = { query, connect: async () => client };
  const service = new CancellationsService(pool as never);
  const written = (prefix: string) => calls.filter(call => call.sql.trim().startsWith(prefix));
  return { service, calls, query, written, notices: () => written('INSERT INTO notifications') };
}

const pending = (order: Record<string, unknown> = {}) => ({
  rows: [{ id: requestId, outcome: 'PENDING', order_id: orderId, orderId, reason: 'سفارش دیر آماده می‌شود', requestedBy: customer, orderStatus: 'PREPARING', ownerId: owner.sub, ...order }],
  rowCount: 1,
});

describe('CancellationsService policy', () => {
  it('persists only what an operator is allowed to grant, and records the previous rules', async () => {
    const { service, calls } = harness(sql => {
      if (sql.startsWith('UPDATE cancellation_policies')) return { rows: [{ auto_statuses: 'PENDING_BUSINESS,CONFIRMED', window_minutes: 20 }], rowCount: 1 };
      return queryRow;
    });
    const policy = await service.setPolicy(staff, { autoCancelStatuses: ['PENDING_BUSINESS', 'CONFIRMED'], windowMinutes: 20 });
    assert.deepEqual(policy, { autoCancelStatuses: ['PENDING_BUSINESS', 'CONFIRMED'], windowMinutes: 20 });
    const update = calls.find(call => call.sql.startsWith('UPDATE cancellation_policies'))!;
    assert.deepEqual(update.values, ['PENDING_BUSINESS,CONFIRMED', 20, staff.sub]);
    const audit = calls.find(call => call.sql.startsWith('INSERT INTO audit_logs'))!;
    assert.equal(audit.values?.[1], 'CANCEL_POLICY_UPDATED');
    assert.match(String(audit.values?.[4]), /"before":\{"autoCancelStatuses":\["PENDING_BUSINESS"\],"windowMinutes":0\}/);
  });

  it('refuses a rule nobody should be able to buy', async () => {
    const { service, calls } = harness(() => { throw new Error('no statement may run'); });
    await assert.rejects(service.setPolicy(staff, { autoCancelStatuses: ['DELIVERED'] }), /DELIVERED/);
    await assert.rejects(service.setPolicy(staff, { windowMinutes: 2000 }), /۱۴۴۰/);
    await assert.rejects(service.setPolicy(staff, {}), /حداقل یک قاعده/);
    assert.equal(calls.length, 0);
  });
});

describe('CancellationsService queue', () => {
  it('starts on the oldest open request and counts every bucket', async () => {
    const { service, calls } = harness(sql => {
      if (sql.includes('FROM cancellation_requests GROUP BY outcome')) return { rows: [{ outcome: 'PENDING', count: 2 }, { outcome: 'REJECTED', count: 5 }], rowCount: 2 };
      if (sql.includes('COUNT(*)::int AS "totalMatches"')) return { rows: [{ totalMatches: 2 }], rowCount: 1 };
      if (sql.startsWith('SELECT c.id,c.order_id')) return { rows: [{ id: requestId }], rowCount: 1 };
      return null;
    });
    const result = await service.queue({});
    assert.deepEqual(result.counts, { PENDING: 2, REJECTED: 5 });
    assert.equal(result.totalMatches, 2);
    assert.equal(result.limit, 15);
    const items = calls.find(call => call.sql.startsWith('SELECT c.id,c.order_id'))!;
    assert.deepEqual(items.values, ['PENDING', 15, 0]);
    assert.match(items.sql, /ORDER BY c\.created_at ASC,c\.id ASC/);
  });

  it('answers already-worked requests newest-first, and searches on the phone or order number', async () => {
    const { service, calls } = harness(sql => (sql.includes('COUNT(*)::int AS "totalMatches"') ? { rows: [{ totalMatches: 1 }], rowCount: 1 } : null));
    await service.queue({ outcome: 'ACCEPTED', search: '0912', limit: '3', offset: '6' });
    const items = calls.find(call => call.sql.startsWith('SELECT c.id,c.order_id'))!;
    assert.match(items.sql, /c\.outcome=\$1/);
    assert.match(items.sql, /ILIKE \$2/);
    assert.match(items.sql, /ORDER BY c\.created_at DESC,c\.id DESC/);
    assert.deepEqual(items.values, ['ACCEPTED', '%0912%', 3, 6]);
    assert.deepEqual(calls.find(call => call.sql.includes('"totalMatches"'))!.values, ['ACCEPTED', '%0912%']);
  });

  it('will not invent a bucket or a page size', async () => {
    const { service, calls } = harness(() => { throw new Error('no statement may run'); });
    await assert.rejects(service.queue({ outcome: 'SOMETHING' }), BadRequestException);
    await assert.rejects(service.queue({ limit: '900' }), /اندازهٔ صفحه/);
    await assert.rejects(service.queue({ offset: '-1' }), /جابه‌جایی/);
    assert.equal(calls.length, 0);
  });
});

describe('CancellationsService.decideRequest', () => {
  it('needs a reason to refuse a customer, and refuses to touch an answered request', async () => {
    const missing = harness(() => null);
    await assert.rejects(missing.service.decideRequest(staff, requestId, { decision: 'REJECT' }), /دلیل لازم است/);
    assert.equal(missing.calls.length, 0, 'validation happens before the database');

    const answered = harness(sql => (sql.includes('FROM cancellation_requests c JOIN orders o') ? pending({ outcome: 'ACCEPTED' }) : null));
    await assert.rejects(answered.service.decideRequest(staff, requestId, { decision: 'REJECT', note: 'اشتباه ثبت شد' }), ConflictException);
    assert.equal(answered.calls.at(-1)?.sql, 'ROLLBACK');
  });

  it('lets the shop answer its own order, but nobody else\'s', async () => {
    const allowed = harness(sql => (sql.includes('FROM cancellation_requests c JOIN orders o') ? pending() : null));
    const result = await allowed.service.decideRequest(owner, requestId, { decision: 'REJECT', note: 'غذا آماده شده و امکان لغو نیست' });
    assert.deepEqual(result, { requestId, orderId, outcome: 'REJECTED', status: 'PREPARING' });
    await assert.rejects(allowed.service.decideRequest(stranger, requestId, { decision: 'ACCEPT', note: 'لغو کن' }), ForbiddenException);
  });

  it('cancels the order through the shared writer and tells the customer who answered', async () => {
    const { service, calls, notices } = harness(sql => {
      if (sql.includes('FROM cancellation_requests c JOIN orders o')) return pending({ orderStatus: 'PREPARING' });
      return null;
    });
    const result = await service.decideRequest(staff, requestId, { decision: 'ACCEPT' });
    assert.deepEqual(result, { requestId, orderId, outcome: 'ACCEPTED', status: 'CANCELLED' });
    assert.ok(calls.some(call => call.sql.startsWith(`UPDATE orders SET status='CANCELLED'`)), 'the accepted request must move the order');
    assert.match(String(calls.find(call => call.sql.startsWith('INSERT INTO order_status_history'))!.values?.[3]!), /لغو با تأیید کادر عملیات/);
    const update = calls.find(call => call.sql.startsWith('UPDATE cancellation_requests SET outcome'))!;
    assert.deepEqual(update.values, [requestId, 'ACCEPTED', staff.sub, 'کادر عملیات لغو را تأیید کرد.']);
    const notice = notices().find(entry => entry.values?.[1] === 'ORDER_CANCELLATION_DECIDED')!;
    assert.deepEqual(notice.values?.slice(0, 3), [customer, 'ORDER_CANCELLATION_DECIDED', 'درخواست لغو شما تأیید شد']);
    // both rows stay: the order moved, and a human answered the request — §7.11 wants them tied together
    const audits = calls.filter(call => call.sql.startsWith('INSERT INTO audit_logs'));
    assert.deepEqual(audits.map(call => call.values?.[1]), ['ORDER_CANCELLED', 'ORDER_CANCELLATION_DECIDED']);
    assert.equal(JSON.parse(String(audits.at(-1)!.values?.[4])).orderStatus, 'PREPARING');
    assert.equal(calls.at(-1)?.sql, 'COMMIT');
  });

  it('voids instead of resurrecting an order that no longer allows cancellation', async () => {
    const { service, calls } = harness(sql => (sql.includes('FROM cancellation_requests c JOIN orders o') ? pending({ orderStatus: 'DELIVERED' }) : null));
    const result = await service.decideRequest(staff, requestId, { decision: 'ACCEPT' });
    assert.equal(result.outcome, 'VOIDED');
    assert.equal(result.status, 'DELIVERED');
    assert.ok(!calls.some(call => call.sql.startsWith('UPDATE orders')), 'a delivered order must stay delivered');
    const update = calls.find(call => call.sql.startsWith('UPDATE cancellation_requests SET outcome'))!;
    assert.match(String(update.values?.[3]), /دیگر لغوپذیر نیست/);
  });
});

describe('CancellationsService refund ledger', () => {
  const totals = (collectedRial: string, refundedRial: string, extra: Record<string, unknown> = {}) => ({
    rows: [{ id: orderId, status: 'CANCELLED', paymentStatus: 'PAID', totalRial: '150000', collectedRial, refundedRial, walletRefundedRial: refundedRial, ...extra }],
    rowCount: 1,
  });

  it('sums the ledger on the server and never trusts the client with the room left', async () => {
    const { service } = harness(sql => {
      if (sql.includes('COALESCE((SELECT cc.amount_rial')) return totals('150000', '100000');
      if (sql.includes('FROM order_refunds r JOIN users u')) return { rows: [{ id: 'r-1', amountRial: '100000', kind: 'REFUND', reason: 'نیمی از سفارش نرسید' }], rowCount: 1 };
      return null;
    });
    const ledger = await service.refunds(stranger, orderId);
    assert.deepEqual(ledger, { orderId, collectedRial: '150000', refundedRial: '100000', refundableRial: '50000', items: [{ id: 'r-1', amountRial: '100000', kind: 'REFUND', reason: 'نیمی از سفارش نرسید' }] });
  });

  it('refuses a refund nobody authorised or an amount that is not money', async () => {
    const { service, calls } = harness(() => { throw new Error('no statement may run'); });
    await assert.rejects(service.recordRefund(stranger, orderId, { requestKey: randomUUID(), amountRial: 1000, reason: 'بازپرداخت مشتری' }), ForbiddenException);
    await assert.rejects(service.recordRefund(staff, orderId, { requestKey: randomUUID(), amountRial: 0, reason: 'صفر' }), /غیرصفر/);
    await assert.rejects(service.recordRefund(staff, orderId, { requestKey: randomUUID(), amountRial: 1e13, reason: 'زیاد' }), /محدودهٔ مجاز/);
    await assert.rejects(service.recordRefund(staff, orderId, { requestKey: randomUUID(), amountRial: 1000, reason: 'بدون طرف' , fundedBy: 'BANK' }), /طرف پرداخت‌کننده/);
    await assert.rejects(service.recordRefund(staff, orderId, { requestKey: randomUUID(), amountRial: 1000, reason: 'خطا' }), /دلیل بازپرداخت/);
    assert.equal(calls.length, 0);
  });

  it('writes one row, keeps the total inside what was collected and derives the payment status', async () => {
    const { service, calls, notices } = harness(sql => (sql.includes('COALESCE((SELECT cc.amount_rial') ? totals('150000', '100000') : null));
    const result = await service.recordRefund(staff, orderId, { requestKey: randomUUID(), amountRial: 50000, reason: 'بسته دوم اصلاً نرسید', fundedBy: 'BUSINESS' });
    assert.deepEqual(result, { orderId, amountRial: 50000, kind: 'REFUND', fundedBy: 'BUSINESS', paymentStatus: 'REFUNDED', refundedRial: '150000', refundableRial: '0' });
    const insert = calls.find(call => call.sql.startsWith('INSERT INTO order_refunds'))!;
    assert.match(insert.sql, /'WALLET'/);
    assert.deepEqual(insert.values.slice(0, 6), [orderId, 50000, 'REFUND', 'BUSINESS', 'بسته دوم اصلاً نرسید', staff.sub]);
    assert.deepEqual(calls.find(call => call.sql.startsWith('UPDATE orders SET payment_status'))!.values, [orderId, 'REFUNDED']);
    assert.equal(notices().at(-1)?.values?.[1], 'ORDER_REFUNDED');
    assert.match(String(notices().at(-1)?.values?.[3]), /۵۰٬۰۰۰ ریال/);
    assert.equal(calls.at(-1)?.sql, 'COMMIT');
  });

  it('will not hand back money nobody collected, nor more than the ledger holds', async () => {
    const nothing = harness(sql => (sql.includes('COALESCE((SELECT cc.amount_rial') ? totals('0', '0') : null));
    await assert.rejects(nothing.service.recordRefund(staff, orderId, { requestKey: randomUUID(), amountRial: 5000, reason: 'صفر بوده' }), ConflictException);
    assert.ok(!nothing.calls.some(call => call.sql.startsWith('INSERT INTO order_refunds')));

    const over = harness(sql => (sql.includes('COALESCE((SELECT cc.amount_rial') ? totals('150000', '100000') : null));
    await assert.rejects(over.service.recordRefund(staff, orderId, { requestKey: randomUUID(), amountRial: 60000, reason: 'بیش از باقی‌مانده' }), /سقف بازپرداخت این سفارش 50000 ریال است/);

    const clawback = harness(sql => (sql.includes('COALESCE((SELECT cc.amount_rial') ? totals('150000', '10000') : null));
    await assert.rejects(clawback.service.recordRefund(staff, orderId, { requestKey: randomUUID(), amountRial: -20000, reason: 'اشتباه دوباره ثبت شد' }), /نمی‌تواند منفی شود/);
    assert.equal(clawback.calls.at(-1)?.sql, 'ROLLBACK', 'a rejected ledger row rolls the transaction back');
  });

  it('never claws back historical refunds that were not credited to the wallet', async () => {
    const legacy = harness(sql => (sql.includes('COALESCE((SELECT cc.amount_rial') ? totals('150000', '100000', { walletRefundedRial: '0' }) : null));
    await assert.rejects(legacy.service.recordRefund(staff, orderId, { requestKey: randomUUID(), amountRial: -5000, reason: 'اصلاح بازپرداخت قبلی' }), /بازپرداخت‌های قدیمی/);
    assert.ok(!legacy.calls.some(call => call.sql.startsWith('INSERT INTO order_refunds')));
    assert.equal(legacy.calls.at(-1)?.sql, 'ROLLBACK');
  });

  it('keeps a correction as a second row instead of editing the first one', async () => {
    const { service, calls } = harness(sql => (sql.includes('COALESCE((SELECT cc.amount_rial') ? totals('150000', '150000') : null));
    const result = await service.recordRefund(staff, orderId, { requestKey: randomUUID(), amountRial: -5000, reason: 'مبلغ اشتباه وارد شده بود' });
    assert.equal(result.kind, 'CORRECTION');
    assert.deepEqual(result.refundedRial, '145000');
    assert.equal(result.paymentStatus, 'PAID', 'money is owed again, so the order is not refunded any more');
    assert.deepEqual(result.refundableRial, '5000');
    assert.match(String(calls.find(call => call.sql.startsWith('INSERT INTO audit_logs'))!.values?.[4]), /"kind":"CORRECTION"/);
  });
});

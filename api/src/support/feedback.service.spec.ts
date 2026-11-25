import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { FeedbackService } from './feedback.service';

const customer = { sub: 'a0000000-0000-4000-8000-0000000000c1', roles: ['CUSTOMER'] };
const orderId = 'b0000000-0000-4000-8000-000000000001';

const deliveredOrder = { id: orderId, status: 'DELIVERED', business_id: 'b0000000-0000-4000-8000-000000000002', driver_id: 'b0000000-0000-4000-8000-000000000003' };
const savedRow = { id: 'f-1', order_id: orderId, business_rating: 4, driver_rating: 5, comment: 'داغ رسید', created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') };

type Handler = (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

/** A PoolClient-shaped fake: one handler for both the pool and the transaction client. */
function harness(handler: Handler) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const query = async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    return handler(sql, values);
  };
  const client = { query, release() {} };
  const pool = { query, connect: async () => client };
  return { service: new FeedbackService(pool as never), calls };
}

const ok = (rows: unknown[]): Handler => async sql => {
  if (sql.includes('FROM orders o')) return { rows: [deliveredOrder], rowCount: 1 };
  if (sql.includes('FROM order_feedback WHERE order_id')) return { rows: [], rowCount: 0 };
  if (sql.includes('RETURNING')) return { rows: [savedRow], rowCount: 1 };
  if (sql.includes('FROM businesses')) return { rows: [{ owner_id: 'a0000000-0000-4000-8000-0000000000b1', name: 'رستوران' }], rowCount: 1 };
  if (sql.includes('FROM drivers')) return { rows: [{ user_id: 'a0000000-0000-4000-8000-0000000000d1' }], rowCount: 1 };
  return { rows, rowCount: rows.length };
};

describe('FeedbackService.save', () => {
  it('refuses a malformed id before any query', async () => {
    const { service, calls } = harness(async () => { throw new Error('unreachable'); });
    await assert.rejects(service.save(customer, 'not-a-uuid', { businessRating: 4 }), BadRequestException);
    assert.equal(calls.length, 0);
  });

  it('requires an integer between one and five', async () => {
    const { service, calls } = harness(ok([]));
    for (const value of [undefined, 0, 6, 2.5, 'four', null]) {
      await assert.rejects(service.save(customer, orderId, { businessRating: value }), BadRequestException, `accepted ${String(value)}`);
    }
    assert.equal(calls.length, 0, 'validation must happen before the database is touched');
  });

  it('will not rate an order that has not been delivered', async () => {
    const { service } = harness(async sql => (sql.includes('FROM orders o')
      ? { rows: [{ ...deliveredOrder, status: 'OUT_FOR_DELIVERY' }], rowCount: 1 }
      : { rows: [], rowCount: 0 }));
    await assert.rejects(service.save(customer, orderId, { businessRating: 4 }), ConflictException);
  });

  it('refuses a driver star for an order nobody delivered', async () => {
    const { service } = harness(async sql => (sql.includes('FROM orders o')
      ? { rows: [{ ...deliveredOrder, driver_id: null }], rowCount: 1 }
      : { rows: [], rowCount: 0 }));
    await assert.rejects(service.save(customer, orderId, { businessRating: 4, driverRating: 5 }), BadRequestException);
  });

  it('will not overwrite another customer’s rating of the same order', async () => {
    const { service } = harness(async sql => {
      if (sql.includes('FROM orders o')) return { rows: [deliveredOrder], rowCount: 1 };
      if (sql.includes('FROM order_feedback WHERE order_id')) return { rows: [{ id: 'f-1', user_id: 'someone-else' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await assert.rejects(service.save(customer, orderId, { businessRating: 4 }), ConflictException);
  });

  it('stores the rating in a transaction and notifies the shop once', async () => {
    const { service, calls } = harness(ok([]));
    const result = await service.save(customer, orderId, { businessRating: 4, driverRating: 5, comment: '  داغ   رسید  ' });
    assert.equal(result.created, true);
    assert.equal(result.comment, 'داغ رسید', 'whitespace is squeezed, not kept verbatim');
    assert.deepEqual(calls.map(call => call.sql).filter(sql => /^(BEGIN|COMMIT)$/.test(sql)), ['BEGIN', 'COMMIT']);
    const insert = calls.find(call => call.sql.includes('INSERT INTO order_feedback'))!;
    assert.match(insert.sql, /ON CONFLICT\(order_id\) DO UPDATE/);
    assert.deepEqual(insert.values, [orderId, customer.sub, deliveredOrder.business_id, deliveredOrder.driver_id, 4, 5, 'داغ رسید']);
    const shopNotice = calls.find(call => call.sql.includes('INSERT INTO notifications'))!;
    assert.equal(shopNotice.values?.[0], 'a0000000-0000-4000-8000-0000000000b1');
    assert.equal(shopNotice.values?.[1], 'ORDER_FEEDBACK');
    const driverNotice = calls.filter(call => call.sql.includes('INSERT INTO notifications'))[1];
    assert.equal(driverNotice?.values?.[1], 'DRIVER_FEEDBACK');
  });

  it('rolls back when the insert fails and does not notify', async () => {
    const { service, calls } = harness(async sql => {
      if (sql.includes('FROM orders o')) return { rows: [deliveredOrder], rowCount: 1 };
      if (sql.includes('SELECT id,user_id FROM order_feedback')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO order_feedback')) throw new Error('db down');
      return { rows: [], rowCount: 0 };
    });
    await assert.rejects(service.save(customer, orderId, { businessRating: 4 }), /db down/);
    assert.deepEqual(calls.map(call => call.sql).filter(sql => /^(BEGIN|ROLLBACK)$/.test(sql)), ['BEGIN', 'ROLLBACK']);
    assert.equal(calls.some(call => call.sql.includes('INSERT INTO notifications')), false, 'a failed rating must not notify anybody');
  });

  it('flags a one-star review as needing attention but stays polite about it', async () => {
    const { service, calls } = harness(ok([]));
    await service.save(customer, orderId, { businessRating: 1 });
    const notice = calls.find(call => call.sql.includes('INSERT INTO notifications'))!;
    assert.equal(notice.values?.[2], 'بازخورد نیازمند توجه');
    assert.equal(JSON.parse(String(notice.values?.[4])).needsAttention, true);
    assert.match(String(notice.values?.[3]), /ستاره/);
  });
});

describe('FeedbackService reads', () => {
  it('shows an order’s feedback only to the people in that order', async () => {
    const { service, calls } = harness(async () => ({ rows: [savedRow], rowCount: 1 }));
    const result = await service.forOrder(customer, orderId);
    assert.equal(result?.businessRating, 4);
    const sql = calls[0].sql;
    assert.match(sql, /o\.customer_id=\$2 OR b\.owner_id=\$2 OR d\.user_id=\$2 OR \$3::boolean/);
    assert.equal(calls[0].values?.[2], false, 'a customer is not staff');
  });

  it('returns null instead of throwing when nothing was written', async () => {
    const { service } = harness(async () => ({ rows: [], rowCount: 0 }));
    assert.equal(await service.forOrder(customer, orderId), null);
  });

  it('requires ownership before a shop reads its own score', async () => {
    const { service, calls } = harness(async sql => (sql.includes('FROM businesses WHERE id') ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 }));
    await assert.rejects(service.forBusiness(customer, 'b0000000-0000-4000-8000-000000000002'), NotFoundException);
    assert.equal(calls.length, 1, 'no report query may run once ownership is unknown');
  });

  it('computes the average from the ratings table and caps the page', async () => {
    const { service, calls } = harness(async sql => {
      if (sql.includes('FROM businesses WHERE id')) return { rows: [{ id: 'b' }], rowCount: 1 };
      if (sql.includes('AVG(business_rating)')) return { rows: [{ feedbackCount: 12, averageBusinessRating: 4.25, averageDriverRating: 4.8, needsAttention: 2 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const report = await service.forBusiness({ sub: 'o', roles: ['BUSINESS_OWNER'] }, 'b0000000-0000-4000-8000-000000000002', '10', '0');
    assert.equal(report.averageBusinessRating, 4.25);
    assert.equal(report.needsAttention, 2);
    assert.equal(report.limit, 10);
    await assert.rejects(service.forBusiness(customer, 'b0000000-0000-4000-8000-000000000002', '500'), BadRequestException);
    assert.equal(calls.filter(call => call.sql.includes('AVG(business_rating)')).length, 1);
  });

  it('gives a driver only their own ratings and requires an active profile', async () => {
    const refused = harness(async sql => (sql.includes('FROM drivers WHERE user_id') ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 }));
    await assert.rejects(refused.service.forDriver({ sub: 'd', roles: ['DRIVER'] }), NotFoundException);
    assert.equal(refused.calls.length, 1);

    const { service, calls } = harness(async sql => {
      if (sql.includes('FROM drivers WHERE user_id')) return { rows: [{ id: 'driver-1' }], rowCount: 1 };
      if (sql.includes('AVG(driver_rating)')) return { rows: [{ feedbackCount: 3, averageDriverRating: 4.7 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const report = await service.forDriver({ sub: 'd', roles: ['DRIVER'] });
    assert.deepEqual({ count: report.feedbackCount, average: report.averageDriverRating }, { count: 3, average: 4.7 });
    assert.match(calls[1].sql, /f\.driver_id=\$1 AND f\.driver_rating IS NOT NULL/, 'the driver list must not mix in business-only ratings');
  });

  it('filters the staff queue by star ceiling and search terms as parameters', async () => {
    const { service, calls } = harness(async sql => (sql.includes('COUNT(*)::int AS "totalMatches"')
      ? { rows: [{ totalMatches: 0 }], rowCount: 1 }
      : { rows: [], rowCount: 0 }));
    await service.listForStaff({ maxStars: '2', limit: '50', offset: '10' });
    const list = calls[0];
    assert.match(list.sql, /f\.business_rating <= \$1/);
    assert.deepEqual(list.values, [2, 50, 10]);
    await assert.rejects(service.listForStaff({ maxStars: '9' }), BadRequestException);
    await assert.rejects(service.listForStaff({ businessId: 'whatever' }), BadRequestException);
  });

  it('demands a reason before deleting feedback and audits the removal', async () => {
    const noReason = harness(async sql => (sql.startsWith('DELETE') ? { rows: [{ id: 'f-1', order_id: orderId, business_rating: 1, business_id: 'b' }], rowCount: 1 } : { rows: [], rowCount: 0 }));
    await assert.rejects(noReason.service.remove({ sub: 'admin', roles: ['SUPER_ADMIN'] }, 'a0000000-0000-4000-8000-0000000000a1', '   '), BadRequestException);
    assert.equal(noReason.calls.length, 0, 'a removal without a reason must not reach SQL at all');

    const { service, calls } = harness(async sql => (sql.startsWith('DELETE') ? { rows: [{ id: 'f-1', order_id: orderId, business_rating: 1, business_id: 'b' }], rowCount: 1 } : { rows: [], rowCount: 0 }));
    const result = await service.remove({ sub: 'a0000000-0000-4000-8000-0000000000a1', roles: ['OPERATIONS_MANAGER'] }, 'a0000000-0000-4000-8000-0000000000a1', 'توهین آشکار');
    assert.deepEqual(result, { id: 'a0000000-0000-4000-8000-0000000000a1', removed: true });
    const audit = calls.find(call => call.sql.includes("'FEEDBACK_REMOVED'"))!;
    assert.deepEqual(JSON.parse(String(audit.values?.[2])), { reason: 'توهین آشکار', removedBy: 'OPERATIONS_MANAGER' });
  });

  it('reports not found when the row was already gone', async () => {
    const { service } = harness(async () => ({ rows: [], rowCount: 0 }));
    await assert.rejects(service.remove({ sub: 'a0000000-0000-4000-8000-0000000000a1', roles: ['SUPER_ADMIN'] }, 'a0000000-0000-4000-8000-0000000000a1', 'تکراری'), NotFoundException);
  });
});

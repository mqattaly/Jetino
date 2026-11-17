import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';

function service(connect: () => void) {
  return new OrdersService({ connect: () => { connect(); throw new Error('database should not be reached'); } } as never);
}

function transactionalService(onQuery: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>) {
  const client = { query: onQuery, release() {} };
  return new OrdersService({ connect: async () => client } as never);
}

describe('OrdersService preparation estimate validation', () => {
  it('persists the selected estimate and customer notification in the status transaction', async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const orderId = '123e4567-e89b-12d3-a456-426614174000';
    const service = transactionalService(async (sql, values) => {
      statements.push({ sql, values });
      if (sql.startsWith('SELECT o.id,o.status')) return { rows: [{ id: orderId, status: 'PENDING_BUSINESS', customer_id: 'customer-1', owner_id: 'owner-1' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const result = await service.businessTransition({ sub: 'owner-1' }, orderId, 'CONFIRMED', 45);
    assert.equal(result.estimatedPrepMinutes, 45);
    const update = statements.find((entry) => entry.sql.startsWith('UPDATE orders'))!;
    assert.match(update.sql, /estimated_prep_minutes=COALESCE\(\$3,estimated_prep_minutes\)/);
    assert.deepEqual(update.values, [orderId, 'CONFIRMED', 45]);
    const notice = statements.find((entry) => entry.sql.startsWith('INSERT INTO notifications'))!;
    assert.match(String(notice.values?.[3]), /45 دقیقه/);
    assert.deepEqual(JSON.parse(String(notice.values?.[4])), { orderId, status: 'CONFIRMED', preparationMinutes: 45 });
    assert.equal(statements.at(-1)?.sql, 'COMMIT');
  });

  it('rejects preparation estimates below five minutes before opening a transaction', async () => {
    let connected = false;
    await assert.rejects(
      service(() => { connected = true; }).businessTransition({ sub: 'owner-1' }, '123e4567-e89b-12d3-a456-426614174000', 'CONFIRMED', 4),
      BadRequestException,
    );
    assert.equal(connected, false);
  });

  it('rejects non-integer preparation estimates before opening a transaction', async () => {
    let connected = false;
    await assert.rejects(
      service(() => { connected = true; }).businessTransition({ sub: 'owner-1' }, '123e4567-e89b-12d3-a456-426614174000', 'CONFIRMED', 12.5),
      BadRequestException,
    );
    assert.equal(connected, false);
  });

  it('rejects preparation estimates above four hours before opening a transaction', async () => {
    let connected = false;
    await assert.rejects(
      service(() => { connected = true; }).businessTransition({ sub: 'owner-1' }, '123e4567-e89b-12d3-a456-426614174000', 'CONFIRMED', 241),
      BadRequestException,
    );
    assert.equal(connected, false);
  });
});

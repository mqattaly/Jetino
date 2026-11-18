import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DriversService } from './drivers.service';

const orderId = '123e4567-e89b-12d3-a456-426614174010';
const driverUserId = 'driver-1';

function serviceWithRows(rows: Record<string, unknown> | null) {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql.startsWith('SELECT o.id,o.status,o.payment_method')) {
        return rows ? { rows: [rows], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('SELECT o.id,o.status,o.customer_id')) {
        return rows ? { rows: [rows], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO cash_collections')) {
        return { rows: [{ amount_rial: '2500', collected_at: new Date('2026-11-17T11:00:00Z') }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT amount_rial,collected_at')) {
        return { rows: [{ amount_rial: '2500', collected_at: new Date('2026-11-17T11:00:00Z') }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { service: new DriversService({ connect: async () => client } as never), statements };
}

describe('DriversService cash collection on delivery', () => {
  it('refuses to record payment before the order is marked delivered', async () => {
    const { service, statements } = serviceWithRows({
      id: orderId, status: 'OUT_FOR_DELIVERY', payment_method: 'CASH', payment_status: 'PENDING', total_rial: '2500', customer_id: 'customer-1', user_id: driverUserId,
    });
    await assert.rejects(service.collectCash({ sub: driverUserId }, orderId, true), ConflictException);
    assert.ok(statements.some(entry => entry.sql === 'ROLLBACK'));
    assert.ok(!statements.some(entry => entry.sql.includes('INSERT INTO cash_collections')));
    assert.ok(!statements.some(entry => entry.sql.includes("payment_status='PAID'")));
  });

  it('requires explicit confirmation and never reaches the database', async () => {
    let connected = false;
    const service = new DriversService({ connect: async () => { connected = true; throw new Error('unreachable'); } } as never);
    await assert.rejects(service.collectCash({ sub: driverUserId }, orderId, 'true'), BadRequestException);
    assert.equal(connected, false);
  });

  it('records the amount, marks the order paid and notifies the customer atomically', async () => {
    const { service, statements } = serviceWithRows({
      id: orderId, status: 'DELIVERED', payment_method: 'CASH', payment_status: 'PENDING', total_rial: '2500', customer_id: 'customer-1', user_id: driverUserId,
    });
    const result = await service.collectCash({ sub: driverUserId }, orderId, true);
    assert.equal(result.alreadyCollected, false);
    assert.equal(result.amountRial, '2500');
    assert.equal(statements[0].sql, 'BEGIN');
    assert.ok(statements.some(entry => entry.sql.startsWith('INSERT INTO cash_collections') && entry.values?.[1] === '2500'));
    assert.ok(statements.some(entry => entry.sql.includes("payment_status='PAID'") && entry.values?.[0] === orderId));
    const notice = statements.find(entry => entry.sql.startsWith('INSERT INTO notifications'))!;
    assert.equal(notice.values?.[0], 'customer-1');
    assert.equal(notice.values?.[1], 'CASH_PAYMENT_CONFIRMED');
    assert.equal(JSON.parse(String(notice.values?.[4])).amountRial, '2500');
    assert.ok(statements.some(entry => entry.sql.includes('CASH_PAYMENT_COLLECTED')));
    assert.equal(statements.at(-1)?.sql, 'COMMIT');
  });

  it('is idempotent when the payment was already collected and writes nothing new', async () => {
    const { service, statements } = serviceWithRows({
      id: orderId, status: 'DELIVERED', payment_method: 'CASH', payment_status: 'PAID', total_rial: '2500', customer_id: 'customer-1', user_id: driverUserId,
    });
    const result = await service.collectCash({ sub: driverUserId }, orderId, true);
    assert.equal(result.alreadyCollected, true);
    assert.equal(result.amountRial, '2500');
    assert.ok(!statements.some(entry => entry.sql.includes('INSERT INTO cash_collections')));
    assert.ok(!statements.some(entry => entry.sql.includes('INSERT INTO notifications')));
    assert.equal(statements.at(-1)?.sql, 'COMMIT');
  });

  it('hides assignments belonging to another driver without exposing the order', async () => {
    const { service, statements } = serviceWithRows({
      id: orderId, status: 'DELIVERED', payment_method: 'CASH', payment_status: 'PENDING', total_rial: '2500', customer_id: 'customer-1', user_id: 'someone-else',
    });
    await assert.rejects(service.collectCash({ sub: driverUserId }, orderId, true), NotFoundException);
    assert.ok(!statements.some(entry => entry.sql.includes('UPDATE orders')));
    assert.ok(!statements.some(entry => entry.sql.includes('INSERT INTO cash_collections')));
  });
});

describe('DriversService cash wallet', () => {
  it('separates money still held by the driver from settled amounts',async()=>{
    const calls:Array<{sql:string;values?:unknown[]}>=[];
    const pool={query:async(sql:string,values?:unknown[])=>{
      calls.push({sql,values});
      if(sql.startsWith('SELECT id FROM drivers'))return{rows:[{id:'driver-9'}],rowCount:1};
      return{rows:[{openCashRial:'7500',openCount:3,settledTotalRial:'25000',settledCount:2,lastSettledAt:new Date('2026-11-16T09:00:00Z')}],rowCount:1};
    }};
    const summary=await new DriversService(pool as never).cashSummary({sub:driverUserId});
    assert.equal(summary.openCashRial,'7500');
    assert.equal(summary.openCount,3);
    assert.equal(summary.settledTotalRial,'25000');
    assert.equal(summary.lastSettledAt instanceof Date,true);
    const aggregate=calls[1];
    assert.match(aggregate.sql,/FROM cash_collections WHERE collected_by=d\.user_id AND settlement_id IS NULL/);
    assert.match(aggregate.sql,/FROM cash_settlements WHERE driver_id=d\.id/);
    assert.deepEqual(aggregate.values,['driver-9']);
  });

  it('refuses a wallet view for an account without an active driver profile',async()=>{
    const queries:string[]=[];
    const service=new DriversService({query:async(sql:string)=>{queries.push(sql);return{rows:[],rowCount:0};},connect:async()=>{throw new Error('unreachable');}} as never);
    await assert.rejects(service.cashSummary({sub:driverUserId}),ForbiddenException);
    assert.deepEqual(queries,[`SELECT id FROM drivers WHERE user_id=$1 AND status='ACTIVE'`]);
  });
});

describe('DriversService delivery transitions', () => {
  it('only allows the assigned driver to move the order forward one step', async () => {
    const { service, statements } = serviceWithRows({
      id: orderId, status: 'DRIVER_ASSIGNED', customer_id: 'customer-1', driver_id: 'driver-9', user_id: driverUserId,
    });
    assert.deepEqual(await service.transition({ sub: driverUserId }, orderId, 'OUT_FOR_DELIVERY'), { id: orderId, fromStatus: 'DRIVER_ASSIGNED', status: 'OUT_FOR_DELIVERY' });
    assert.ok(statements.some(entry => entry.sql.startsWith('UPDATE orders SET status=$2') && entry.values?.[1] === 'OUT_FOR_DELIVERY'));
    assert.ok(statements.some(entry => entry.sql.startsWith('INSERT INTO order_status_history')));
    const notice = statements.find(entry => entry.sql.startsWith('INSERT INTO notifications'))!;
    assert.equal(notice.values?.[1], 'ORDER_OUT_FOR_DELIVERY');
    assert.equal(statements.at(-1)?.sql, 'COMMIT');
  });

  it('rejects a skipped transition and rolls the transaction back', async () => {
    const { service, statements } = serviceWithRows({
      id: orderId, status: 'DRIVER_ASSIGNED', customer_id: 'customer-1', driver_id: 'driver-9', user_id: driverUserId,
    });
    await assert.rejects(service.transition({ sub: driverUserId }, orderId, 'DELIVERED'), ConflictException);
    assert.ok(!statements.some(entry => entry.sql.startsWith('UPDATE orders')));
    assert.ok(statements.some(entry => entry.sql === 'ROLLBACK'));
  });

  it('rejects unsupported target statuses and malformed order ids before opening a transaction', async () => {
    let connected = false;
    const service = new DriversService({ connect: async () => { connected = true; throw new Error('unreachable'); } } as never);
    await assert.rejects(service.transition({ sub: driverUserId }, orderId, 'CANCELLED'), BadRequestException);
    await assert.rejects(service.transition({ sub: driverUserId }, 'not-a-uuid', 'DELIVERED'), BadRequestException);
    assert.equal(connected, false);
  });

  it('reports not found when the order is not assigned to the caller', async () => {
    const { service } = serviceWithRows(null);
    await assert.rejects(service.transition({ sub: driverUserId }, orderId, 'DELIVERED'), NotFoundException);
  });

  it('rejects a driver whose account is not active before querying assignments', async () => {
    const statements: string[] = [];
    const pool = {
      connect: async () => { throw new Error('should not connect'); },
      query: async (sql: string) => { statements.push(sql); return { rows: [], rowCount: 0 }; },
    };
    const service = new DriversService(pool as never);
    await assert.rejects(service.deliveries({ sub: driverUserId }), /should not connect|حساب راننده/);
    assert.match(statements[0], /FROM drivers WHERE user_id=\$1 AND status='ACTIVE'/);
  });
});

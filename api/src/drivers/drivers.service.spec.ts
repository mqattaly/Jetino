import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DriversService } from './drivers.service';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const orderId = '123e4567-e89b-12d3-a456-426614174010';
const noLimit = { enforce: async () => undefined } as never;
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
  const rateLimit = { enforce: async () => undefined };
  return { service: new DriversService({ connect: async () => client } as never, rateLimit as never), statements };
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
    const service = new DriversService({ connect: async () => { connected = true; throw new Error('unreachable'); } } as never, noLimit);
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
    const summary=await new DriversService(pool as never, noLimit).cashSummary({sub:driverUserId});
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
    const service=new DriversService({query:async(sql:string)=>{queries.push(sql);return{rows:[],rowCount:0};},connect:async()=>{throw new Error('unreachable');}} as never, noLimit);
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
    const service = new DriversService({ connect: async () => { connected = true; throw new Error('unreachable'); } } as never, noLimit);
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
    const service = new DriversService(pool as never, noLimit);
    await assert.rejects(service.deliveries({ sub: driverUserId }), /should not connect|حساب راننده/);
    assert.match(statements[0], /FROM drivers WHERE user_id=\$1 AND status='ACTIVE'/);
  });
});

describe('DriversService door-check profile', () => {
  const identity = { id: 'driver-9', fullName: 'رضا پیک', plateNumber: '12ب34567', vehicleType: 'MOTORCYCLE', photoUrl: PNG };
  const poolWith = (overrides: { profileRow?: Record<string, unknown>; failUpdate?: boolean } = {}) => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        statements.push({ sql, values });
        if (sql.startsWith('SELECT id FROM drivers')) return { rows: [{ id: 'driver-9' }], rowCount: 1 };
        if (sql.startsWith('UPDATE drivers SET')) {
          if (overrides.failUpdate) throw Object.assign(new Error('duplicate key'), { code: '23505' });
          return { rows: [{ ...identity, plateNumber: '12ب34567' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    const profileRow = overrides.profileRow ?? { ...identity, status: 'ACTIVE', regionId: 'r1', regionName: 'بندرخمیر', phone: '09120000003' };
    const pool = {
      connect: async () => client,
      query: async (sql: string, values?: unknown[]) => { statements.push({ sql, values }); return { rows: [profileRow], rowCount: 1 }; },
    };
    return { service: new DriversService(pool as never, noLimit), statements };
  };

  it('reports what is still missing before the courier can take a mission', async () => {
    const missingName = poolWith({ profileRow: { id: 'driver-9', fullName: null, plateNumber: '12ب34567', vehicleType: 'CAR', photoUrl: PNG } });
    const profile = await missingName.service.profile({ sub: 'driver-user' });
    assert.equal(profile.complete, false);
    assert.deepEqual(profile.missing, ['fullName']);
    assert.equal((await poolWith().service.profile({ sub: 'driver-user' })).complete, true);
  });

  it('stores a normalised plate and audits only the fields that changed', async () => {
    const { service, statements } = poolWith();
    const saved = await service.saveProfile({ sub: 'driver-user' }, { fullName: 'رضا پیک', vehicleType: 'MOTORCYCLE', plateNumber: '۱۲ ب ۳۴۵۶۷', photoUrl: PNG });
    assert.equal(saved.plateNumber, '12ب34567');
    assert.equal(saved.complete, true);
    const update = statements.find(entry => entry.sql.startsWith('UPDATE drivers SET'))!;
    assert.equal(update.values?.[3], '12ب34567');
    const audit = statements.find(entry => entry.sql.includes('DRIVER_PROFILE_UPDATED'))!;
    assert.match(String(audit.values?.[2]), /plateNumber/);
    assert.equal(statements.at(-1)?.sql, 'COMMIT');
  });

  it('saves one field at a time, refuses a bad plate and reports a plate owned by someone else', async () => {
    const { service, statements } = poolWith();
    assert.equal((await service.saveProfile({ sub: 'driver-user' }, { plateNumber: '12ب34567', photoUrl: PNG })).plateNumber, '12ب34567', 'a partial save is allowed; the assignment gate enforces completeness');
    assert.ok(statements.some(entry => entry.sql === 'COMMIT'));
    const guarded = poolWith();
    guarded.statements.length = 0;
    await assert.rejects(guarded.service.saveProfile({ sub: 'driver-user' }, { plateNumber: '12x345', photoUrl: PNG }), BadRequestException, 'a malformed plate is refused before connecting');
    assert.equal(guarded.statements.length, 0, 'nothing reached the database');
    await assert.rejects(guarded.service.saveProfile({ sub: 'driver-user' }, {}), BadRequestException, 'an empty edit is refused');
    await assert.rejects(poolWith({ failUpdate: true }).service.saveProfile({ sub: 'driver-user' }, { plateNumber: '12ب34567', photoUrl: PNG }), /پلاک/);
  });
});

describe('DriversService handover code on delivery', () => {
  const orderRow = (extra: Record<string, unknown>) => ({
    id: orderId, status: 'OUT_FOR_DELIVERY', customer_id: 'customer-1', driver_id: 'driver-9', user_id: driverUserId,
    delivery_code_hash: null, delivery_code_attempts: 0, delivery_code_locked_at: null, ...extra,
  });

  it('delivers without a code on orders that predate the handover code', async () => {
    const { service } = serviceWithRows(orderRow({}));
    assert.deepEqual(await service.transition({ sub: driverUserId }, orderId, 'DELIVERED'), { id: orderId, fromStatus: 'OUT_FOR_DELIVERY', status: 'DELIVERED' });
  });

  it('accepts the code the customer reads and records the verified handover', async () => {
    process.env.JWT_SECRET = 'unit-test-secret-for-handover-codes';
    const { hashDeliveryCode } = await import('../security/security.util');
    const { service, statements } = serviceWithRows(orderRow({ delivery_code_hash: hashDeliveryCode(orderId, '4321') }));
    assert.equal((await service.transition({ sub: driverUserId }, orderId, 'DELIVERED', ' ۴۳۲۱ ')).status, 'DELIVERED');
    const update = statements.find(entry => entry.sql.startsWith('UPDATE orders SET status=$2'))!;
    assert.equal(update.values?.[1], 'DELIVERED');
    const audit = statements.find(entry => entry.sql.includes('DRIVER_ORDER_STATUS_CHANGED'))!;
    assert.match(String(audit.values?.[2]), /"codeVerified":true/);
  });

  it('stores a failed attempt, keeps the order undelivered and locks after five tries', async () => {
    process.env.JWT_SECRET = 'unit-test-secret-for-handover-codes';
    const { hashDeliveryCode, MAX_DELIVERY_CODE_ATTEMPTS } = await import('../security/security.util');
    const hash = hashDeliveryCode(orderId, '4321');
    const { service, statements } = serviceWithRows(orderRow({ delivery_code_hash: hash, delivery_code_attempts: MAX_DELIVERY_CODE_ATTEMPTS - 1 }));
    await assert.rejects(service.transition({ sub: driverUserId }, orderId, 'DELIVERED', '1111'), /قفل/);
    const attempts = statements.find(entry => entry.sql.includes('delivery_code_attempts=$2'))!;
    assert.equal(attempts.values?.[1], MAX_DELIVERY_CODE_ATTEMPTS);
    assert.equal(attempts.values?.[2], true, 'the last allowed failure locks the code');
    assert.equal(statements.at(-1)?.sql, 'COMMIT', 'the attempt survives so the next try is still counted');
    assert.ok(statements.some(entry => entry.sql.includes('DELIVERY_CODE_REJECTED')));
    assert.ok(statements.some(entry => entry.sql.startsWith('INSERT INTO notifications') && entry.values?.[1] === 'DELIVERY_CODE_LOCKED'), 'the customer is warned');
    assert.ok(!statements.some(entry => entry.sql.includes("status=$2") && entry.values?.[1] === 'DELIVERED'));
  });

  it('refuses to try a code that is already locked', async () => {
    process.env.JWT_SECRET = 'unit-test-secret-for-handover-codes';
    const { hashDeliveryCode } = await import('../security/security.util');
    const { service } = serviceWithRows(orderRow({ delivery_code_hash: hashDeliveryCode(orderId, '4321'), delivery_code_locked_at: new Date() }));
    await assert.rejects(service.transition({ sub: driverUserId }, orderId, 'DELIVERED', '4321'), ConflictException);
  });
});

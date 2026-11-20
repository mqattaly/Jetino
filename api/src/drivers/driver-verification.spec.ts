import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DriversService } from './drivers.service';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const driverUserId = '423e4567-e89b-12d3-a456-426614174010';
const missionA = '523e4567-e89b-12d3-a456-426614174010';
const missionB = '623e4567-e89b-12d3-a456-426614174010';
const noLimit = { enforce: async () => undefined } as never;
const ug = { enforce: async () => undefined } as never;

function verificationService(status: string, submitted = true) {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql.startsWith('SELECT id,verification_status')) return submitted ? { rows: [{ id: 'd1', verification_status: status }], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (sql.startsWith('SELECT DISTINCT ur.user_id')) return { rows: [{ user_id: 'staff-1' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { service: new DriversService({ connect: async () => client } as never, ug), statements };
}

describe('DriversService document verification', () => {
  it('requires both the ID card and the selfie, and never opens a transaction without them', async () => {
    let connected = false;
    const service = new DriversService({ connect: async () => { connected = true; throw new Error('unreachable'); } } as never, noLimit);
    await assert.rejects(service.submitVerification({ sub: driverUserId }, { selfieUrl: PNG }), BadRequestException);
    await assert.rejects(service.submitVerification({ sub: driverUserId }, { idCardUrl: 'javascript:alert(1)', selfieUrl: PNG }), BadRequestException);
    assert.equal(connected, false);
  });

  it('moves a fresh submission to PENDING and tells operations', async () => {
    const { service, statements } = verificationService('UNVERIFIED');
    const result = await service.submitVerification({ sub: driverUserId }, { idCardUrl: PNG, selfieUrl: PNG });
    assert.equal(result.status, 'PENDING');
    assert.ok(statements.some(entry => entry.sql.includes("verification_status='PENDING'")));
    const history = statements.find(entry => entry.sql.includes('driver_verification_history'));
    assert.match(history!.sql, /VALUES\(\$1,'PENDING'/);
    assert.deepEqual(history!.values, ['d1', driverUserId]);
    const staffNotice = statements.find(entry => entry.sql.includes('INSERT INTO notifications') && (entry.values as unknown[])[0] === 'staff-1');
    assert.ok(staffNotice);
    assert.deepEqual(statements.at(-1)!.sql, 'COMMIT');
  });

  it('refuses to resubmit while a review is open or after approval', async () => {
    await assert.rejects(verificationService('PENDING').service.submitVerification({ sub: driverUserId }, { idCardUrl: PNG, selfieUrl: PNG }), ConflictException);
    await assert.rejects(verificationService('APPROVED').service.submitVerification({ sub: driverUserId }, { idCardUrl: PNG, selfieUrl: PNG }), ConflictException);
  });

  it('answers 404 when the caller has no courier profile', async () => {
    await assert.rejects(verificationService('UNVERIFIED', false).service.submitVerification({ sub: driverUserId }, { idCardUrl: PNG, selfieUrl: PNG }), NotFoundException);
  });
});

function locationService(options: { driver?: boolean; activeOrders?: string[]; failLimit?: boolean }) {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql.startsWith('SELECT id FROM drivers')) return options.driver === false ? { rows: [], rowCount: 0 } : { rows: [{ id: 'd1' }], rowCount: 1 };
      if (sql.includes('delivery_assignments da JOIN orders')) return { rows: (options.activeOrders ?? []).map(id => ({ id })), rowCount: (options.activeOrders ?? []).length };
      if (sql.includes('INSERT INTO driver_locations')) return { rows: [{ updated_at: new Date('2026-11-17T10:00:00Z') }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    connect: async () => { throw new Error('unreachable'); },
  };
  const rateLimit = options.failLimit ? { enforce: async () => { throw new ConflictException('too fast'); } } : ug;
  return { service: new DriversService(pool as never, rateLimit as never), statements };
}

describe('DriversService location sharing', () => {
  it('validates the coordinates before any query', async () => {
    const { service, statements } = locationService({ activeOrders: [missionA] });
    await assert.rejects(service.shareLocation({ sub: driverUserId }, { latitude: 120, longitude: 55 }), BadRequestException);
    await assert.rejects(service.shareLocation({ sub: driverUserId }, { latitude: 26.9, longitude: 220 }), BadRequestException);
    await assert.rejects(service.shareLocation({ sub: driverUserId }, { latitude: 26.9, longitude: 55.5, accuracy: 9000 }), BadRequestException);
    assert.equal(statements.length, 0);
  });

  it('shares only during a running mission', async () => {
    const idle = locationService({ activeOrders: [] });
    await assert.rejects(idle.service.shareLocation({ sub: driverUserId }, { latitude: 26.9, longitude: 55.5 }), ConflictException);
    assert.ok(!idle.statements.some(entry => entry.sql.includes('INSERT INTO driver_locations')));
  });

  it('upserts one row per courier and mirrors the active order ids', async () => {
    const { service, statements } = locationService({ activeOrders: [missionA, missionB] });
    const result = await service.shareLocation({ sub: driverUserId }, { orderId: missionA, latitude: 26.9, longitude: 55.5, accuracy: 8.4 });
    assert.equal(result.shared, true);
    assert.deepEqual(result.activeOrderIds, [missionA, missionB]);
    const upsert = statements.find(entry => entry.sql.includes('INSERT INTO driver_locations'));
    assert.ok(upsert!.sql.includes('ON CONFLICT (driver_id) DO UPDATE'));
    assert.deepEqual((upsert!.values as unknown[]).slice(1), [26.9, 55.5, 8]);
  });

  it('refuses an order id that is not this courier’s mission', async () => {
    const { service } = locationService({ activeOrders: [missionA] });
    await assert.rejects(service.shareLocation({ sub: driverUserId }, { orderId: missionB, latitude: 26.9, longitude: 55.5 }), NotFoundException);
  });

  it('deletes the row when sharing is switched off', async () => {
    const { service, statements } = locationService({ activeOrders: [missionA] });
    assert.deepEqual(await service.clearLocation({ sub: driverUserId }), { shared: false });
    assert.ok(statements.some(entry => entry.sql === 'DELETE FROM driver_locations WHERE driver_id=$1'));
  });
});

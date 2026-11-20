import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SafetyService } from './safety.service';

const user = { sub: '723e4567-e89b-12d3-a456-426614174010', roles: ['CUSTOMER'] };
const orderId = '823e4567-e89b-12d3-a456-426614174010';
const eventId = '923e4567-e89b-12d3-a456-426614174010';
const staff = { id: 'a23e4567-e89b-12d3-a456-426614174010', roles: ['SUPPORT'] };
const noLimit = { enforce: async () => undefined } as never;

function safetyService(options: { party?: boolean; duplicate?: boolean; current?: { status: string; raised_by: string } | null } = {}) {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql.includes('FROM orders o JOIN businesses b')) {
        return options.party === false
          ? { rows: [], rowCount: 0 }
          : { rows: [{ customer_id: user.sub, owner_id: 'owner-1', driver_user_id: 'driver-1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    connect: async () => ({
      query: async (sql: string, values?: unknown[]) => {
        statements.push({ sql, values });
        if (sql.startsWith('INSERT INTO safety_events')) {
          if (options.duplicate) throw Object.assign(new Error('duplicate key'), { code: '23505' });
          return { rows: [{ id: eventId, status: 'OPEN', created_at: new Date('2026-11-17T10:00:00Z') }], rowCount: 1 };
        }
        if (sql.startsWith('SELECT DISTINCT ur.user_id')) return { rows: [{ user_id: staff.id }], rowCount: 1 };
        if (sql.startsWith('SELECT id,status,raised_by')) return options.current ? { rows: [options.current], rowCount: 1 } : { rows: [], rowCount: 0 };
        if (sql.startsWith('UPDATE safety_events')) return { rows: [{ id: eventId, status: values?.[1], resolution: values?.[2], handledAt: new Date() }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      release() {},
    }),
  };
  return { service: new SafetyService(pool as never, noLimit), statements };
}

describe('SafetyService emergency button', () => {
  it('needs an order and a known category before anything is written', async () => {
    const { service, statements } = safetyService();
    await assert.rejects(service.raise(user, {}), BadRequestException);
    await assert.rejects(safetyService().service.raise(user, { orderId, category: 'PIZZA' }), BadRequestException);
    await assert.rejects(safetyService().service.raise(user, { orderId, note: 'x'.repeat(501) }), BadRequestException);
    assert.equal(statements.length, 0);
  });

  it('answers 404 for an order that does not belong to the caller', async () => {
    await assert.rejects(safetyService({ party: false }).service.raise(user, { orderId, category: 'UNSAFE' }), NotFoundException);
  });

  it('opens one queue entry, notifies every staff member and audits the actor', async () => {
    const { service, statements } = safetyService();
    const result = await service.raise(user, { orderId, category: 'HARASSMENT', note: 'پیک تهدید کرد' });
    assert.equal(result.status, 'OPEN');
    assert.equal(result.reference, eventId.slice(0, 8).toUpperCase());
    assert.match(result.message, /۱۱۰/);
    assert.ok(statements.some(entry => entry.sql.startsWith('INSERT INTO safety_events') && (entry.values as unknown[])[4] === 'پیک تهدید کرد'));
    assert.ok(statements.some(entry => entry.sql.includes('INSERT INTO notifications') && (entry.values as unknown[])[0] === staff.id));
    assert.ok(statements.some(entry => entry.sql.includes("'SOS_RAISED'")));
    assert.equal(statements.at(-1)!.sql, 'COMMIT');
  });

  it('refuses a second open alarm for the same order and rolls back', async () => {
    const { service, statements } = safetyService({ duplicate: true });
    await assert.rejects(service.raise(user, { orderId, category: 'OTHER' }), ConflictException);
    assert.ok(statements.some(entry => entry.sql === 'ROLLBACK'));
    assert.ok(!statements.some(entry => entry.sql === 'COMMIT'));
  });
});

describe('SafetyService operations queue', () => {
  it('forces a written resolution before closing', async () => {
    const { service } = safetyService({ current: { status: 'ACKNOWLEDGED', raised_by: user.sub } });
    await assert.rejects(service.handle(staff.id, eventId, { status: 'RESOLVED' }), BadRequestException);
    await assert.rejects(service.handle(staff.id, eventId, { status: 'CLOSED' }), BadRequestException);
  });

  it('moves OPEN to ACKNOWLEDGED and notifies the person who raised it', async () => {
    const { service, statements } = safetyService({ current: { status: 'OPEN', raised_by: user.sub } });
    const result = await service.handle(staff.id, eventId, { status: 'ACKNOWLEDGED' });
    assert.equal(result.status, 'ACKNOWLEDGED');
    assert.ok(statements.some(entry => entry.sql === 'UPDATE safety_events SET status=$2,resolution=COALESCE(NULLIF($3,\'\'),resolution),handled_by=$4,handled_at=now() WHERE id=$1 RETURNING id,status,resolution,handled_at AS "handledAt"'));
    assert.ok(statements.some(entry => entry.sql.includes('INSERT INTO notifications') && (entry.values as unknown[])[0] === user.sub));
    assert.ok(statements.some(entry => entry.sql.includes("'SOS_HANDLED'")));
  });

  it('refuses to handle a closed report twice', async () => {
    await assert.rejects(safetyService({ current: { status: 'RESOLVED', raised_by: user.sub } }).service.handle(staff.id, eventId, { status: 'ACKNOWLEDGED' }), ConflictException);
    await assert.rejects(safetyService({ current: null }).service.handle(staff.id, eventId, { status: 'RESOLVED', resolution: 'تماس گرفته شد' }), NotFoundException);
  });
});

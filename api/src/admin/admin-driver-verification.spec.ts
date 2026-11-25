import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdminDriversService } from './admin-drivers.service';

const driverId = 'b23e4567-e89b-12d3-a456-426614174010';
const driverUserId = 'c23e4567-e89b-12d3-a456-426614174010';
const actor = 'd23e4567-e89b-12d3-a456-426614174010';

function adminService(options: { status?: string; docs?: boolean; exists?: boolean } = {}) {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql.startsWith('SELECT id,user_id,verification_status')) {
        if (options.exists === false) return { rows: [], rowCount: 0 };
        return { rows: [{ id: driverId, user_id: driverUserId, verification_status: options.status ?? 'PENDING', id_card_url: options.docs === false ? null : 'data:image/png;base64,x', selfie_url: options.docs === false ? null : 'data:image/png;base64,y' }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE drivers SET verification_status')) {
        return { rows: [{ id: driverId, status: values?.[1], note: values?.[2], verifiedAt: values?.[1] === 'APPROVED' ? new Date('2026-11-17T10:00:00Z') : null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { service: new AdminDriversService({ query: async () => ({ rows: [], rowCount: 0 }), connect: async () => client } as never), statements };
}

describe('AdminDriversService review of courier documents', () => {
  it('will not approve without an explicit selfie match', async () => {
    let connected = false;
    const service = new AdminDriversService({ connect: async () => { connected = true; throw new Error('unreachable'); } } as never);
    await assert.rejects(service.decideVerification(actor, driverId, { status: 'APPROVED' }), BadRequestException);
    await assert.rejects(service.decideVerification(actor, driverId, { status: 'APPROVED', selfieMatch: false }), BadRequestException);
    assert.equal(connected, false);
  });

  it('requires a written reason when documents are rejected', async () => {
    const { service, statements } = adminService();
    await assert.rejects(service.decideVerification(actor, driverId, { status: 'REJECTED', note: ' ' }), BadRequestException);
    assert.equal(statements.length, 0);
  });

  it('approves a pending submission, records the selfie match and tells the courier', async () => {
    const { service, statements } = adminService();
    const result = await service.decideVerification(actor, driverId, { status: 'APPROVED', selfieMatch: true, note: 'کارت ملی و سلفی مطابقت دارد' });
    assert.equal(result.status, 'APPROVED');
    const history = statements.find(entry => entry.sql.includes('driver_verification_history'));
    assert.deepEqual(history!.values, [driverId, 'APPROVED', 'کارت ملی و سلفی مطابقت دارد', true, actor]);
    const audit = statements.find(entry => entry.sql.includes('INSERT INTO audit_logs'));
    assert.equal((audit!.values as unknown[])[1], 'DRIVER_VERIFICATION_APPROVED');
    assert.ok(statements.some(entry => entry.sql.includes('INSERT INTO notifications') && (entry.values as unknown[])[0] === driverUserId));
    assert.equal(statements.at(-1)!.sql, 'COMMIT');
  });

  it('rejects with a reason the courier can act on', async () => {
    const { service, statements } = adminService();
    const result = await service.decideVerification(actor, driverId, { status: 'REJECTED', note: 'عکس سلفی تار است' });
    assert.equal(result.status, 'REJECTED');
    const audit = statements.find(entry => entry.sql.includes('INSERT INTO audit_logs'));
    assert.equal((audit!.values as unknown[])[1], 'DRIVER_VERIFICATION_REJECTED');
    const notice = statements.find(entry => entry.sql.includes('INSERT INTO notifications'));
    assert.match(String((notice!.values as unknown[])[3]), /عکس سلفی تار است/);
  });

  it('refuses to review a driver with nothing in the queue or with missing documents', async () => {
    await assert.rejects(adminService({ status: 'APPROVED' }).service.decideVerification(actor, driverId, { status: 'APPROVED', selfieMatch: true }), ConflictException);
    await assert.rejects(adminService({ status: 'PENDING', docs: false }).service.decideVerification(actor, driverId, { status: 'APPROVED', selfieMatch: true }), ConflictException);
    await assert.rejects(adminService({ exists: false }).service.decideVerification(actor, driverId, { status: 'APPROVED', selfieMatch: true }), NotFoundException);
  });
});

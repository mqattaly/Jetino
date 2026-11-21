import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadGatewayException, BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { DriverIdentityService } from './driver-identity.service';
import type { ZohalService } from './zohal.service';

const driverUserId = 'c23e4567-e89b-12d3-a456-426614174010';
const driverRowId = 'b23e4567-e89b-12d3-a456-426614174010';

type Row = Record<string, unknown>;

function baseRow(overrides: Row = {}): Row {
  return {
    id: driverRowId, user_id: driverUserId, status: 'ACTIVE',
    national_code: null, birth_date: null, national_card_serial: null, gender: null,
    shahkar_matched: null, identity_matched: null,
    identity_first_name: null, identity_last_name: null, identity_father_name: null,
    identity_checked_at: null, full_name: null,
    biometric_status: 'NONE', biometric_session_id: null, biometric_reason: null, biometric_checked_at: null,
    phone: '09123456789',
    ...overrides,
  };
}

function harness(options: { row?: Row; zohal?: Partial<ZohalService>; lastResultAt?: Date | null; recentSession?: boolean } = {}) {
  const row = options.row ?? baseRow();
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      if (sql.includes('FROM drivers d JOIN users u') && sql.includes('d.user_id=$1')) return { rows: [row], rowCount: 1 };
      if (sql.includes('FROM drivers d JOIN users u') && sql.includes('WHERE d.id=$1')) return { rows: [row], rowCount: 1 };
      if (sql.includes("key='require_driver_identity'")) return { rows: [{ value_int: '1' }], rowCount: 1 };
      if (sql.startsWith('SELECT 1 FROM drivers WHERE national_code')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('SELECT 1 FROM identity_checks')) return { rows: options.recentSession ? [{ '?column?': 1 }] : [], rowCount: options.recentSession ? 1 : 0 };
      if (sql.startsWith("SELECT created_at FROM identity_checks")) {
        return { rows: options.lastResultAt ? [{ created_at: options.lastResultAt }] : [], rowCount: options.lastResultAt ? 1 : 0 };
      }
      if (sql.startsWith('UPDATE drivers SET national_code')) {
        // $2 code, $3 birth date, $4 serial, $5 gender, $6 shahkar, $7 identity, $8/$9 names, $11 changed
        row.national_code = values[1] as string;
        row.shahkar_matched = values[5] as boolean;
        row.identity_matched = values[6] as boolean;
        row.identity_first_name = values[7] as string;
        row.identity_last_name = values[8] as string;
        row.biometric_status = values[10] ? 'NONE' : row.biometric_status;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE drivers SET biometric_status='PENDING'")) {
        row.biometric_status = 'PENDING';
        row.biometric_session_id = values[1] as string;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE drivers SET biometric_status='FAILED'")) {
        row.biometric_status = 'FAILED';
        row.biometric_reason = values[1] as string;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE drivers SET biometric_status=$2')) {
        row.biometric_status = values[1] as string;
        row.biometric_reason = values[2] as string;
        row.biometric_checked_at = new Date().toISOString();
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const zohal = {
    configured: () => true,
    biometricConfigured: () => true,
    shahkar: async () => ({ matched: true, latencyMs: 5 }),
    identity: async () => ({ matched: true, firstName: 'مریم', lastName: 'رضایی', fatherName: 'حسن', alive: true, latencyMs: 5 }),
    uploadSelfieVideo: async () => ({ mediaId: 'media-1', latencyMs: 5 }),
    startLiveness: async () => ({ sessionId: 's-1', status: 'pending', latencyMs: 5 }),
    livenessResult: async () => ({ status: 'completed', result: 'matched', reason: 'ACCEPT', completedAt: '2026-11-17T10:00:00', latencyMs: 5 }),
    ...options.zohal,
  } as unknown as ZohalService;
  const rateLimit = { enforce: async () => undefined } as never;
  return { service: new DriverIdentityService(pool as never, zohal, rateLimit), statements, row };
}

const verifyBody = { nationalCode: '0012345679', birthDate: '1377/06/30', cardSerial: '1234567890', gender: 'مرد' };
const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);

describe('DriverIdentityService · Shahkar + registry', () => {
  it('refuses a malformed national code before it spends a paid enquiry', async () => {
    let called = false;
    const service = new DriverIdentityService({ query: async () => { called = true; return { rows: [], rowCount: 0 }; } } as never,
      { configured: () => true } as never, { enforce: async () => undefined } as never);
    await assert.rejects(service.verify({ sub: driverUserId }, { ...verifyBody, nationalCode: '0012345678' }), BadRequestException);
    assert.equal(called, false);
  });

  it('stores both answers, the official name and the fact that the identity is complete', async () => {
    const { service, statements } = harness();
    const view = await service.verify({ sub: driverUserId }, verifyBody);
    assert.equal(view.identityReady, true);
    assert.equal(view.complete, false, 'identity alone is not enough — the video still has to pass');
    assert.ok(statements.some(entry => entry.sql.includes('identity_checks') && entry.values?.[2] === 'SHAHKAR'));
    assert.ok(statements.some(entry => entry.sql.includes('identity_checks') && entry.values?.[2] === 'ID_INQUIRY'));
    const update = statements.find(entry => entry.sql.startsWith('UPDATE drivers SET national_code'))!;
    const values = update.values as unknown[];
    assert.equal(values[1], '0012345679');
    assert.equal(values[2], '1998-09-21', 'the birthday lands as a real date');
    assert.equal(values[4], 1);
    assert.ok(statements.some(entry => entry.sql.includes('DRIVER_IDENTITY_CHECKED')));
  });

  it('says plainly when the number is not registered to that national code', async () => {
    const { service, statements } = harness({ zohal: { shahkar: async () => ({ matched: false, latencyMs: 3 }) } as never });
    await assert.rejects(service.verify({ sub: driverUserId }, verifyBody), (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.match((error as Error).message, /به نام این کد ملی ثبت نشده/);
      return true;
    });
    const update = statements.find(entry => entry.sql.startsWith('UPDATE drivers SET national_code'))!;
    assert.equal((update.values as unknown[])[5], false, 'the mismatch is kept for support, not thrown away');
  });

  it('says when the registry has nobody with that birthday', async () => {
    const { service } = harness({
      zohal: { identity: async () => ({ matched: false, firstName: null, lastName: null, fatherName: null, alive: null, latencyMs: 3 }) } as never,
    });
    await assert.rejects(service.verify({ sub: driverUserId }, verifyBody), /ثبت احوال/);
  });

  it('turns a provider outage into a readable message and records the failure', async () => {
    const { service, statements } = harness({
      zohal: { shahkar: async () => { throw new ServiceUnavailableException('سرویس استعلام الان در دسترس نیست؛ چند دقیقهٔ دیگه دوباره امتحان کن.'); } } as never,
    });
    await assert.rejects(service.verify({ sub: driverUserId }, verifyBody), ServiceUnavailableException);
    assert.ok(statements.some(entry => entry.sql.includes('identity_checks') && entry.values?.[3] === false));
  });

  it('never lets one national code drive two accounts', async () => {
    const row = baseRow();
    const statements: string[] = [];
    const pool = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('FROM drivers d JOIN users u')) return { rows: [row], rowCount: 1 };
        if (sql.startsWith('SELECT 1 FROM drivers WHERE national_code')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };
    const service = new DriverIdentityService(pool as never, { configured: () => true, shahkar: async () => ({ matched: true }), identity: async () => ({ matched: true }) } as never, { enforce: async () => undefined } as never);
    await assert.rejects(service.verify({ sub: driverUserId }, verifyBody), /قبلاً برای یک پیک دیگر/);
    assert.ok(!statements.some(statement => statement.includes('identity_checks')), 'no money spent on a duplicate');
  });
});

describe('DriverIdentityService · the selfie video', () => {
  it('refuses a body that is not a video, is too big, or is the wrong type', async () => {
    const { service } = harness();
    await assert.rejects(service.submitBiometric({ sub: driverUserId }, new Uint8Array([0x3c, 0x68, 0x74]), 'video/webm'), BadRequestException);
    await assert.rejects(service.submitBiometric({ sub: driverUserId }, webm, 'image/png'), BadRequestException);
    await assert.rejects(service.submitBiometric({ sub: driverUserId }, new Uint8Array(4_000_001), 'video/webm'), /بزرگ‌تر/);
  });

  it('insists on the identity check before it opens a session', async () => {
    const { service } = harness();
    await assert.rejects(service.submitBiometric({ sub: driverUserId }, webm, 'video/webm'), /اول استعلام هویت/);
  });

  it('uploads, opens the session and waits as PENDING', async () => {
    const { service, statements, row } = harness({
      row: baseRow({ shahkar_matched: true, identity_matched: true, national_code: '0012345679', birth_date: '1998-09-21', national_card_serial: '1234567890', gender: 1 }),
    });
    const view = await service.submitBiometric({ sub: driverUserId }, webm, 'video/webm;codecs=vp8');
    assert.equal(view.biometricStatus, 'PENDING');
    assert.equal(row.biometric_session_id, 's-1');
    assert.ok(statements.some(entry => entry.sql.includes('DRIVER_BIOMETRIC_SUBMITTED')));
  });

  it('will not charge a second video while the first one is still under review', async () => {
    const { service } = harness({
      recentSession: true,
      row: baseRow({ shahkar_matched: true, identity_matched: true, national_code: '0012345679', birth_date: '1998-09-21', national_card_serial: '1234567890', gender: 0, biometric_status: 'PENDING' }),
    });
    await assert.rejects(service.submitBiometric({ sub: driverUserId }, webm, 'video/mp4'), /هنوز در حال بررسیه/);
  });
});

describe('DriverIdentityService · the verdict', () => {
  it('marks a matched video as complete', async () => {
    const { service, statements } = harness({
      row: baseRow({ shahkar_matched: true, identity_matched: true, national_code: '0012345679', birth_date: '1998-09-21', national_card_serial: '1234567890', gender: 1, biometric_status: 'PENDING', biometric_session_id: 's-1' }),
    });
    const view = await service.poll({ sub: driverUserId });
    assert.equal(view.biometricStatus, 'MATCHED');
    assert.equal(view.complete, true);
    assert.ok(statements.some(entry => entry.sql.includes('INSERT INTO notifications')));
  });

  it('keeps the provider’s reason and tells the courier what to fix', async () => {
    const { service } = harness({
      row: baseRow({ shahkar_matched: true, identity_matched: true, biometric_status: 'PENDING', biometric_session_id: 's-2' }),
      zohal: { livenessResult: async () => ({ status: 'failed', result: 'rejected', reason: 'REJECT_VIDEO_NOT_LIVE', completedAt: null, latencyMs: 4 }) } as never,
    });
    const view = await service.poll({ sub: driverUserId });
    assert.equal(view.biometricStatus, 'REJECTED');
    assert.equal(view.biometricReason, 'REJECT_VIDEO_NOT_LIVE');
    assert.match(String(view.biometricReasonText), /زنده/);
  });

  it('does not pay for a second question within ten seconds of the last one', async () => {
    let asked = 0;
    const { service } = harness({
      row: baseRow({ biometric_status: 'PENDING', biometric_session_id: 's-3' }),
      lastResultAt: new Date(),
      zohal: { livenessResult: async () => { asked += 1; return { status: 'pending', result: '', reason: '', completedAt: null, latencyMs: 1 }; } } as never,
    });
    await service.poll({ sub: driverUserId });
    assert.equal(asked, 0);
  });

  it('reports a provider outage during the poll instead of pretending it is rejected', async () => {
    const { service } = harness({
      row: baseRow({ biometric_status: 'PENDING', biometric_session_id: 's-4' }),
      lastResultAt: new Date(Date.now() - 60_000),
      zohal: { livenessResult: async () => { throw new ServiceUnavailableException('سرویس بیومتریک الان در دسترس نیست.'); } } as never,
    });
    await assert.rejects(service.poll({ sub: driverUserId }), ServiceUnavailableException);
  });
});

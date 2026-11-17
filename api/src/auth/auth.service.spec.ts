import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { AuthService } from './auth.service';

function authService(query: () => void) {
  return new AuthService({ query: async () => { query(); return { rows: [{ count: 0 }], rowCount: 1 }; } } as never);
}

describe('AuthService OTP request validation', () => {
  it('rejects invalid phone numbers without reaching the database', async () => {
    let queried = false;
    await assert.rejects(authService(() => { queried = true; }).requestOtp('12345'), BadRequestException);
    assert.equal(queried, false);
  });

  it('requires SMS configuration for a valid Iranian mobile number before database access', async () => {
    const oldKey = process.env.KAVENEGAR_API_KEY;
    const oldTemplate = process.env.KAVENEGAR_OTP_TEMPLATE;
    delete process.env.KAVENEGAR_API_KEY;
    delete process.env.KAVENEGAR_OTP_TEMPLATE;
    let queried = false;
    try {
      await assert.rejects(authService(() => { queried = true; }).requestOtp('09123456789'), ServiceUnavailableException);
      assert.equal(queried, false);
    } finally {
      if (oldKey === undefined) delete process.env.KAVENEGAR_API_KEY;
      else process.env.KAVENEGAR_API_KEY = oldKey;
      if (oldTemplate === undefined) delete process.env.KAVENEGAR_OTP_TEMPLATE;
      else process.env.KAVENEGAR_OTP_TEMPLATE = oldTemplate;
    }
  });
});

describe('AuthService OTP verification attempts', () => {
  it('increments failed attempts and commits the counter before rejecting a wrong code', async () => {
    const previousJwt = process.env.JWT_SECRET;
    const previousHmac = process.env.OTP_HMAC_SECRET;
    process.env.JWT_SECRET = 'test-jwt-secret-with-at-least-thirty-two-characters';
    process.env.OTP_HMAC_SECRET = 'test-hmac-secret-with-at-least-thirty-two-characters';
    const expectedDigest = createHmac('sha256', process.env.OTP_HMAC_SECRET).update('+989123456789:111111').digest('hex');
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        statements.push({ sql, values });
        return sql.startsWith('SELECT id,code_digest')
          ? { rows: [{ id: 'challenge-1', code_digest: expectedDigest, attempts: 0 }], rowCount: 1 }
          : { rows: [], rowCount: 1 };
      },
      release() {},
    };
    try {
      await assert.rejects(new AuthService({ connect: async () => client } as never).verifyOtp('09123456789', '222222'), UnauthorizedException);
      const increment = statements.find((entry) => entry.sql.includes('attempts=attempts+1'));
      assert.deepEqual(increment?.values, ['challenge-1']);
      assert.ok(statements.some((entry) => entry.sql === 'COMMIT'));
    } finally {
      if (previousJwt === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousJwt;
      if (previousHmac === undefined) delete process.env.OTP_HMAC_SECRET;
      else process.env.OTP_HMAC_SECRET = previousHmac;
    }
  });
});

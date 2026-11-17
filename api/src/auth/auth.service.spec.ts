import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
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

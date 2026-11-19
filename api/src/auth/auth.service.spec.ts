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

/** A pool double that records every statement and the values that went with it. */
function recordingPool(count = 0) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (/count\(\*\)::int/.test(sql)) return { rows: [{ count }], rowCount: 1 };
      if (/INSERT INTO otp_challenges/.test(sql)) return { rows: [{ id: 'challenge-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool: pool as never, calls };
}

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved = { ...values };
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const key of Object.keys(previous)) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

describe('AuthService test-mode OTP echo', () => {
  const HMAC = 'test-otp-hmac-secret-with-at-least-32-chars';

  it('hands the code back only when the operator opened the door', async () => {
    await withEnv({ KAVENEGAR_API_KEY: undefined, KAVENEGAR_OTP_TEMPLATE: undefined, OTP_HMAC_SECRET: HMAC, JETINO_ALLOW_TEST_OTP: 'yes' }, async () => {
      const { pool, calls } = recordingPool();
      const fetches: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: unknown) => { fetches.push(String(input)); return new Response('{}'); }) as never;
      try {
        const result = await new AuthService(pool).requestOtp('09123456789');
        assert.match(String((result as { testCode?: string }).testCode), /^\d{6}$/, 'a six digit code the SMS would have carried');
        assert.deepEqual(fetches, [], 'test mode must not call the SMS provider');
        const insert = calls.find((call) => /INSERT INTO otp_challenges/.test(call.sql));
        assert.ok(insert, 'the challenge is still stored');
        const digest = createHmac('sha256', HMAC).update(`+989123456789:${(result as { testCode: string }).testCode}`).digest('hex');
        assert.equal((insert!.values as [string, string])[1], digest, 'the echoed code is the one verification will accept');
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  it('stays silent about the code when the flag is off or SMS is configured', async () => {
    await withEnv({ KAVENEGAR_API_KEY: undefined, KAVENEGAR_OTP_TEMPLATE: undefined, OTP_HMAC_SECRET: HMAC, JETINO_ALLOW_TEST_OTP: undefined }, async () => {
      const { pool } = recordingPool();
      await assert.rejects(new AuthService(pool).requestOtp('09123456789'), ServiceUnavailableException);
    });
    await withEnv({ KAVENEGAR_API_KEY: 'k', KAVENEGAR_OTP_TEMPLATE: 'jetino-otp', OTP_HMAC_SECRET: HMAC, JETINO_ALLOW_TEST_OTP: undefined }, async () => {
      const { pool } = recordingPool();
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response(JSON.stringify({ return: { status: 200 } }), { status: 200 })) as never;
      try {
        const result = await new AuthService(pool).requestOtp('09123456789');
        assert.equal((result as { testCode?: string }).testCode, undefined, 'a configured provider owns the delivery');
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  it('keeps the request throttle in force in test mode', async () => {
    await withEnv({ KAVENEGAR_API_KEY: undefined, KAVENEGAR_OTP_TEMPLATE: undefined, OTP_HMAC_SECRET: HMAC, JETINO_ALLOW_TEST_OTP: 'yes' }, async () => {
      const { pool } = recordingPool(3);
      await assert.rejects(new AuthService(pool).requestOtp('09123456789'), (error: unknown) => (error as { status?: number }).status === 429);
    });
  });
});

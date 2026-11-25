import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';

const ok = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });

function serviceWith(handler: (sql: string, values?: unknown[]) => unknown) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = { query: async (sql: string, values?: unknown[]) => { calls.push({ sql, values }); return handler(sql, values); } };
  return { service: new RateLimitService(pool as never), calls };
}

describe('RateLimitService', () => {
  it('allows calls up to the limit and refuses the next one in the same window', async () => {
    let hits = 0;
    const { service } = serviceWith((sql) => (sql.startsWith('DELETE') ? ok() : ok([{ hits: ++hits }])));
    assert.equal((await service.consume('orders.create:u1', 2, 60)).allowed, true);
    assert.equal((await service.consume('orders.create:u1', 2, 60)).allowed, true);
    const third = await service.consume('orders.create:u1', 2, 60);
    assert.equal(third.allowed, false);
    assert.equal(third.remaining, 0);
    assert.equal(third.retryAfterSeconds, 60);
  });

  it('throws the Persian 429 with the window length so the client knows when to retry', async () => {
    const { service } = serviceWith((sql) => (sql.startsWith('DELETE') ? ok() : ok([{ hits: 99 }])));
    await assert.rejects(
      service.enforce('safety.sos:u1', 5, 600, 'گزارش‌های ایمنی زیاد است.'),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 429 && String(error.message).includes('600 ثانیه'),
    );
  });

  it('fails open when the counter table is unreachable', async () => {
    const { service } = serviceWith(() => { throw new Error('connection refused'); });
    const result = await service.consume('orders.create:u1', 1, 60);
    assert.deepEqual(result, { allowed: true, remaining: 1, retryAfterSeconds: 60 });
    await service.enforce('orders.create:u1', 1, 60, 'never thrown');
  });

  it('stores the bucket as one fixed window and truncates oversized keys', async () => {
    const { service, calls } = serviceWith((sql) => (sql.startsWith('DELETE') ? ok() : ok([{ hits: 1 }])));
    await service.consume('x'.repeat(500), 3, 60);
    const insert = calls.find(call => call.sql.includes('INSERT INTO rate_limit_counters'));
    assert.ok(insert);
    assert.equal((insert!.values![0] as string).length, 200);
    assert.equal(insert!.values![1], 60);
    assert.match(insert!.sql, /ON CONFLICT \(bucket,window_start\) DO UPDATE/);
  });

  it('refuses an invalid configuration instead of silently allowing everything', async () => {
    const { service } = serviceWith(() => ok([{ hits: 1 }]));
    await assert.rejects(service.consume('k', 0, 60), /rate limit configuration is invalid/);
    await assert.rejects(service.consume('k', 2, 0), /rate limit configuration is invalid/);
  });
});

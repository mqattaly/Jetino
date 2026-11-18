import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { AdminAuditService } from './admin-audit.service';

const actor = { sub: 'a0000000-0000-4000-8000-0000000000a1' };
const row = { id: 'r1', action: 'ORDER_CREATED', entityType: 'ORDER', entityId: 'o1', metadata: {}, createdAt: '2026-01-01T00:00:00.000Z', actorName: 'مدیر', actorPhone: '09123456789' };

function recorder(rows: unknown[] = [row]) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values: values ?? [] });
      if (sql.startsWith('INSERT')) return { rows: [], rowCount: 1 };
      if (sql.includes('GROUP BY a.action')) return { rows: [{ action: 'ORDER_CREATED', occurrences: 3, lastUsed: '2026-01-01T00:00:00.000Z' }], rowCount: 1 };
      if (sql.includes('COUNT(*)::int')) return { rows: [{ totalMatches: rows.length }], rowCount: 1 };
      return { rows, rowCount: rows.length };
    },
  };
  return { service: new AdminAuditService(pool as never), calls, selects: () => calls.filter(call => !call.sql.startsWith('INSERT')) };
}

describe('AdminAuditService filters', () => {
  it('binds every filter as a parameter instead of pasting it into SQL', async () => {
    const { service, calls } = recorder();
    await service.list(actor, { entityId: 'o1; DROP TABLE users' });
    const select = calls[0];
    assert.match(select.sql, /a\.entity_id = \$1/);
    assert.deepEqual(select.values, ['o1; DROP TABLE users', 25, 0]);
    assert.ok(!select.sql.includes('DROP TABLE'), 'user input must never reach the query text');
  });

  it('stacks all filters and keeps pagination as parameters', async () => {
    const { service, calls } = recorder();
    await service.list(actor, {
      action: 'CASH_SETTLEMENT_RECORDED',
      actorId: 'a0000000-0000-4000-8000-0000000000b2',
      entityId: 'c0000000-0000-4000-8000-0000000000c3',
      since: '2026-01-01',
      until: '2026-02-01T12:00:00.000Z',
      limit: '10',
      offset: '20',
    });
    const select = calls[0];
    assert.deepEqual(select.values, [
      'CASH_SETTLEMENT_RECORDED',
      'a0000000-0000-4000-8000-0000000000b2',
      'c0000000-0000-4000-8000-0000000000c3',
      new Date('2026-01-01').toISOString(),
      '2026-02-01T12:00:00.000Z',
      10, 20,
    ]);
    assert.match(select.sql, /LIMIT \$6 OFFSET \$7/);
    assert.match(select.sql, /a\.created_at >= \$4::timestamptz AND a\.created_at <= \$5::timestamptz/);
  });

  it('counts the same rows it lists', async () => {
    const { service, calls } = recorder();
    await service.list(actor, { action: 'ORDER_CREATED', limit: '5' });
    const [select, count] = calls;
    assert.match(select.sql, /a\.action = \$1/);
    assert.match(count.sql, /COUNT\(\*\)::int AS "totalMatches" FROM audit_logs a WHERE a\.action = \$1/);
    assert.deepEqual(count.values, ['ORDER_CREATED']);
  });

  it('refuses identifiers, dates and pages that are not what they claim to be', () => {
    for (const filters of [
      { action: 'order created' },
      { action: 'A;' },
      { actorId: 'me' },
      { entityId: '   ' },
      { entityId: 'x'.repeat(121) },
      { since: 'yesterday' },
      { until: 12 },
    ]) assert.throws(() => AdminAuditService.buildFilters(filters), BadRequestException, `accepted ${JSON.stringify(filters)}`);
    for (const page of [{ limit: '0' }, { limit: '1.5' }, { limit: 'x' }, { limit: 'Infinity' }, { offset: '-1' }, { offset: 'many' }]) {
      assert.throws(() => AdminAuditService.page(page.limit, page.offset), BadRequestException, `accepted page ${JSON.stringify(page)}`);
    }
  });

  it('caps the page so a browse cannot drain the log', async () => {
    const { service, calls } = recorder();
    const result = await service.list(actor, { limit: '100000' });
    assert.equal(calls[0].values.at(-2), 100, 'a huge requested page is clamped, not refused');
    assert.equal(result.limit, 100);
    assert.deepEqual(AdminAuditService.page(undefined, undefined), { limit: 25, offset: 0 });
    assert.deepEqual(AdminAuditService.page('50', '4000'), { limit: 50, offset: 4000 });
    assert.deepEqual(AdminAuditService.page('50', '9007199254740992'), { limit: 50, offset: 5000 }, 'a deep page is stopped, not obeyed');
  });
});

describe('AdminAuditService redaction', () => {
  it('hides credential-shaped metadata keys and says how many', () => {
    const { value, redacted } = AdminAuditService.redact({ amountRial: '500', otp: '12345', apiKey: 'k', before: { latitude: 27.2 } });
    assert.deepEqual(value, { amountRial: '500', before: { latitude: 27.2 } });
    assert.equal(redacted, 2);
  });

  it('treats anything that is not an object as empty metadata', () => {
    for (const input of [null, undefined, 'text', 12, [1, 2]]) assert.deepEqual(AdminAuditService.redact(input), { value: {}, redacted: 0 });
  });

  it('returns only the tail of a phone number', async () => {
    assert.equal(AdminAuditService.maskPhone('09123456789'), '•••••••6789');
    assert.equal(AdminAuditService.maskPhone(42 as never), null);
    assert.equal(AdminAuditService.maskPhone('12'), null);
    const { service, calls } = recorder();
    const result = await service.list(actor, {});
    assert.equal(result.items[0].actorPhone, '•••••••6789');
    assert.ok(!JSON.stringify(result.items).includes('09123456789'), 'the full number must never leave the server');
  });
});

describe('AdminAuditService browsing', () => {
  it('records that the log was read, with the filters that were used', async () => {
    const { service, calls } = recorder();
    await service.list(actor, { entityId: 'o1' });
    const audit = calls.at(-1);
    assert.match(String(audit?.sql), /INSERT INTO audit_logs.*'ADMIN_AUDIT_READ'/s);
    assert.equal(audit?.values[0], actor.sub);
    assert.equal(audit?.values[1], actor.sub, 'the uuid column and the varchar column need their own bound value');
    const written = JSON.parse(String(audit?.values[2]));
    assert.deepEqual(written, { entityId: 'o1', rows: 1, totalMatches: 1 });
  });

  it('exposes the vocabulary actually present in the log', async () => {
    const { service, calls } = recorder();
    const result = await service.actions();
    assert.deepEqual(result.items, [{ action: 'ORDER_CREATED', occurrences: 3, lastUsed: '2026-01-01T00:00:00.000Z' }]);
    assert.match(calls[0].sql, /GROUP BY a\.action/);
    assert.deepEqual(calls[0].values, []);
  });
});

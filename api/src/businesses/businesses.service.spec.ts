import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BusinessesService } from './businesses.service';

const businessId = '123e4567-e89b-12d3-a456-426614174000';

function serviceWithClient(onQuery: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>) {
  const client = { query: onQuery, release() {} };
  return new BusinessesService({ connect: async () => client } as never);
}

describe('BusinessesService owner controls', () => {
  it('pauses an owned active business in a transaction and records an audit event', async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const service = serviceWithClient(async (sql, values) => {
      statements.push({ sql, values });
      return sql.startsWith('SELECT status') ? { rows: [{ status: 'ACTIVE' }], rowCount: 1 } : { rows: [], rowCount: 1 };
    });

    assert.deepEqual(await service.setOrderability({ sub: 'owner-1' }, businessId, false), {
      id: businessId,
      status: 'PAUSED',
      acceptingOrders: false,
    });
    assert.equal(statements[0].sql, 'BEGIN');
    assert.match(statements[1].sql, /WHERE id=\$1 AND owner_id=\$2 FOR UPDATE/);
    assert.deepEqual(statements[1].values, [businessId, 'owner-1']);
    assert.ok(statements.some((entry) => entry.sql.includes('BUSINESS_ORDERABILITY_CHANGED')));
    assert.equal(statements.at(-1)?.sql, 'COMMIT');
  });

  it('returns not found and rolls back when the caller does not own the business', async () => {
    const statements: string[] = [];
    const service = serviceWithClient(async (sql) => {
      statements.push(sql);
      return sql.startsWith('SELECT status') ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 };
    });

    await assert.rejects(service.setOrderability({ sub: 'different-user' }, businessId, false), NotFoundException);
    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.equal(statements.some((sql) => sql.startsWith('UPDATE businesses')), false);
  });

  it('rejects malformed product prices before querying the database', async () => {
    let queried = false;
    const service = new BusinessesService({ query: async () => { queried = true; return { rows: [], rowCount: 0 }; } } as never);

    await assert.rejects(
      service.updateProduct({ sub: 'owner-1' }, businessId, { priceRial: '12x' }),
      BadRequestException,
    );
    assert.equal(queried, false);
  });
});

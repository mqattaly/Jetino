import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BusinessesService } from './businesses.service';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

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

describe('BusinessesService product photos', () => {
  it('stores a validated photo and returns it with the product', async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const service = new BusinessesService({
      query: async (sql: string, values?: unknown[]) => {
        statements.push({ sql, values });
        if (sql.startsWith('SELECT 1 FROM menu_categories')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
        if (sql.startsWith('INSERT INTO products')) return { rows: [{ id: 'p1', name: 'کباب', price_rial: '1000', is_available: true, image_url: PNG }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      connect: async () => { throw new Error('unreachable'); },
    } as never);
    const product = await service.createProduct({ sub: 'owner-1' }, businessId, { name: 'کباب', priceRial: '1000', imageUrl: PNG });
    assert.equal(product.image_url, PNG);
    const insert = statements.find(entry => entry.sql.startsWith('INSERT INTO products'))!;
    assert.match(insert.sql, /image_url/);
    assert.equal(insert.values?.[4], PNG);
    assert.ok(statements.some(entry => entry.sql.includes('INSERT INTO audit_logs') && entry.values?.[1] === 'MENU_PRODUCT_CREATED'));
  });

  it('clears a photo when the owner removes it and refuses an unsafe one', async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const service = new BusinessesService({
      query: async (sql: string, values?: unknown[]) => {
        statements.push({ sql, values });
        return { rows: [{ id: 'p1', image_url: null }], rowCount: 1 };
      },
    } as never);
    await service.updateProduct({ sub: 'owner-1' }, '123e4567-e89b-12d3-a456-426614174001', { imageUrl: null });
    const update = statements.find(entry => entry.sql.startsWith('UPDATE products'))!;
    assert.equal(update.values?.[6], true);
    assert.equal(update.values?.[7], null);
    await assert.rejects(service.updateProduct({ sub: 'owner-1' }, '123e4567-e89b-12d3-a456-426614174001', { imageUrl: 'javascript:alert(1)' }), BadRequestException);
  });
});

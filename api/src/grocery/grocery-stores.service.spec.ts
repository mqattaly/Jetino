import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GroceryStoresService } from './grocery-stores.service';

const storeId = '123e4567-e89b-12d3-a456-426614174010';
const productId = '123e4567-e89b-12d3-a456-426614174011';
const owner = { sub: 'owner-1' };
const staff = { sub: 'staff-1', roles: ['SUPER_ADMIN'] };

type Row = Record<string, unknown>;
type Handler = (sql: string, values: unknown[]) => { rows: Row[]; rowCount: number } | undefined;
function fakePool(handlers: Handler[]) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const run = async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    for (const handler of handlers) {
      const result = handler(sql, values);
      if (result !== undefined) return result;
    }
    return { rows: [], rowCount: 0 };
  };
  return { pool: { query: run, connect: async () => ({ query: run, release() {} }) } as never, statements };
}

const ownStoreRow = { rows: [{ id: storeId, status: 'ACTIVE', regionId: 'region-1' }], rowCount: 1 };

describe('GroceryStoresService · shops and shelves', () => {
  it('shows the customer only approved shops of active regions', async () => {
    const { pool } = fakePool([
      (sql) => sql.includes('FROM grocery_stores s JOIN regions r') ? { rows: [{ id: storeId, name: 'هایپر مرکزی', productCount: 4 }], rowCount: 1 } : undefined,
    ]);
    const service = new GroceryStoresService(pool);
    const result = await service.listStores({ sub: 'user-1' });
    assert.equal(result.stores.length, 1);
  });

  it('refuses a price that is not a whole rial amount before touching the database', async () => {
    let connected = false;
    const service = new GroceryStoresService({ query: async () => { connected = true; return { rows: [], rowCount: 0 }; } } as never);
    await assert.rejects(service.addProduct(owner, { name: 'سیب', priceRial: '۱۲٫۵', stock: 2 }), BadRequestException);
    await assert.rejects(service.addProduct(owner, { name: 'س', priceRial: '15000' }), BadRequestException);
    assert.equal(connected, false);
  });

  it('turns a duplicate product name into a readable conflict', async () => {
    const { pool } = fakePool([
      (sql) => sql.startsWith('SELECT id,status,region_id AS "regionId" FROM grocery_stores') ? ownStoreRow : undefined,
      (sql) => sql.startsWith('INSERT INTO grocery_products') ? (() => { throw Object.assign(new Error('duplicate'), { code: '23505' }); })() : undefined,
    ]);
    const service = new GroceryStoresService(pool);
    await assert.rejects(
      service.addProduct(owner, { name: 'سیب زرد', unit: 'کیلوگرم', priceRial: '84000', stock: '3' }),
      (error: unknown) => error instanceof ConflictException && /همین اسم/.test((error as Error).message),
    );
  });

  it('archives a product of the caller’s own shop instead of deleting it', async () => {
    const { pool, statements } = fakePool([
      (sql) => sql.startsWith('SELECT id,status,region_id AS "regionId" FROM grocery_stores') ? ownStoreRow : undefined,
      (sql) => sql.startsWith('UPDATE grocery_products SET is_active=false') ? { rows: [{ id: productId }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT s.id,s.name,s.phone,s.address_text') ? { rows: [{ id: storeId, name: 'هایپر مرکزی', status: 'ACTIVE' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT id,name,category,unit,price_rial') ? { rows: [], rowCount: 0 } : undefined,
    ]);
    const service = new GroceryStoresService(pool);
    await service.archiveProduct(owner, productId);
    const update = statements.find(entry => entry.sql.startsWith('UPDATE grocery_products SET is_active=false'))!;
    assert.deepEqual(update.values, [productId, storeId]);
    assert.ok(!statements.some(entry => /^DELETE FROM grocery_products/.test(entry.sql)), 'an old invoice must keep its product row');
  });

  it('rejects a product that belongs to another shop', async () => {
    const { pool } = fakePool([
      (sql) => sql.startsWith('SELECT id,status,region_id AS "regionId" FROM grocery_stores') ? ownStoreRow : undefined,
      (sql) => sql.startsWith('SELECT id,name,category,unit,price_rial') ? { rows: [], rowCount: 0 } : undefined,
    ]);
    const service = new GroceryStoresService(pool);
    await assert.rejects(service.updateProduct(owner, productId, { priceRial: '90000' }), NotFoundException);
  });

  it('keeps the shelf untouched for a suspended shop', async () => {
    const { pool } = fakePool([
      (sql) => sql.startsWith('SELECT id,status,region_id AS "regionId" FROM grocery_stores') ? { rows: [{ id: storeId, status: 'SUSPENDED', regionId: 'region-1' }], rowCount: 1 } : undefined,
    ]);
    const service = new GroceryStoresService(pool);
    await assert.rejects(service.addProduct(owner, { name: 'سیب', priceRial: '84000', stock: '1' }), ForbiddenException);
  });

  it('answers with an empty shop for an owner who has not signed up yet', async () => {
    const { pool } = fakePool([(sql) => sql.startsWith('SELECT s.id,s.name,s.phone,s.address_text') ? { rows: [], rowCount: 0 } : undefined]);
    const service = new GroceryStoresService(pool);
    const mine = await service.mine({ sub: 'new-owner' });
    assert.equal(mine.store, null);
    assert.deepEqual(mine.products, []);
  });

  it('keeps the shop request inside the active region and normalises the phone', async () => {
    const { pool, statements } = fakePool([
      (sql) => sql.startsWith('SELECT id FROM regions') ? { rows: [{ id: 'region-1' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('INSERT INTO grocery_stores') ? { rows: [{ id: storeId, status: 'PENDING' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT s.id,s.name,s.phone,s.address_text') ? { rows: [{ id: storeId, name: 'هایپر مرکزی', status: 'PENDING' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT id,name,category,unit,price_rial') ? { rows: [], rowCount: 0 } : undefined,
    ]);
    const service = new GroceryStoresService(pool);
    await service.save(owner, { name: 'هایپر مرکزی', phone: '۰۷۶۳۰۰۰۰۰۰۰', addressText: 'بندر خمیر، خیابان امام' });
    const insert = statements.find(entry => entry.sql.startsWith('INSERT INTO grocery_stores'))!;
    assert.equal(insert.values[1], 'region-1');
    assert.equal(insert.values[3], '07630000000');
  });

  it('only staff may approve a shop, and the owner hears about it', async () => {
    const { pool, statements } = fakePool([
      (sql) => sql.startsWith('SELECT s.id,s.name,s.status,s.owner_user_id') ? { rows: [{ id: storeId, name: 'هایپر مرکزی', status: 'PENDING', ownerUserId: 'owner-1' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('UPDATE grocery_stores SET status') ? { rows: [], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT s.id,s.name,s.phone,s.address_text AS "addressText",s.note,s.status') ? { rows: [], rowCount: 0 } : undefined,
      (sql) => sql.includes('INSERT INTO notifications') ? { rows: [], rowCount: 1 } : undefined,
    ]);
    const service = new GroceryStoresService(pool);
    await assert.rejects(service.adminStatus(owner, storeId, { status: 'ACTIVE' }), ForbiddenException);
    await assert.rejects(service.adminStatus(staff, storeId, { status: 'OPEN' }), BadRequestException);
    await service.adminStatus(staff, storeId, { status: 'ACTIVE' });
    const update = statements.find(entry => entry.sql.startsWith('UPDATE grocery_stores SET status'))!;
    assert.deepEqual(update.values.slice(0, 2), [storeId, 'ACTIVE']);
    assert.ok(statements.some(entry => entry.sql.includes('INSERT INTO audit_logs')), 'approval is audited');
    assert.ok(statements.some(entry => entry.sql.includes('notifications')), 'the owner is told');
  });
});

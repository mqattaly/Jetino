import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GroceryService } from './grocery.service';

const listId = '123e4567-e89b-12d3-a456-426614174000';
const bidId = '123e4567-e89b-12d3-a456-426614174001';
const addressId = '123e4567-e89b-12d3-a456-426614174002';
const driverId = 'drv-1';
const customer = { sub: 'user-1' };
const other = { sub: 'user-2' };

type Row = Record<string, unknown>;
type Handler = (sql: string, values: unknown[]) => { rows: Row[]; rowCount: number } | undefined;

/** Runs the statements against a scripted pool that answers by SQL prefix. */
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
  const client = { query: run, release() { /* no-op */ } };
  return { pool: { query: run, connect: async () => client } as never, statements };
}

type SettingOverrides = { bid?: number; payment?: number; mode?: string; feeBps?: number; goodsBps?: number; fixed?: number };
const settingsRows = (overrides: SettingOverrides = {}) => ({
  rows: [
    { key: 'grocery_bid_minutes', value_int: String(overrides.bid ?? 15), value_text: null },
    { key: 'grocery_payment_minutes', value_int: String(overrides.payment ?? 15), value_text: null },
    { key: 'grocery_revenue_mode', value_int: '0', value_text: overrides.mode ?? 'NONE' },
    { key: 'grocery_fee_bps', value_int: String(overrides.feeBps ?? 1000), value_text: null },
    { key: 'grocery_goods_bps', value_int: String(overrides.goodsBps ?? 0), value_text: null },
    { key: 'grocery_fixed_rial', value_int: String(overrides.fixed ?? 0), value_text: null },
  ],
  rowCount: 6,
});

const driverRow = { rows: [{ id: driverId, regionId: 'region-1', status: 'ACTIVE', verification: 'APPROVED' }], rowCount: 1 };
const gateOff = { rows: [{ value_int: '0' }], rowCount: 1 };

describe('GroceryService · text shopping list', () => {
  it('refuses a list shorter than five characters before touching the database', async () => {
    let connected = false;
    const service = new GroceryService({ connect: () => { connected = true; throw new Error('unexpected connection'); } } as never, undefined as never);
    await assert.rejects(service.create(customer, { itemsText: 'نان', addressId }), BadRequestException);
    assert.equal(connected, false);
  });

  it('refuses a list with no delivery address', async () => {
    const service = new GroceryService({ connect: () => { throw new Error('unexpected connection'); } } as never, undefined as never);
    await assert.rejects(service.create(customer, { itemsText: 'نان، شیر، پنیر' }), BadRequestException);
  });

  it('scopes the address to its owner and sets the bid window from settings', async () => {
    const { pool, statements } = fakePool([
      (sql) => sql.startsWith('SELECT a.id,a.address_text') ? {
        rows: [{ id: addressId, address_text: 'خیابان نمونه ۱۲', instructions: null, latitude: '27.1', longitude: '56.2', regionId: 'region-1', is_active: true }],
        rowCount: 1,
      } : undefined,
      (sql) => sql.startsWith('SELECT key,value_int,value_text') ? settingsRows({ bid: 20 }) : undefined,
      (sql) => sql.startsWith('SELECT id FROM grocery_lists WHERE customer_id') ? { rows: [], rowCount: 0 } : undefined,
      (sql) => sql.startsWith('INSERT INTO grocery_lists') ? { rows: [{ id: listId }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT g.id,g.customer_id') ? { rows: [{ id: listId, customerId: customer.sub, status: 'OPEN', driverUserId: null }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT name,quantity') || sql.startsWith('SELECT b.id,b.amount_rial') ? { rows: [], rowCount: 0 } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    const result = await service.create(customer, { itemsText: 'نان، شیر، پنیر', storeName: 'هایپر مرکزی', addressId });
    assert.equal(result.viewer, 'CUSTOMER');
    const address = statements.find(entry => entry.sql.startsWith('SELECT a.id,a.address_text'))!;
    assert.deepEqual(address.values, [addressId, customer.sub]);
    const insert = statements.find(entry => entry.sql.startsWith('INSERT INTO grocery_lists'))!;
    assert.equal(insert.values[10], '20');
  });

  it('rejects a bid below the minimum fee without opening a transaction', async () => {
    const service = new GroceryService({ connect: () => { throw new Error('unexpected connection'); } } as never, undefined as never);
    await assert.rejects(service.bid(customer, listId, { amountRial: 5000 }), BadRequestException);
  });

  it('refuses a courier from another region and rolls back', async () => {
    const { pool, statements } = fakePool([
      (sql) => sql.startsWith('SELECT d.id,d.region_id') ? driverRow : undefined,
      (sql) => sql.startsWith('SELECT value_int FROM platform_settings') ? gateOff : undefined,
      (sql) => sql.startsWith('UPDATE grocery_bids SET status') || sql.startsWith('UPDATE grocery_lists SET status') ? { rows: [], rowCount: 0 } : undefined,
      (sql) => sql.startsWith('SELECT id,customer_id,region_id,status') ? {
        rows: [{ id: listId, customer_id: customer.sub, region_id: 'region-9', status: 'OPEN', bid_deadline_at: new Date(Date.now() + 600_000) }], rowCount: 1,
      } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await assert.rejects(service.bid({ sub: 'driver-user' }, listId, { amountRial: 120_000 }), ForbiddenException);
    assert.equal(statements.at(-1)?.sql, 'ROLLBACK');
  });

  it('does not let another customer accept someone else\'s bid', async () => {
    const { pool, statements } = fakePool([
      (sql) => sql.startsWith('SELECT id,customer_id,status') ? {
        rows: [{ id: listId, customer_id: customer.sub, status: 'OPEN' }], rowCount: 1,
      } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await assert.rejects(service.acceptBid(other, listId, bidId), NotFoundException);
    assert.equal(statements.at(-1)?.sql, 'ROLLBACK');
  });

  it('accepts a bid, assigns the courier and rejects the rest', async () => {
    const { pool, statements } = fakePool([
      (sql) => sql.startsWith('SELECT id,customer_id,status') ? { rows: [{ id: listId, customer_id: customer.sub, status: 'OPEN' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT b.id,b.driver_id') ? { rows: [{ id: bidId, driver_id: driverId, amount_rial: '150000', user_id: 'driver-user' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT g.id,g.customer_id') ? { rows: [{ id: listId, customerId: customer.sub, status: 'ASSIGNED', driverUserId: 'driver-user' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT name,quantity') || sql.startsWith('SELECT b.id,b.amount_rial') ? { rows: [], rowCount: 0 } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await service.acceptBid(customer, listId, bidId);
    const assign = statements.find(entry => entry.sql.startsWith('UPDATE grocery_lists SET driver_id'))!;
    assert.deepEqual(assign.values, [listId, driverId, bidId, '150000']);
    const rejected = statements.find(entry => entry.sql.startsWith('UPDATE grocery_bids SET status=\'REJECTED\''))!;
    assert.match(rejected.sql, /status='REJECTED'/);
    assert.deepEqual(rejected.values, [listId, bidId]);
  });

  it('requires a sixteen-digit shop card on the invoice', async () => {
    const { pool } = fakePool([
      (sql) => sql.startsWith('SELECT d.id,d.region_id') ? driverRow : undefined,
      (sql) => sql.startsWith('SELECT value_int FROM platform_settings') ? gateOff : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await assert.rejects(service.submitInvoice({ sub: 'driver-user' }, listId, { amountRial: 120_000, storeCard: '6037', storeHolder: 'هایپر مرکزی' }), BadRequestException);
  });

  it('rejects invoice lines that do not add up to the invoice total', async () => {
    const { pool } = fakePool([
      (sql) => sql.startsWith('SELECT d.id,d.region_id') ? driverRow : undefined,
      (sql) => sql.startsWith('SELECT value_int FROM platform_settings') ? gateOff : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await assert.rejects(service.submitInvoice({ sub: 'driver-user' }, listId, {
      amountRial: 100_000, storeCard: '6037000000000000', storeHolder: 'هایپر مرکزی',
      items: [{ name: 'نان', quantity: 2, unitPriceRial: 20_000 }],
    }), BadRequestException);
  });

  it('keeps the online option closed until a gateway exists', async () => {
    const service = new GroceryService({ connect: () => { throw new Error('unexpected connection'); } } as never, undefined as never);
    await assert.rejects(service.declarePayment(customer, listId, { method: 'ONLINE', receiptUrl: 'https://example.com/r.jpg' }), BadRequestException);
  });

  it('requires the payment receipt image', async () => {
    const service = new GroceryService({ connect: () => { throw new Error('unexpected connection'); } } as never, undefined as never);
    await assert.rejects(service.declarePayment(customer, listId, { method: 'CARD_TO_CARD' }), BadRequestException);
  });

  it('lets only the assigned courier confirm the receipt', async () => {
    const { pool } = fakePool([
      (sql) => sql.startsWith('SELECT d.id,d.region_id') ? driverRow : undefined,
      (sql) => sql.startsWith('SELECT value_int FROM platform_settings') ? gateOff : undefined,
      (sql) => sql.startsWith('SELECT g.id,g.customer_id,g.driver_id') ? {
        rows: [{ id: listId, customer_id: customer.sub, driver_id: 'another-driver', status: 'PAID', fee_rial: '150000', invoice_amount_rial: '300000', payment_receipt_url: 'https://example.com/r.jpg' }],
        rowCount: 1,
      } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await assert.rejects(service.confirmPayment({ sub: 'driver-user' }, listId), ForbiddenException);
  });

  it('marks the receipt confirmed and stores the platform fee of the chosen revenue model', async () => {
    const { pool, statements } = fakePool([
      (sql) => sql.startsWith('SELECT d.id,d.region_id') ? driverRow : undefined,
      (sql) => sql.startsWith('SELECT value_int FROM platform_settings') ? gateOff : undefined,
      (sql) => sql.startsWith('SELECT key,value_int,value_text') ? settingsRows({ mode: 'FEE_PERCENT', feeBps: 1000 }) : undefined,
      (sql) => sql.startsWith('SELECT g.id,g.customer_id,g.driver_id') ? {
        rows: [{ id: listId, customer_id: customer.sub, driver_id: driverId, status: 'PAID', fee_rial: '100000', invoice_amount_rial: '300000', payment_receipt_url: 'https://example.com/r.jpg' }],
        rowCount: 1,
      } : undefined,
      (sql) => sql.startsWith('SELECT g.id,g.customer_id') ? { rows: [{ id: listId, customerId: customer.sub, status: 'PAYMENT_CONFIRMED', driverUserId: 'driver-user' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT name,quantity') || sql.startsWith('SELECT b.id,b.amount_rial') ? { rows: [], rowCount: 0 } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await service.confirmPayment({ sub: 'driver-user' }, listId);
    const update = statements.find(entry => entry.sql.startsWith('UPDATE grocery_lists SET status=\'PAYMENT_CONFIRMED\''))!;
    assert.deepEqual(update.values, [listId, 'driver-user', '10000']);
  });

  it('will not confirm a payment that has no receipt', async () => {
    const { pool } = fakePool([
      (sql) => sql.startsWith('SELECT d.id,d.region_id') ? driverRow : undefined,
      (sql) => sql.startsWith('SELECT value_int FROM platform_settings') ? gateOff : undefined,
      (sql) => sql.startsWith('SELECT g.id,g.customer_id,g.driver_id') ? {
        rows: [{ id: listId, customer_id: customer.sub, driver_id: driverId, status: 'AWAITING_PAYMENT', fee_rial: '100000', invoice_amount_rial: '300000', payment_receipt_url: null }],
        rowCount: 1,
      } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await assert.rejects(service.confirmPayment({ sub: 'driver-user' }, listId), ConflictException);
  });

  it('refuses to mark a mission delivered before the payment is confirmed', async () => {
    const { pool } = fakePool([
      (sql) => sql.startsWith('SELECT d.id,d.region_id') ? driverRow : undefined,
      (sql) => sql.startsWith('SELECT value_int FROM platform_settings') ? gateOff : undefined,
      (sql) => sql.startsWith('SELECT id,customer_id,driver_id,status') ? { rows: [{ id: listId, customer_id: customer.sub, driver_id: driverId, status: 'ASSIGNED' }], rowCount: 1 } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await assert.rejects(service.transition({ sub: 'driver-user' }, listId, 'DELIVERED'), ConflictException);
  });

  it('only lets the customer cancel while bids are still open', async () => {
    const { pool } = fakePool([
      (sql) => sql.startsWith('SELECT id,customer_id,status') ? { rows: [{ id: listId, customer_id: customer.sub, status: 'ASSIGNED' }], rowCount: 1 } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await assert.rejects(service.cancel(customer, listId), ConflictException);
  });

  it('shows every bid to the customer but only their own to a courier', async () => {
    const bids = [
      { id: 'b1', amountRial: '100000', status: 'ACCEPTED', driverUserId: 'driver-user' },
      { id: 'b2', amountRial: '90000', status: 'REJECTED', driverUserId: 'other-driver' },
    ];
    const { pool } = fakePool([
      (sql) => sql.startsWith('SELECT g.id,g.customer_id') ? { rows: [{ id: listId, customerId: customer.sub, status: 'ASSIGNED', driverUserId: 'driver-user' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT name,quantity') ? { rows: [], rowCount: 0 } : undefined,
      (sql) => sql.startsWith('SELECT b.id,b.amount_rial') ? { rows: bids, rowCount: 2 } : undefined,
      (sql) => sql.startsWith('UPDATE grocery_bids SET status') || sql.startsWith('UPDATE grocery_lists SET status') ? { rows: [], rowCount: 0 } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    const forCustomer = await service.detail(customer, listId);
    assert.equal(forCustomer.bids.length, 2);
    const forCourier = await service.detail({ sub: 'driver-user' }, listId);
    assert.equal(forCourier.bids.length, 1);
    assert.equal((forCourier.bids[0] as Row).driverUserId, undefined);
  });
});

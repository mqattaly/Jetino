import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
      (sql) => sql.startsWith('SELECT key,value_int,value_text') ? settingsRows() : undefined,
      (sql) => sql.startsWith('SELECT b.id,b.driver_id') ? { rows: [{ id: bidId, driver_id: driverId, amount_rial: '150000', user_id: 'driver-user' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT g.id,g.customer_id') ? { rows: [{ id: listId, customerId: customer.sub, status: 'ASSIGNED', driverUserId: 'driver-user' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT name,quantity') || sql.startsWith('SELECT b.id,b.amount_rial') ? { rows: [], rowCount: 0 } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await service.acceptBid(customer, listId, bidId);
    const assign = statements.find(entry => entry.sql.startsWith('UPDATE grocery_lists SET driver_id'))!;
    assert.deepEqual(assign.values, [listId, driverId, bidId, '150000', '15']);
    assert.match(assign.sql, /fee_deadline_at=now\(\)/);
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

  it('marks the receipt confirmed and stores the platform fee with the model that produced it', async () => {
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
    // amount, model, rate and fixed value are snapshotted together so later settings never rewrite history
    assert.deepEqual(update.values, [listId, 'driver-user', '10000', 'FEE_PERCENT', 1000, null]);
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


  it('does not let the courier invoice before the prepaid fee is confirmed', async () => {
    const { pool } = fakePool([
      (sql) => sql.startsWith('SELECT d.id,d.region_id') ? driverRow : undefined,
      (sql) => sql.startsWith('SELECT value_int FROM platform_settings') ? gateOff : undefined,
      (sql) => sql.startsWith('SELECT id,customer_id,driver_id,status') ? {
        rows: [{ id: listId, customer_id: customer.sub, driver_id: driverId, status: 'ASSIGNED', fee_confirmed_at: null }], rowCount: 1,
      } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await assert.rejects(service.submitInvoice({ sub: 'driver-user' }, listId, { amountRial: 120_000, storeCard: '6037000000000000', storeHolder: 'هایپر مرکزی' }), ConflictException);
  });

  it('does not let the courier start shopping before the fee is confirmed', async () => {
    const { pool } = fakePool([
      (sql) => sql.startsWith('SELECT d.id,d.region_id') ? driverRow : undefined,
      (sql) => sql.startsWith('SELECT value_int FROM platform_settings') ? gateOff : undefined,
      (sql) => sql.startsWith('SELECT id,customer_id,driver_id,status,fee_rial') ? {
        rows: [{ id: listId, customer_id: customer.sub, driver_id: driverId, status: 'ASSIGNED', fee_rial: '150000', fee_confirmed_at: null, refunded_at: null }], rowCount: 1,
      } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await assert.rejects(service.transition({ sub: 'driver-user' }, listId, 'SHOPPING'), ConflictException);
  });

  it('refuses the online fee payment until a gateway is connected', async () => {
    const { pool } = fakePool([(sql) => sql.startsWith('SELECT key,value_int,value_text') ? settingsRows() : undefined]);
    const service = new GroceryService(pool, undefined as never);
    await assert.rejects(service.declareFeePayment(customer, listId, { method: 'ONLINE', receiptUrl: 'https://example.com/r.jpg' }), ConflictException);
  });

  it('stores the prepaid fee receipt and notifies staff', async () => {
    const { pool, statements } = fakePool([
      (sql) => sql.startsWith('SELECT key,value_int,value_text') ? settingsRows({ mode: 'CARD_TO_CARD' }) : undefined,
      (sql) => sql.startsWith('SELECT g.id,g.customer_id,g.status') ? {
        rows: [{ customer_id: customer.sub, status: 'ASSIGNED', fee_rial: '150000', fee_confirmed_at: null, driver_user: 'driver-user' }], rowCount: 1,
      } : undefined,
      (sql) => sql.startsWith('SELECT DISTINCT ur.user_id') ? { rows: [{ user_id: 'staff-1' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT g.id,g.customer_id AS "customerId"') ? { rows: [{ id: listId, customerId: customer.sub, status: 'ASSIGNED', driverUserId: 'driver-user' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT name,quantity') || sql.startsWith('SELECT b.id,b.amount_rial') ? { rows: [], rowCount: 0 } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await service.declareFeePayment(customer, listId, { method: 'CARD_TO_CARD', receiptUrl: 'https://example.com/r.jpg', reference: '123456' });
    const update = statements.find(entry => entry.sql.startsWith('UPDATE grocery_lists SET fee_payment_method'))!;
    assert.equal(update.values[1], 'CARD_TO_CARD');
    assert.equal(update.values[3], '123456');
    const staffNote = statements.find(entry => entry.sql.startsWith('INSERT INTO notifications(user_id,event_type'))!;
    assert.equal(staffNote.values[0], 'staff-1');
  });

  it('only staff may confirm the prepaid fee', async () => {
    const service = new GroceryService({ connect: () => { throw new Error('unexpected connection'); } } as never, undefined as never);
    await assert.rejects(service.confirmFeePayment(customer, listId), ForbiddenException);
  });

  it('marks the fee confirmed for staff and unlocks the shopping step', async () => {
    const { pool, statements } = fakePool([
      (sql) => sql.startsWith('SELECT g.id,g.customer_id,g.status') ? {
        rows: [{ customer_id: customer.sub, status: 'ASSIGNED', fee_rial: '150000', fee_declared_at: new Date(), fee_confirmed_at: null, driver_user: 'driver-user' }], rowCount: 1,
      } : undefined,
      (sql) => sql.startsWith('SELECT g.id,g.customer_id') ? { rows: [{ id: listId, customerId: customer.sub, status: 'ASSIGNED', driverUserId: 'driver-user', feeConfirmedAt: new Date() }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT name,quantity') || sql.startsWith('SELECT b.id,b.amount_rial') ? { rows: [], rowCount: 0 } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await service.confirmFeePayment({ sub: 'staff-1', roles: ['SUPPORT'] }, listId);
    const update = statements.find(entry => entry.sql.startsWith('UPDATE grocery_lists SET fee_confirmed_at'))!;
    assert.deepEqual(update.values, [listId, 'staff-1']);
  });

  it('stops extending the fee deadline once the cap is reached', async () => {
    const { pool } = fakePool([
      (sql) => sql.startsWith('SELECT d.id,d.region_id') ? driverRow : undefined,
      (sql) => sql.startsWith('SELECT value_int FROM platform_settings') ? gateOff : undefined,
      (sql) => sql.startsWith('SELECT key,value_int,value_text') ? settingsRows({ mode: 'CARD_TO_CARD' }) : undefined,
      (sql) => sql.startsWith('SELECT id,customer_id,driver_id,status,fee_confirmed_at,fee_deadline_at') ? {
        rows: [{ customer_id: customer.sub, driver_id: driverId, status: 'ASSIGNED', fee_confirmed_at: null, fee_deadline_at: new Date(), payment_deadline_at: null, fee_extensions: 2, payment_extensions: 0 }],
        rowCount: 1,
      } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await assert.rejects(service.extendDeadline({ sub: 'driver-user' }, listId, 'FEE'), ConflictException);
  });

  it('extends the payment deadline and tells the customer', async () => {
    const { pool, statements } = fakePool([
      (sql) => sql.startsWith('SELECT d.id,d.region_id') ? driverRow : undefined,
      (sql) => sql.startsWith('SELECT value_int FROM platform_settings') ? gateOff : undefined,
      (sql) => sql.startsWith('SELECT key,value_int,value_text') ? settingsRows({ mode: 'CARD_TO_CARD' }) : undefined,
      (sql) => sql.startsWith('SELECT id,customer_id,driver_id,status,fee_confirmed_at,fee_deadline_at') ? {
        rows: [{ customer_id: customer.sub, driver_id: driverId, status: 'AWAITING_PAYMENT', fee_confirmed_at: new Date(), fee_deadline_at: null, payment_deadline_at: new Date(), fee_extensions: 0, payment_extensions: 0 }],
        rowCount: 1,
      } : undefined,
      (sql) => sql.startsWith('SELECT g.id,g.customer_id') ? { rows: [{ id: listId, customerId: customer.sub, status: 'AWAITING_PAYMENT', driverUserId: 'driver-user' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT name,quantity') || sql.startsWith('SELECT b.id,b.amount_rial') ? { rows: [], rowCount: 0 } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await service.extendDeadline({ sub: 'driver-user' }, listId, 'PAYMENT');
    const update = statements.find(entry => entry.sql.startsWith('UPDATE grocery_lists SET payment_deadline_at'))!;
    assert.equal(update.values[1], '15');
    assert.match(update.sql, /payment_extensions=payment_extensions\+1/);
  });

  it('sends the invoice back to the courier when the customer objects', async () => {
    const { pool, statements } = fakePool([
      (sql) => sql.startsWith('SELECT g.id,g.customer_id,g.status') ? { rows: [{ customer_id: customer.sub, status: 'INVOICE_SENT', driver_user: 'driver-user' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT g.id,g.customer_id') ? { rows: [{ id: listId, customerId: customer.sub, status: 'SHOPPING', driverUserId: 'driver-user' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT name,quantity') || sql.startsWith('SELECT b.id,b.amount_rial') ? { rows: [], rowCount: 0 } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await service.rejectInvoice(customer, listId, 'قیمت تخم‌مرغ اشتباه ثبت شده');
    const update = statements.find(entry => entry.sql.startsWith("UPDATE grocery_lists SET status='SHOPPING'"))!;
    assert.deepEqual(update.values, [listId, 'قیمت تخم‌مرغ اشتباه ثبت شده']);
  });

  it('credits the wallet when a mission with a paid fee is cancelled', async () => {
    const { pool, statements } = fakePool([
      (sql) => sql.startsWith('SELECT d.id,d.region_id') ? driverRow : undefined,
      (sql) => sql.startsWith('SELECT value_int FROM platform_settings') ? gateOff : undefined,
      (sql) => sql.startsWith('SELECT id,customer_id,driver_id,status,fee_rial') ? {
        rows: [{ id: listId, customer_id: customer.sub, driver_id: driverId, status: 'SHOPPING', fee_rial: '120000', fee_confirmed_at: new Date(), refunded_at: null }],
        rowCount: 1,
      } : undefined,
      (sql) => sql.startsWith('SELECT g.id,g.customer_id') ? { rows: [{ id: listId, customerId: customer.sub, status: 'CANCELLED', driverUserId: 'driver-user' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT name,quantity') || sql.startsWith('SELECT b.id,b.amount_rial') ? { rows: [], rowCount: 0 } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await service.transition({ sub: 'driver-user' }, listId, 'CANCELLED', 'فروشگاه بسته شده است');
    const credit = statements.find(entry => entry.sql.startsWith('INSERT INTO wallet_credits'))!;
    assert.deepEqual(credit.values, [customer.sub, '120000', listId, 'بازگشت کرایهٔ ماموریت خرید لغوشده', 'driver-user']);
    const refund = statements.find(entry => entry.sql.startsWith('UPDATE grocery_lists SET refund_rial'))!;
    assert.deepEqual(refund.values, [listId, '120000']);
  });

  it('validates the revenue settings before writing them', async () => {
    const service = new GroceryService({ connect: () => { throw new Error('unexpected connection'); } } as never, undefined as never);
    const staff = { sub: 'staff-1', roles: ['SUPER_ADMIN'] };
    await assert.rejects(service.updateAdminSettings(staff, { revenueMode: 'MAGIC' }), BadRequestException);
    await assert.rejects(service.updateAdminSettings(staff, { feeBps: 20000 }), BadRequestException);
    await assert.rejects(service.updateAdminSettings(staff, {}), BadRequestException);
  });


  it('publishes the admin-configured card and sheba for card-to-card payments', async () => {
    const { pool } = fakePool([
      (sql) => sql.startsWith('SELECT key,value_int,value_text') ? {
        rows: [
          { key: 'grocery_bid_minutes', value_int: '15', value_text: null },
          { key: 'grocery_payment_minutes', value_int: '15', value_text: null },
          { key: 'grocery_revenue_mode', value_int: '0', value_text: 'NONE' },
          { key: 'grocery_fee_bps', value_int: '1000', value_text: null },
          { key: 'grocery_goods_bps', value_int: '0', value_text: null },
          { key: 'grocery_fixed_rial', value_int: '0', value_text: null },
          { key: 'grocery_payment_mode', value_int: '0', value_text: 'CARD_TO_CARD' },
          { key: 'grocery_extend_minutes', value_int: '15', value_text: null },
          { key: 'grocery_max_extensions', value_int: '2', value_text: null },
          { key: 'grocery_platform_card', value_int: '0', value_text: '6037000000000000' },
          { key: 'grocery_platform_sheba', value_int: '0', value_text: 'IR000000000000000000000000' },
          { key: 'grocery_platform_holder', value_int: '0', value_text: 'شرکت جتینو' },
          { key: 'grocery_platform_bank', value_int: '0', value_text: 'ملی' },
          { key: 'grocery_gateway_enabled', value_int: '0', value_text: null },
        ],
        rowCount: 14,
      } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    const destination = await service.paymentDestination();
    assert.equal(destination.fee.cardToCard.enabled, true);
    assert.equal(destination.fee.cardToCard.card, '6037000000000000');
    assert.equal(destination.fee.cardToCard.sheba, 'IR000000000000000000000000');
    assert.equal(destination.fee.online.enabled, false);
  });

  it('keeps card-to-card available even after a gateway is switched on', async () => {
    const { pool } = fakePool([
      (sql) => sql.startsWith('SELECT key,value_int,value_text') ? settingsRows({ mode: 'CARD_TO_CARD' }) : undefined,
      (sql) => sql.startsWith('SELECT g.id,g.customer_id,g.status') ? {
        rows: [{ customer_id: customer.sub, status: 'ASSIGNED', fee_rial: '150000', fee_confirmed_at: null, driver_user: 'driver-user' }], rowCount: 1,
      } : undefined,
      (sql) => sql.startsWith('SELECT DISTINCT ur.user_id') ? { rows: [], rowCount: 0 } : undefined,
      (sql) => sql.startsWith('SELECT g.id,g.customer_id AS "customerId"') ? { rows: [{ id: listId, customerId: customer.sub, status: 'ASSIGNED', driverUserId: 'driver-user' }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT name,quantity') || sql.startsWith('SELECT b.id,b.amount_rial') ? { rows: [], rowCount: 0 } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    await service.declareFeePayment(customer, listId, { method: 'CARD_TO_CARD', receiptUrl: 'https://example.com/r.jpg' });
  });

  it('validates the admin card, sheba and gateway switch', async () => {
    const service = new GroceryService({ connect: () => { throw new Error('unexpected connection'); } } as never, undefined as never);
    const staff = { sub: 'staff-1', roles: ['SUPER_ADMIN'] };
    await assert.rejects(service.updateAdminSettings(staff, { platformCard: '1234' }), BadRequestException);
    await assert.rejects(service.updateAdminSettings(staff, { platformSheba: 'IR123' }), BadRequestException);
    await assert.rejects(service.updateAdminSettings(staff, { gatewayEnabled: 'yes' }), BadRequestException);
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

  it('hands the courier panel the open board, their pending offers and their missions at once', async () => {
    const { pool, statements } = fakePool([
      (sql) => sql.startsWith('SELECT d.id,d.region_id') ? driverRow : undefined,
      (sql) => sql.startsWith('SELECT value_int FROM platform_settings') ? gateOff : undefined,
      (sql) => sql.startsWith('UPDATE grocery_bids SET status') || sql.startsWith('UPDATE grocery_lists SET status')
        ? { rows: [], rowCount: 0 } : undefined,
      (sql) => sql.startsWith('SELECT g.id,g.store_name') && sql.includes('NOT EXISTS')
        ? { rows: [{ id: listId, itemsText: 'نان، شیر، پنیر', bidCount: 2 }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT g.id,g.store_name') && sql.includes('PAYMENT_CONFIRMED')
        ? { rows: [{ id: bidId, status: 'SHOPPING', feeConfirmedAt: new Date() }], rowCount: 1 } : undefined,
      (sql) => sql.startsWith('SELECT g.id,g.store_name') && sql.includes('"listStatus"')
        ? { rows: [{ id: listId, amountRial: '150000' }], rowCount: 1 } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    const board = await service.courierBoard({ sub: 'driver-user' });
    assert.equal(board.open.length, 1);
    assert.equal(board.assigned.length, 1);
    assert.equal((board.myBids ?? []).length, 1);
    // the open board is scoped to the courier's own region and never shows lists they already bid on
    const openQuery = statements.find(entry => entry.sql.includes('NOT EXISTS'))!;
    assert.deepEqual(openQuery.values, ['region-1', driverId]);
    const bidQuery = statements.find(entry => entry.sql.includes('"listStatus"'))!;
    assert.deepEqual(bidQuery.values, [driverId]);
  });

  it('sums fees, goods and commission of a range and groups the commission by the stored model', async () => {
    const { pool, statements } = fakePool([
      (sql) => sql.includes('grocery-report-totals') ? {
        rows: [{ lists: '4', delivered: '3', feesConfirmedRial: '700000', goodsConfirmedRial: '4200000', platformRial: '70000', refundedRial: '150000' }],
        rowCount: 1,
      } : undefined,
      (sql) => sql.includes('grocery-report-models') ? {
        rows: [
          { mode: 'FEE_PERCENT', lists: '2', feesRial: '400000', goodsRial: '2600000', platformRial: '40000' },
          { mode: 'FIXED', lists: '1', feesRial: '150000', goodsRial: '800000', platformRial: '30000' },
          { mode: 'UNSNAPSHOTTED', lists: '1', feesRial: '150000', goodsRial: '800000', platformRial: '0' },
        ],
        rowCount: 3,
      } : undefined,
      (sql) => sql.includes('grocery-report-daily') ? { rows: [{ day: '2026-11-16', lists: '2', delivered: '1', feesRial: '300000', goodsRial: '1200000', platformRial: '30000' }], rowCount: 1 } : undefined,
      (sql) => sql.includes('grocery-report-attention') ? {
        rows: [{ goodsReceiptWaiting: '2', goodsReceiptStale: '1', feeReceiptWaiting: '1', deliveredWithoutPayment: '0', refundMissing: '1', goodsConfirmedWithoutReceipt: '0', invoiceStale: '1' }],
        rowCount: 1,
      } : undefined,
      (sql) => sql.includes('grocery-report-queue') ? {
        rows: [{ id: listId, storeName: 'هایپر مرکزی', status: 'PAID', invoice_amount_rial: '1200000', platform_fee_rial: '30000' }],
        rowCount: 1,
      } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    const report = await service.reports({ sub: 'staff', roles: ['OPERATIONS_MANAGER'] }, '2026-11-01', '2026-11-16');
    assert.equal(report.from, '2026-11-01');
    assert.equal(report.to, '2026-11-16');
    assert.equal(report.days, 16);
    assert.equal((report.totals as Row).platformRial, '70000');
    assert.equal(report.byModel.length, 3);
    assert.equal((report.byModel[2] as Row).mode, 'UNSNAPSHOTTED');
    assert.equal((report.attention as Row).refundMissing, '1');
    // money rows are strings so a bigint never loses precision on the way to the browser
    assert.equal((report.queue[0] as Row).invoiceAmountRial, '1200000');
    const totalsQuery = statements.find(entry => entry.sql.includes('grocery-report-totals'))!;
    assert.deepEqual(totalsQuery.values, ['2026-11-01', '2026-11-16']);
  });

  it('refuses a reversed or malformed report range and keeps the report staff-only', async () => {
    const service = new GroceryService({ query: async () => ({ rows: [], rowCount: 0 }), connect: () => { throw new Error('unexpected'); } } as never, undefined as never);
    await assert.rejects(service.reports({ sub: 'user', roles: ['CUSTOMER'] }), ForbiddenException);
    await assert.rejects(service.reports({ sub: 'staff', roles: ['SUPER_ADMIN'] }, '2026-13-01', '2026-11-16'), BadRequestException);
    await assert.rejects(service.reports({ sub: 'staff', roles: ['SUPER_ADMIN'] }, '2026-11-16', '2026-11-01'), BadRequestException);
    await assert.rejects(service.reports({ sub: 'staff', roles: ['SUPER_ADMIN'] }, '2025-01-01', '2026-11-16'), BadRequestException);
  });


  it('keeps the report range in bound values and never splices it into the SQL text', async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const pool = {
      query: async (sql: string, values?: unknown[]) => { statements.push({ sql, values }); return { rows: [{}], rowCount: 1 }; },
      connect: () => { throw new Error('unexpected'); },
    };
    const service = new GroceryService(pool as never, undefined as never);
    await service.reports({ sub: 'staff', roles: ['SUPER_ADMIN'] }, '2026-11-01', '2026-11-16');
    assert.equal(statements.length, 5, 'totals, models, daily, attention and the queue in one round trip');
    for (const entry of statements) {
      assert.ok(!entry.sql.includes('2026-11-01'), 'a date must travel as a bound value');
      assert.ok(entry.values === undefined || entry.values.every(value => !String(value).includes('DROP')), 'no raw input in the SQL');
    }
    assert.deepEqual(statements[0].values, ['2026-11-01', '2026-11-16']);
  });

  it('never reads the courier phone from the drivers table, which has no phone column', async () => {
    // the phone lives on users; a stray `d.phone` broke every grocery detail call in production once
    const candidate = join(process.cwd(), 'src/grocery/grocery.service.ts');
    const fallback = join(process.cwd(), 'api/src/grocery/grocery.service.ts');
    const source = await readFile(candidate, 'utf8').catch(() => readFile(fallback, 'utf8'));
    assert.ok(!/\bd\.phone\b/.test(source), 'drivers has no phone column — read it from the joined user');
    assert.ok(!/\bd\.full_name\b/.test(source), 'use the users table for identity fields the schema keeps there');
  });

  it('writes the CSV with a BOM, quoted cells and a filename that names the range', async () => {
    const { pool } = fakePool([
      (sql) => sql.includes('grocery-report-csv') ? {
        rows: [{
          id: listId, createdAt: new Date('2026-11-16T08:00:00Z'), storeName: '=HYPERLINK("x")', status: 'DELIVERED',
          feeRial: '250000', feeConfirmedAt: new Date('2026-11-16T08:05:00Z'), invoiceAmountRial: '1450000',
          paymentConfirmedAt: new Date('2026-11-16T08:40:00Z'), platformRial: '25000', mode: 'FEE_PERCENT',
          refundRial: '0', customerPhone: '09120000000', driverPhone: '09130000000',
        }],
        rowCount: 1,
      } : undefined,
    ]);
    const service = new GroceryService(pool, undefined as never);
    const file = await service.reportsCsv({ sub: 'staff', roles: ['SUPER_ADMIN'] }, '2026-11-16', '2026-11-16');
    assert.equal(file.filename, 'jetino-grocery-2026-11-16_2026-11-16.csv');
    assert.ok(file.body.startsWith('\uFEFF'));
    assert.ok(file.body.includes('"شناسه"'));
    // a store name that looks like a formula never reaches Excel as one
    assert.ok(file.body.includes('"\'=HYPERLINK(""x"")"'));
    assert.ok(file.body.includes('"25000"'));
  });
});

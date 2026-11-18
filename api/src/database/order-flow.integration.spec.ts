import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { NotFoundException } from '@nestjs/common';
import { OrdersService } from '../orders/orders.service';
import { AdminOrdersService } from '../admin/admin-orders.service';
import { AdminReportsService } from '../admin/admin-reports.service';
import { DriversService } from '../drivers/drivers.service';
import { BusinessesService } from '../businesses/businesses.service';
import { DeliveryService } from '../delivery/delivery.service';

/**
 * End-to-end flow against a real PostgreSQL instance. It is skipped unless
 * DATABASE_URL_TEST points at a scratch database, so unit tests keep running
 * anywhere while CI exercises the actual SQL, constraints and triggers.
 * Each run uses its own throwaway schema and drops it afterwards.
 */
const databaseUrl = process.env.DATABASE_URL_TEST ?? '';
const suite = databaseUrl ? describe : describe.skip;
const migrationDirectory = resolve(process.cwd(), 'src/database/migrations');

const uuids = {
  customer: 'a0000000-0000-4000-8000-000000000001',
  owner: 'a0000000-0000-4000-8000-000000000002',
  driver: 'a0000000-0000-4000-8000-000000000003',
  admin: 'a0000000-0000-4000-8000-000000000004',
  business: 'a0000000-0000-4000-8000-000000000005',
  category: 'a0000000-0000-4000-8000-000000000006',
  product: 'a0000000-0000-4000-8000-000000000007',
  address: 'a0000000-0000-4000-8000-000000000008',
  driverProfile: 'a0000000-0000-4000-8000-000000000009',
  otherRegion: 'a0000000-0000-4000-8000-00000000000a',
  otherAddress: 'a0000000-0000-4000-8000-00000000000b',
};

const PRICE = 3200000n; const QUANTITY = 2; const DELIVERY_FEE = 500000n; const COMMISSION_BPS = 1000;
const subtotal = PRICE * BigInt(QUANTITY);
const commission = (subtotal * BigInt(COMMISSION_BPS) + 5000n) / 10000n;
const total = subtotal + DELIVERY_FEE;

suite('cash order flow against PostgreSQL', () => {
  const schema = `jetino_it_${Date.now().toString(36)}`;
  let pool: Pool;
  let orders: OrdersService;
  let adminOrders: AdminOrdersService;
  let reports: AdminReportsService;
  let drivers: DriversService;
  let businesses: BusinessesService;
  let delivery: DeliveryService;

  before(async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    try {
      await admin.query(`SET search_path TO ${schema}`);
      const files = (await readdir(migrationDirectory)).filter(name => name.endsWith('.sql')).sort();
      for (const file of files) await admin.query(await readFile(resolve(migrationDirectory, file), 'utf8'));
      const region = await admin.query(`SELECT id FROM regions WHERE slug='bandar-khamir'`);
      const regionId = region.rows[0].id as string;
      await admin.query(`UPDATE regions SET delivery_fee_rial=$2 WHERE id=$1`, [regionId, DELIVERY_FEE.toString()]);
      await admin.query(`INSERT INTO platform_settings(key,value_int) VALUES('default_commission_bps',$1) ON CONFLICT(key) DO UPDATE SET value_int=EXCLUDED.value_int`, [COMMISSION_BPS]);
      await admin.query(`INSERT INTO users(id,phone,display_name) VALUES($1,'09120000001','مشتری آزمون'),($2,'09120000002','صاحب کسب‌وکار'),($3,'09120000003','راننده آزمون'),($4,'09120000004','مدیر آزمون')`, [uuids.customer, uuids.owner, uuids.driver, uuids.admin]);
      await admin.query(`INSERT INTO user_roles(user_id,role) VALUES($1,'CUSTOMER'),($2,'BUSINESS_OWNER'),($3,'DRIVER'),($4,'SUPER_ADMIN')`, [uuids.customer, uuids.owner, uuids.driver, uuids.admin]);
      await admin.query(`INSERT INTO businesses(id,owner_id,region_id,name,status,commission_bps) VALUES($1,$2,$3,'رستوران آزمون','ACTIVE',$4)`, [uuids.business, uuids.owner, regionId, COMMISSION_BPS]);
      await admin.query(`INSERT INTO menu_categories(id,business_id,name,sort_order) VALUES($1,$2,'غذای گرم',1)`, [uuids.category, uuids.business]);
      await admin.query(`INSERT INTO products(id,category_id,name,price_rial,is_available) VALUES($1,$2,'قلیه‌ماهی',$3,true)`, [uuids.product, uuids.category, PRICE.toString()]);
      await admin.query(`INSERT INTO addresses(id,user_id,region_id,label,address_text,latitude,longitude,is_default) VALUES($1,$2,$3,'خانه','خیابان ساحلی، پلاک ۴',27.200000,55.700000,true)`, [uuids.address, uuids.customer, regionId]);
      await admin.query(`INSERT INTO regions(id,name,slug,is_active,delivery_fee_rial) VALUES($1,'منطقهٔ دیگر','other-region',true,400000)`, [uuids.otherRegion]);
      await admin.query(`INSERT INTO addresses(id,user_id,region_id,label,address_text,is_default) VALUES($1,$2,$3,'ویلا','خانهٔ تابستانی',false)`, [uuids.otherAddress, uuids.customer, uuids.otherRegion]);
      await admin.query(`INSERT INTO drivers(id,user_id,region_id,status) VALUES($1,$2,$3,'ACTIVE')`, [uuids.driverProfile, uuids.driver, regionId]);
    } finally { await admin.end(); }
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    orders = new OrdersService(pool);
    adminOrders = new AdminOrdersService(pool);
    reports = new AdminReportsService(pool);
    drivers = new DriversService(pool);
    businesses = new BusinessesService(pool);
    delivery = new DeliveryService(pool);
  });

  after(async () => {
    await pool?.end();
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  const placeOrder = async (idempotencyKey: string) => orders.create(
    { sub: uuids.customer },
    { businessId: uuids.business, addressId: uuids.address, paymentMethod: 'CASH', items: [{ productId: uuids.product, quantity: QUANTITY }] },
    idempotencyKey,
  );

  const rows = async (sql: string, values?: unknown[]) => (await pool.query(sql, values)).rows;

  it('prices the basket on the server and stores the snapshot the later steps read from', async () => {
    const quote = await orders.quote({ sub: uuids.customer }, { businessId: uuids.business, addressId: uuids.address, items: [{ productId: uuids.product, quantity: QUANTITY }] });
    assert.equal(quote.subtotalRial, subtotal.toString());
    assert.equal(quote.deliveryFeeRial, DELIVERY_FEE.toString());
    assert.equal(quote.totalRial, total.toString());
    assert.equal(quote.commission.amountRial, commission.toString());
    assert.equal(quote.commission.rateBps, COMMISSION_BPS);
    assert.deepEqual(quote.paymentMethods, ['CASH']);
    assert.equal((await rows(`SELECT id FROM orders`)).length, 0, 'a quote must not reserve anything');

    const order = await placeOrder('flow-price');
    assert.equal(order.status, 'PENDING_BUSINESS');
    assert.equal(order.amounts.totalRial, total.toString());
    assert.equal(order.delivery.latitude, 27.2);
    assert.equal(order.items.length, 1);
    assert.deepEqual(await rows(`SELECT product_name,quantity,line_total_rial FROM order_items WHERE order_id=$1`, [order.id]), [
      { product_name: 'قلیه‌ماهی', quantity: QUANTITY, line_total_rial: subtotal.toString() },
    ]);

    // the price is frozen: changing the menu must not move an existing order
    await pool.query(`UPDATE products SET price_rial=$1 WHERE id=$2`, [(PRICE * 2n).toString(), uuids.product]);
    assert.equal((await orders.detail({ sub: uuids.customer }, order.id)).amounts.totalRial, total.toString());
    await pool.query(`UPDATE products SET price_rial=$1 WHERE id=$2`, [PRICE.toString(), uuids.product]);

    const replay = await placeOrder('flow-price');
    assert.equal(replay.replayed, true);
    assert.equal(replay.id, order.id);
    await assert.rejects(
      orders.create({ sub: uuids.customer }, { businessId: uuids.business, addressId: uuids.address, items: [{ productId: uuids.product, quantity: 1 }] }, 'flow-price'),
      /محتوای سفارش دیگری/,
    );
    assert.equal((await rows(`SELECT id FROM orders`)).length, 1, 'a rejected retry must not create a second order');
  });

  it('refuses a basket whose address is outside the business region', async () => {
    await assert.rejects(
      orders.create({ sub: uuids.customer }, { businessId: uuids.business, addressId: uuids.otherAddress, items: [{ productId: uuids.product, quantity: 1 }] }, 'flow-region'),
      /منطقهٔ خدمت/,
    );
    assert.equal((await rows(`SELECT id FROM orders`)).length, 1);
  });

  it('measures the run from the shop pin to the customer door', async () => {
    const order = await placeOrder('flow-route');

    const halfPin = await businesses.setLocation({ sub: uuids.owner }, uuids.business, { latitude: 27.2005 }).catch(error => (error as Error).message);
    assert.match(String(halfPin), /هر دو/, 'a half coordinate is worse than none');
    assert.equal((await rows(`SELECT latitude,longitude FROM businesses WHERE id=$1`, [uuids.business]))[0].latitude, null);

    await assert.rejects(businesses.setLocation({ sub: uuids.customer }, uuids.business, { latitude: 27.2, longitude: 55.7 }), NotFoundException, 'only the owner may move the shop pin');

    const unroutable = await delivery.estimateForOrder({ sub: uuids.customer }, order.id);
    assert.equal(unroutable.available, false);
    if (!unroutable.available) assert.equal(unroutable.reason, 'BUSINESS_LOCATION_MISSING');

    const pinned = await businesses.setLocation({ sub: uuids.owner }, uuids.business, { latitude: 27.2005, longitude: 55.7005 });
    assert.equal(Number(pinned.latitude), 27.2005);
    const estimate = await delivery.estimateForOrder({ sub: uuids.customer }, order.id);
    assert.equal(estimate.available, true);
    if (estimate.available) {
      assert.ok(estimate.distanceMeters > 40 && estimate.distanceMeters < 400, `unexpected short hop: ${estimate.distanceMeters} m`);
      assert.ok(estimate.durationMinutes >= 1);
      assert.equal(estimate.cached, false);
    }
    await pool.query(`UPDATE businesses SET latitude=NULL,longitude=NULL WHERE id=$1`, [uuids.business]);
    const cleared = await delivery.estimateForOrder({ sub: uuids.customer }, order.id);
    assert.equal(cleared.available, false, 'clearing the pin must not leave a stale cached route');
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM orders WHERE id=$1`, [order.id]))[0].c, 1);
  });

  it('walks a cash order through the kitchen, the courier and the settlement book', async () => {
    const order = await placeOrder('flow-full');

    assert.deepEqual(await orders.businessTransition({ sub: uuids.owner }, order.id, 'CONFIRMED', 25), { id: order.id, fromStatus: 'PENDING_BUSINESS', status: 'CONFIRMED', estimatedPrepMinutes: 25 });
    await orders.businessTransition({ sub: uuids.owner }, order.id, 'PREPARING');
    await orders.businessTransition({ sub: uuids.owner }, order.id, 'READY_FOR_PICKUP');
    assert.deepEqual(
      (await rows(`SELECT to_status FROM order_status_history WHERE order_id=$1 ORDER BY created_at,id`, [order.id])).map(row => row.to_status),
      ['PENDING_BUSINESS', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP'],
    );
    assert.equal((await orders.detail({ sub: uuids.customer }, order.id)).estimatedPrepMinutes, 25);

    const ready = await adminOrders.list('READY_FOR_PICKUP');
    const listed = ready.items.find(item => item.id === order.id)!;
    assert.equal(listed.deliveryLatitude, 27.2);
    assert.equal(listed.businessName, 'رستوران آزمون');

    assert.deepEqual(await adminOrders.assign(uuids.admin, order.id, uuids.driverProfile), { orderId: order.id, driverId: uuids.driverProfile, status: 'DRIVER_ASSIGNED' });
    await assert.rejects(adminOrders.assign(uuids.admin, order.id, uuids.business), /راننده/);

    const assignments = await rows(`SELECT da.driver_id,(SELECT COUNT(*) FROM driver_assignment_history WHERE order_id=$1)::int AS history_count FROM delivery_assignments da WHERE da.order_id=$1`, [order.id]);
    assert.deepEqual(assignments, [{ driver_id: uuids.driverProfile, history_count: 1 }]);

    const queue = await drivers.deliveries({ sub: uuids.driver });
    const task = queue.find(item => item.id === order.id)!;
    assert.equal(task.deliveryLongitude, 55.7);
    assert.equal(task.businessPhone, '09120000002');

    await assert.rejects(drivers.collectCash({ sub: uuids.driver }, order.id, true), /پس از تحویل سفارش/);
    await drivers.transition({ sub: uuids.driver }, order.id, 'OUT_FOR_DELIVERY');
    await drivers.transition({ sub: uuids.driver }, order.id, 'DELIVERED');
    const beforeCollection = await drivers.cashSummary({ sub: uuids.driver });
    assert.deepEqual({ open: beforeCollection.openCashRial, openCount: beforeCollection.openCount, settled: beforeCollection.settledTotalRial }, { open: '0', openCount: 0, settled: '0' }, 'nothing is owed to the driver before the money is actually taken');

    const collected = await drivers.collectCash({ sub: uuids.driver }, order.id, true);
    const wallet = await drivers.cashSummary({ sub: uuids.driver });
    assert.deepEqual({ open: wallet.openCashRial, openCount: wallet.openCount }, { open: total.toString(), openCount: 1 }, 'the collected cash becomes a balance owed to the driver');
    assert.deepEqual({ amountRial: collected.amountRial, alreadyCollected: collected.alreadyCollected }, { amountRial: total.toString(), alreadyCollected: false });
    assert.equal((await orders.detail({ sub: uuids.customer }, order.id)).payment.status, 'PAID');
    assert.deepEqual(await drivers.collectCash({ sub: uuids.driver }, order.id, true).then(result => result.alreadyCollected), true);
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM cash_collections WHERE order_id=$1`, [order.id]))[0].c, 1, 'collecting twice must not double the ledger');

    const summary = await reports.summary('24h');
    assert.equal(summary.deliveredOrders, '1');
    assert.equal(summary.cashCollectedRial, total.toString());
    assert.equal(summary.unsettledCashRial, total.toString());
    const outstanding = await reports.cashOutstanding();
    assert.deepEqual(outstanding.map(row => ({ phone: row.driverPhone, cash: row.openCashRial, count: row.openCount })), [{ phone: '09120000003', cash: total.toString(), count: 1 }]);

    const performance = await reports.businessPerformance('24h');
    const businessRow = performance.items.find(item => item.id === uuids.business)!;
    assert.deepEqual(
      { revenue: businessRow.revenueRial, commission: businessRow.commissionRial, orders: businessRow.ordersInPeriod, awaiting: businessRow.awaitingResponse, prep: businessRow.avgPrepMinutes, due: businessRow.unpaidDeliveredRial },
      { revenue: (total * 2n).toString(), commission: (commission * 2n).toString(), orders: 2, awaiting: 1, prep: 25, due: '0' },
      'the basket from the pricing test is still awaiting the kitchen, so it counts but owes nothing',
    );

    await assert.rejects(reports.settle({ sub: uuids.admin }, uuids.driverProfile, (total - 1n).toString()), /ریال است/);
    assert.equal((await reports.cashOutstanding())[0].openCashRial, total.toString(), 'a rejected settlement must leave the balance intact');

    const settlement = await reports.settle({ sub: uuids.admin }, uuids.driverProfile, total.toString(), 'تسویه هفتگی');
    assert.deepEqual({ amountRial: settlement.amountRial, orderCount: settlement.orderCount }, { amountRial: total.toString(), orderCount: 1 });
    assert.equal((await reports.cashOutstanding()).length, 0);
    assert.equal((await drivers.cashSummary({ sub: uuids.driver })).openCashRial, '0');
    assert.equal((await reports.summary('24h')).unsettledCashRial, '0');
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM cash_collections WHERE settlement_id=$1`, [settlement.id]))[0].c, 1);

    const events = (await rows(`SELECT event_type FROM notifications WHERE user_id=$1 ORDER BY created_at,id`, [uuids.customer])).map(row => row.event_type);
    assert.deepEqual(events, ['ORDER_CONFIRMED', 'ORDER_PREPARING', 'ORDER_READY_FOR_PICKUP', 'ORDER_DRIVER_ASSIGNED', 'ORDER_OUT_FOR_DELIVERY', 'ORDER_DELIVERED', 'CASH_PAYMENT_CONFIRMED']);
    const audited = (await rows(`SELECT action FROM audit_logs WHERE entity_id=$1`, [order.id])).map(row => row.action).sort();
    assert.deepEqual(audited, ['CASH_PAYMENT_COLLECTED', 'DRIVER_ASSIGNED', 'DRIVER_ORDER_STATUS_CHANGED', 'DRIVER_ORDER_STATUS_CHANGED', 'ORDER_CREATED', 'ORDER_STATUS_CHANGED', 'ORDER_STATUS_CHANGED', 'ORDER_STATUS_CHANGED'].sort(), 'every state change and both money moves must be traceable');
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM cash_settlements WHERE settled_by=$1`, [uuids.admin]))[0].c, 1);
  });

  it('lets the customer cancel before the kitchen answers and blocks it afterwards', async () => {
    const cancellable = await placeOrder('flow-cancel');
    assert.deepEqual(await orders.cancel({ sub: uuids.customer }, cancellable.id), { id: cancellable.id, status: 'CANCELLED' });
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM notifications WHERE user_id=$1 AND event_type='ORDER_CANCELLED'`, [uuids.owner]))[0].c, 1);

    const answered = await placeOrder('flow-after-answer');
    await orders.businessTransition({ sub: uuids.owner }, answered.id, 'CONFIRMED', 20);
    await assert.rejects(orders.cancel({ sub: uuids.customer }, answered.id), /پس از پاسخ کسب‌وکار/);
    assert.equal((await orders.detail({ sub: uuids.customer }, answered.id)).status, 'CONFIRMED');

    await assert.rejects(orders.cancel({ sub: uuids.owner }, answered.id), /پیدا نشد/);
  });
});

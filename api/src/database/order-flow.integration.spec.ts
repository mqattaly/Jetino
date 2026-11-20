import { randomUUID } from 'node:crypto';
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
import { AdminAuditService } from '../admin/admin-audit.service';
import { FeedbackService } from '../support/feedback.service';
import { SupportService } from '../support/support.service';
import { WalletService } from '../wallet/wallet.service';
import { CancellationsService } from '../cancellations/cancellations.service';
import { NotificationDeliveryService } from '../notifications/notification-delivery.service';
import { notify } from '../notifications/notifications.util';
import { allPushEventTypes } from '../notifications/notification-delivery.util';

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
  stranger: 'a0000000-0000-4000-8000-00000000000c',
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
  let audit: AdminAuditService;
  let feedback: FeedbackService;
  let support: SupportService;
  let cancellations: CancellationsService;

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
      await admin.query(`INSERT INTO users(id,phone,display_name) VALUES($1,'09120000001','مشتری آزمون'),($2,'09120000002','صاحب کسب‌وکار'),($3,'09120000003','راننده آزمون'),($4,'09120000004','مدیر آزمون'),($5,'09120000005','بی‌ربط')`, [uuids.customer, uuids.owner, uuids.driver, uuids.admin, uuids.stranger]);
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
    audit = new AdminAuditService(pool);
    feedback = new FeedbackService(pool);
    support = new SupportService(pool);
    cancellations = new CancellationsService(pool);
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
    // the pricing test's pending order already carries the delivery snapshot, so
    // routing is measured on it instead of placing a third order and shifting the
    // report counts the settlement test asserts on
    const [routed] = await rows(`SELECT id FROM orders ORDER BY created_at,id LIMIT 1`);
    const order = { id: routed.id as string };
    assert.equal((await rows(`SELECT id FROM orders`)).length, 1, 'measuring a route must not create orders');

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
    await businesses.setLocation({ sub: uuids.owner }, uuids.business, { latitude: '', longitude: '' });
    const cleared = await delivery.estimateForOrder({ sub: uuids.customer }, order.id);
    assert.equal(cleared.available, false, 'a shop that removed its pin must stop reporting estimates');
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM audit_logs WHERE entity_id=$1 AND action='BUSINESS_LOCATION_UPDATED'`, [uuids.business]))[0].c, 2, 'both the store and the clear are audited');
  });

  it('reads the audit trail back with filters, masking and a recorded browse', async () => {
    const first = await audit.list({ sub: uuids.admin }, { action: 'AUTH_OTP_LOGIN' });
    assert.equal(first.totalMatches, 0, 'this flow signs in through the service layer, not the OTP endpoint');
    assert.equal(first.items.length, 0);

    const all = await audit.list({ sub: uuids.admin }, { limit: '100' });
    const actions = new Set(all.items.map(item => item.action));
    assert.ok(actions.has('BUSINESS_LOCATION_UPDATED'), `recorded actions: ${[...actions].join(',')}`);
    assert.equal(all.items.every(item => item.createdAt !== undefined), true);

    const byEntity = await audit.list({ sub: uuids.admin }, { entityId: uuids.business });
    assert.ok(byEntity.items.length >= 2, 'every pin change on this business is found by entity');
    assert.equal(byEntity.items.every(item => item.entityId === uuids.business), true);

    const vocabulary = await audit.actions();
    const pinRow = vocabulary.items.find(item => item.action === 'BUSINESS_LOCATION_UPDATED');
    assert.ok(pinRow && pinRow.occurrences >= 2, 'the action list reflects what the log holds');

    const mine = await audit.list({ sub: uuids.admin }, { actorId: uuids.owner });
    assert.equal(mine.items.every(item => item.entityId === uuids.business), true, 'an actor filter must not leak other actors');
    assert.equal(mine.items.every(item => typeof item.actorPhone === 'string' && !item.actorPhone.includes('09120000002')), true, 'phones come back masked');

    // a junk identifier is only ever a bound value, so it finds nothing instead of breaking the query
    const junk = await audit.list({ sub: uuids.admin }, { entityId: "' OR 1=1 --" });
    assert.deepEqual(junk.items, []);

    const readBefore = (await rows(`SELECT COUNT(*)::int AS c FROM audit_logs WHERE action='ADMIN_AUDIT_READ'`))[0].c;
    await audit.list({ sub: uuids.admin }, { action: 'ADDRESS_CREATED' });
    const readAfter = (await rows(`SELECT COUNT(*)::int AS c FROM audit_logs WHERE action='ADMIN_AUDIT_READ'`))[0].c;
    assert.equal(readAfter, readBefore + 1, 'browsing the audit trail is itself audited');
    const newestRead = (await rows(`SELECT metadata FROM audit_logs WHERE action='ADMIN_AUDIT_READ' ORDER BY created_at DESC, id DESC LIMIT 1`))[0].metadata;
    assert.equal(newestRead.action, 'ADDRESS_CREATED');

    // since/until narrow on real timestamps, and a window with nothing in it is empty rather than wrong
    const future = await audit.list({ sub: uuids.admin }, { since: new Date(Date.now() + 3_600_000).toISOString() });
    assert.equal(future.totalMatches, 0);
    await assert.rejects(audit.list({ sub: uuids.admin }, { limit: 'Infinity' }), (error: unknown) => (error as Error).constructor.name === 'BadRequestException', 'a non-finite page is refused, not clamped');
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

  it('lets the customer cancel inside the policy window and queues anything after it', async () => {
    const cancellable = await placeOrder('flow-cancel');
    assert.deepEqual(await orders.cancel({ sub: uuids.customer }, cancellable.id), { id: cancellable.id, status: 'CANCELLED' });
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM notifications WHERE user_id=$1 AND event_type='ORDER_CANCELLED'`, [uuids.owner]))[0].c, 1);
    // §7.11: the automatic grant is itself recorded, with who asked, when and why
    const auto = (await rows(`SELECT outcome,reason,note,requested_by FROM cancellation_requests WHERE order_id=$1`, [cancellable.id]))[0];
    assert.equal(auto.outcome, 'ACCEPTED');
    assert.equal(auto.requested_by, uuids.customer);

    const answered = await placeOrder('flow-after-answer');
    await orders.businessTransition({ sub: uuids.owner }, answered.id, 'CONFIRMED', 20);
    const filed = await orders.cancel({ sub: uuids.customer }, answered.id, { reason: 'امشب وقت ندارم، لطفاً لغو کنید' });
    assert.equal(filed.status, 'CONFIRMED', 'a queued request must not move the order');
    assert.equal(filed.outcome, 'PENDING');
    assert.equal((await orders.detail({ sub: uuids.customer }, answered.id)).status, 'CONFIRMED');

    await assert.rejects(orders.cancel({ sub: uuids.owner }, answered.id), /پیدا نشد/);
  });

  /**
   * Feedback and support are the newest SQL in the system, and their interesting parts are
   * database features — `ON CONFLICT`, a partial unique index, `FOR UPDATE OF o` — that a
   * stubbed pool cannot prove. This runs on the order the flow above already delivered, so no
   * extra order is placed and the money counts in that test stay true.
   */
  it('rates a delivered order and argues a support thread in real SQL', async () => {
    const delivered = await rows(`SELECT id FROM orders WHERE status='DELIVERED' ORDER BY created_at LIMIT 1`);
    const orderId = delivered[0].id as string;

    const customer = { sub: uuids.customer, roles: ['CUSTOMER'] };
    const staff = { sub: uuids.admin, roles: ['SUPER_ADMIN'] };
    const shop = { sub: uuids.owner, roles: ['BUSINESS_OWNER'] };

    await assert.rejects(feedback.save(shop, orderId, { businessRating: 4 }), /پیدا نشد یا به این حساب مربوط نیست/);
    const first = await feedback.save(customer, orderId, { businessRating: 2, driverRating: 5, comment: 'غذا سرد رسید   ولی بسته‌بندی خوب بود.' });
    assert.equal(first.created, true);
    assert.equal(first.comment, 'غذا سرد رسید ولی بسته‌بندی خوب بود.', 'runs of whitespace are folded before storing');
    assert.equal((await feedback.forOrder(customer, orderId))?.id, first.id);

    const revised = await feedback.save(customer, orderId, { businessRating: 4, driverRating: 3, comment: 'دفعهٔ دوم راضی‌کننده بود.' });
    assert.deepEqual({ id: revised.id, created: revised.created }, { id: first.id, created: false }, 'an edit replaces the same row');
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM order_feedback WHERE order_id=$1`, [orderId]))[0].c, 1);
    assert.equal((await feedback.forOrder(shop, orderId))?.businessRating, 4, 'the shop reads the thread of its own order');

    const report = await feedback.forBusiness(shop, uuids.business, '5', '0');
    assert.deepEqual({ count: report.feedbackCount, average: report.averageBusinessRating, attention: report.needsAttention }, { count: 1, average: 4, attention: 0 }, 'the revision must not be counted twice');
    assert.equal(report.items[0].authorName, 'مشتری آزمون');
    await assert.rejects(feedback.forBusiness({ sub: uuids.driver, roles: ['DRIVER'] }, uuids.business), NotFoundException);
    const driving = await feedback.forDriver({ sub: uuids.driver, roles: ['DRIVER'] });
    assert.deepEqual({ count: driving.feedbackCount, average: driving.averageDriverRating }, { count: 1, average: 3 }, 'the courier is scored on the revised value, not the first one');
    await feedback.save(customer, orderId, { businessRating: 4, comment: 'بدون نظر دربارهٔ پیک.' });
    assert.deepEqual(await feedback.forDriver({ sub: uuids.driver, roles: ['DRIVER'] }).then(row => ({ count: row.feedbackCount, average: row.averageDriverRating })), { count: 0, average: null }, 'PUT replaces the record, so leaving the courier stars out clears them');
    await feedback.save(customer, orderId, { businessRating: 4, driverRating: 3, comment: 'دفعهٔ دوم راضی‌کننده بود.' });

    const notices = await rows(`SELECT COUNT(*)::int AS c FROM notifications WHERE user_id=$1 AND event_type='ORDER_FEEDBACK'`, [uuids.owner]);
    assert.equal(notices[0].c, 1, 'a two-star comment reaches the owner once, and the edits do not ping again');
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM notifications WHERE user_id=$1 AND event_type='DRIVER_FEEDBACK'`, [uuids.driver]))[0].c, 1);

    const ticket = await support.open(customer, { orderId, message: 'سفارش دیر و سرد رسید؛ می‌خواهم مبلغ ارسال برگردد.' });
    assert.equal(ticket.status, 'OPEN');
    await assert.rejects(support.open(customer, { orderId, message: 'همان مشکل را دوباره می‌نویسم تا در صف بماند.' }), /گفت‌وگوی بازی/);
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM support_tickets WHERE order_id=$1`, [orderId]))[0].c, 1);

    const thread = await support.detail(shop, ticket.id);
    assert.equal(thread.canReply, true, 'the shop is a party to the order');
    assert.equal(thread.canChangeStatus, false, 'but it is not support staff');
    await assert.rejects(support.setStatus(shop, ticket.id, { status: 'CLOSED' }), /کادر پشتیبانی|فقط/);
    await assert.rejects(support.detail({ sub: uuids.stranger, roles: ['CUSTOMER'] }, ticket.id), NotFoundException, 'another customer is not a party to this thread');

    assert.equal((await support.reply(staff, ticket.id, { message: 'بررسی می‌کنیم؛ مبلغ تا دو روز کاری برگردد.' })).status, 'IN_REVIEW', 'a first staff answer pulls the thread out of the open pile');
    await assert.rejects(support.setStatus(staff, ticket.id, { status: 'RESOLVED' }), /توضیح کوتاه لازم است/);
    assert.equal((await support.setStatus(staff, ticket.id, { status: 'RESOLVED', note: 'مبلغ ارسال به کیف پول شما برگشت.' })).status, 'RESOLVED');
    assert.equal((await support.reply(customer, ticket.id, { message: 'هنوز چیزی در کیف پول نیست.' })).status, 'OPEN', 'the reporter answering a resolved thread reopens it');

    const statusRows = await rows(`SELECT action,metadata FROM audit_logs WHERE action='SUPPORT_TICKET_STATUS' AND entity_id=$1 ORDER BY created_at,id`, [ticket.id]);
    assert.deepEqual(statusRows.map(row => `${row.metadata.from}>${row.metadata.to}`), ['OPEN>IN_REVIEW', 'IN_REVIEW>RESOLVED', 'RESOLVED>OPEN'], 'the automatic moves caused by replies are audited like the manual ones');

    const queue = await support.queue({ status: 'OPEN', search: '09120000001' });
    assert.equal(queue.items[0].id, ticket.id, 'searching by the reporter number finds the thread');
    assert.deepEqual({ tail: queue.items[0].authorTail, business: queue.items[0].businessName, messages: queue.items[0].messageCount }, { tail: '0001', business: 'رستوران آزمون', messages: 3 }, 'the queue shows four digits of the number, not the number');
    assert.equal((await support.queue({ status: 'OPEN' })).counts.OPEN, 1);

    assert.equal((await support.setStatus(customer, ticket.id, { status: 'CLOSED' })).status, 'CLOSED', 'a reporter may close what they opened');
    await assert.rejects(support.reply(staff, ticket.id, { message: 'پاسخ بعد از بسته شدن' }), /بسته شده/);
    const freed = await support.open(customer, { orderId, message: 'همان موضوع دوباره پیش آمده و این‌بار مبلغ اصلاً نیامده.' });
    assert.notEqual(freed.id, ticket.id, 'closing releases the unique slot for a genuine repeat');
    assert.deepEqual((await support.mine(customer, { status: 'CLOSED' })).items.map(item => item.id), [ticket.id]);

    await assert.rejects(feedback.remove(staff, first.id, ''), /دلیل/);
    assert.equal((await feedback.remove(staff, first.id, 'توهین به پرسنل در توضیحات')).removed, true, 'a reason makes the deletion legal');
    assert.equal((await feedback.forBusiness(shop, uuids.business)).feedbackCount, 0, 'a removed rating leaves the average');
    const removal = (await rows(`SELECT metadata FROM audit_logs WHERE action='FEEDBACK_REMOVED' AND entity_id=$1`, [first.id]))[0].metadata as { reason: string; removedBy: string };
    assert.deepEqual({ reason: removal.reason, removedBy: removal.removedBy }, { reason: 'توهین به پرسنل در توضیحات', removedBy: 'SUPER_ADMIN' }, 'the reason and the role that used it are what the log has to carry');
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM order_feedback WHERE order_id=$1`, [orderId]))[0].c, 0);
  });
  /**
   * §7.11 in real SQL. The queue, the VOIDED branch, the one-open-request index and the refund
   * ledger are all database features — a partial unique index, a CHECK that ties a row's sign to
   * its kind, a single-row policy table — that a stubbed pool can only pretend to enforce.
   */
  it('holds a cancellation queue and an append-only refund ledger in the database itself', async () => {
    const customer = { sub: uuids.customer, roles: ['CUSTOMER'] };
    const shop = { sub: uuids.owner, roles: ['BUSINESS_OWNER'] };
    const staff = { sub: uuids.admin, roles: ['SUPER_ADMIN'] };
    const outsider = { sub: uuids.stranger, roles: ['CUSTOMER'] };

    const order = await placeOrder('flow-queue');
    await orders.businessTransition(shop, order.id, 'CONFIRMED', 25);
    const filed = await orders.cancel(customer, order.id, { reason: 'سفارش را اشتباهی ثبت کردم' });
    assert.equal(filed.outcome, 'PENDING');
    await assert.rejects(orders.cancel(customer, order.id, { reason: 'دوباره، همان درخواست' }), /یک درخواست لغو باز/);
    await assert.rejects(pool.query(`INSERT INTO cancellation_requests(order_id,requested_by,reason) VALUES($1,$2,'تکرار')`, [order.id, uuids.customer]), /duplicate key value/, 'the partial unique index is the backstop, not only the service check');

    const queue = await cancellations.queue({});
    const mine = queue.items.find(item => item.orderId === order.id)!;
    assert.equal(mine.outcome, 'PENDING');
    assert.equal(mine.requesterTail, '0001', 'the queue shows a customer by the last digits of their number');

    const view = await cancellations.forOrder(customer, order.id);
    assert.deepEqual({ selfServe: view.selfServe, cancellable: view.cancellable, awaitingAnswer: view.awaitingAnswer, reason: view.requests[0].reason }, { selfServe: false, cancellable: true, awaitingAnswer: true, reason: 'سفارش را اشتباهی ثبت کردم' }, 'the order can still be cancelled, but only after an answer');
    assert.equal((await cancellations.forOrder(shop, order.id)).requests.length, 1, 'the shop is told what was asked of it');
    await assert.rejects(cancellations.forOrder(outsider, order.id), /پیدا نشد یا به این حساب مربوط نیست/);

    await assert.rejects(cancellations.decideRequest(staff, mine.id, { decision: 'REJECT' }), /دلیل لازم است/);
    await assert.rejects(cancellations.decideRequest(outsider, mine.id, { decision: 'ACCEPT', note: 'لغو شود' }), /پاسخ به این درخواست/);
    const rejected = await cancellations.decideRequest(staff, mine.id, { decision: 'REJECT', note: 'آش آماده است؛ لطفاً تحویل را بپذیرید' });
    assert.deepEqual({ outcome: rejected.outcome, status: rejected.status }, { outcome: 'REJECTED', status: 'CONFIRMED' }, 'a refusal answers the request without touching the order');
    assert.equal((await rows(`SELECT note,decided_by FROM cancellation_requests WHERE id=$1`, [mine.id]))[0].note, 'آش آماده است؛ لطفاً تحویل را بپذیرید');
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM notifications WHERE user_id=$1 AND event_type='ORDER_CANCELLATION_DECIDED'`, [uuids.customer]))[0].c, 1, 'exactly one answer, announced once');

    const second = await orders.cancel(customer, order.id, { reason: 'تحویل دیر انجام می‌شود' });
    assert.equal(second.outcome, 'PENDING', 'a new request may follow an answer');
    const reopened = await cancellations.queue({ outcome: 'PENDING', search: order.id.slice(0, 8) });
    assert.equal(reopened.totalMatches, 1, 'the queue finds an order by the head of its id');
    const answered = await cancellations.decideRequest(shop, reopened.items[0].id, { decision: 'ACCEPT' });
    assert.equal(answered.status, 'CANCELLED');
    assert.equal((await rows(`SELECT to_status FROM order_status_history WHERE order_id=$1 AND reason IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [order.id]))[0].to_status, 'CANCELLED', 'the cancellation is the row that carries a reason');
    const decidedRow = (await rows(`SELECT outcome,decided_by FROM cancellation_requests WHERE id=$1`, [reopened.items[0].id]))[0];
    assert.deepEqual({ outcome: decidedRow.outcome, by: decidedRow.decided_by }, { outcome: 'ACCEPTED', by: uuids.owner });
    // the §7.11 trail on this order: two requests, two answers, and one status move
    const actions = (await rows(`SELECT action FROM audit_logs WHERE entity_id=$1`, [order.id])).map(row => row.action);
    for (const action of ['ORDER_CANCEL_REQUESTED', 'ORDER_CANCELLATION_DECIDED', 'ORDER_CANCELLED']) {
      assert.ok(actions.includes(action), `${action} must stay auditable on the order it belongs to`);
    }
    assert.deepEqual({ requests: actions.filter(action => action === 'ORDER_CANCEL_REQUESTED').length, answers: actions.filter(action => action === 'ORDER_CANCELLATION_DECIDED').length }, { requests: 2, answers: 2 }, 'each request and each answer is one row');
    assert.equal((await rows(`SELECT metadata->>'orderStatus' AS at FROM audit_logs WHERE entity_id=$1 AND action='ORDER_CANCELLATION_DECIDED' AND metadata->>'outcome'='ACCEPTED'`, [order.id]))[0].at, 'CONFIRMED', 'the audit row remembers the status the answer was given on');

    const doomed = await placeOrder('flow-voided');
    await orders.businessTransition(shop, doomed.id, 'CONFIRMED', 15);
    await orders.cancel(customer, doomed.id, { reason: 'پشیمان شدم، سفارش را لغو کنید' });
    await pool.query(`UPDATE orders SET status='DELIVERED' WHERE id=$1`, [doomed.id]);
    const voided = await cancellations.decideRequest(staff, (await cancellations.forOrder(customer, doomed.id)).requests[0].id, { decision: 'ACCEPT' });
    assert.deepEqual({ outcome: voided.outcome, status: voided.status }, { outcome: 'VOIDED', status: 'DELIVERED' }, 'a late answer must not resurrect a closed order');
    assert.equal((await rows(`SELECT status FROM orders WHERE id=$1`, [doomed.id]))[0].status, 'DELIVERED');

    const paid = (await rows(`SELECT o.id FROM orders o JOIN cash_collections cc ON cc.order_id=o.id LIMIT 1`))[0].id as string;
    const collected = BigInt((await rows(`SELECT amount_rial FROM cash_collections WHERE order_id=$1`, [paid]))[0].amount_rial as string);
    const half = Number(collected / 2n);
    assert.equal((await cancellations.refunds(customer, paid)).refundedRial, '0');
    await assert.rejects(cancellations.recordRefund(shop, paid, { requestKey: randomUUID(), amountRial: 1000, reason: 'کسب‌وکار به خودش refund می‌دهد' }), /فقط با کادر عملیات/);
    const wallet = new WalletService(pool);
    const firstRequest = { requestKey: randomUUID(), amountRial: half, reason: 'یک بسته از دو بسته نرسید', fundedBy: 'BUSINESS' };
    const first = await cancellations.recordRefund(staff, paid, firstRequest);
    assert.equal((await cancellations.recordRefund(staff, paid, firstRequest)).duplicate, true);
    await assert.rejects(cancellations.recordRefund(staff, paid, {...firstRequest, amountRial: half-1}), /شناسه/);
    assert.equal((await wallet.mine(customer)).balanceRial, String(half));
    assert.deepEqual(await wallet.mine({sub: uuids.stranger}), {balanceRial:'0',items:[]});
    await assert.rejects(cancellations.recordRefund(staff, order.id, {requestKey: randomUUID(), amountRial: 1, reason:'وجهی وصول نشده است'}), /وجهی از مشتری دریافت نشده/);
    assert.deepEqual({ status: first.paymentStatus, refundable: first.refundableRial }, { status: 'PAID', refundable: String(collected - BigInt(half)) }, 'a partial refund leaves the order owed money');
    await assert.rejects(cancellations.recordRefund(staff, paid, { requestKey: randomUUID(), amountRial: half + 1, reason: 'بیش از باقی‌مانده' }), new RegExp(`سقف بازپرداخت این سفارش ${collected - BigInt(half)} ریال است`));
    const cleared = await cancellations.recordRefund(staff, paid, { requestKey: randomUUID(), amountRial: half, reason: 'بستهٔ دوم هم نرسید' });
    assert.equal(cleared.paymentStatus, 'REFUNDED');
    assert.equal((await rows(`SELECT payment_status FROM orders WHERE id=$1`, [paid]))[0].payment_status, 'REFUNDED');
    await assert.rejects(cancellations.recordRefund(staff, paid, { requestKey: randomUUID(), amountRial: 1, reason: 'چیزی نمانده' }), /سقف بازپرداخت این سفارش 0 ریال است/);
    const clawed = await cancellations.recordRefund(staff, paid, { requestKey: randomUUID(), amountRial: -500000, reason: 'بستهٔ دوم در واقع رسید', fundedBy: 'DRIVER' });
    assert.deepEqual({ kind: clawed.kind, status: clawed.paymentStatus, refundable: clawed.refundableRial }, { kind: 'CORRECTION', status: 'PAID', refundable: '500000' }, 'a mistake is answered by another row, never by editing the first');
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM order_refunds WHERE order_id=$1`, [paid]))[0].c, 3);
    const walletResult = await wallet.mine(customer);
    assert.equal(walletResult.balanceRial, String(collected-500000n));
    assert.equal(walletResult.items.length, 3);
    assert.equal(walletResult.items.filter(item => item.kind === 'CORRECTION')[0].amountRial, '-500000');
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM notifications WHERE user_id=$1 AND event_type='ORDER_REFUNDED'`, [uuids.customer]))[0].c, 3, 'every ledger row is announced');
    await assert.rejects(pool.query(`INSERT INTO order_refunds(order_id,amount_rial,kind,funded_by,reason,created_by) VALUES($1,5000,'CORRECTION','PLATFORM','منفی باید منفی باشد',$2)`, [paid, uuids.admin]), /violates check constraint/);
    await assert.rejects(pool.query(`INSERT INTO order_refunds(order_id,amount_rial,kind,funded_by,reason,created_by) VALUES($1,0,'REFUND','PLATFORM','صفر معنا ندارد',$2)`, [paid, uuids.admin]), /violates check constraint/);

    // Two independent database connections race on the same order. The lock must
    // be acquired before taking the snapshot used for refund totals.
    const same = {requestKey: randomUUID(), amountRial: 100000, reason: 'آزمون تکرار بازپرداخت'};
    const retried = await Promise.all([cancellations.recordRefund(staff, paid, same), cancellations.recordRefund(staff, paid, same)]);
    assert.equal(retried.filter(result => result.duplicate).length, 1);
    const race = await Promise.allSettled([
      cancellations.recordRefund(staff, paid, {requestKey: randomUUID(), amountRial: 300000, reason: 'بازپرداخت همزمان اول'}),
      cancellations.recordRefund(staff, paid, {requestKey: randomUUID(), amountRial: 300000, reason: 'بازپرداخت همزمان دوم'}),
    ]);
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await cancellations.refunds(customer, paid)).refundableRial, '100000');
    assert.equal((await wallet.mine(customer)).balanceRial, String(collected-100000n));

    const widened = await cancellations.setPolicy(staff, { autoCancelStatuses: ['PENDING_BUSINESS', 'CONFIRMED'], windowMinutes: 30 });
    assert.deepEqual(widened, { autoCancelStatuses: ['PENDING_BUSINESS', 'CONFIRMED'], windowMinutes: 30 });
    const moved = await placeOrder('flow-widened');
    await orders.businessTransition(shop, moved.id, 'CONFIRMED', 10);
    assert.deepEqual(await orders.cancel(customer, moved.id), { id: moved.id, status: 'CANCELLED' }, 'the same status turns self-service the moment the rule is widened');
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM cancellation_requests WHERE order_id=$1 AND outcome='PENDING'`, [moved.id]))[0].c, 0);
    const policyRow = (await rows(`SELECT auto_statuses,window_minutes,updated_by FROM cancellation_policies WHERE id=1`))[0];
    assert.deepEqual({ auto: policyRow.auto_statuses, minutes: policyRow.window_minutes, by: policyRow.updated_by }, { auto: 'PENDING_BUSINESS,CONFIRMED', minutes: 30, by: uuids.admin });
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM audit_logs WHERE entity_type='CANCELLATION_POLICY'`))[0].c, 1);
    await assert.rejects(pool.query(`INSERT INTO cancellation_policies(id,window_minutes) VALUES(2,5)`), /violates check constraint/, 'one platform, one rule row');
    await assert.rejects(pool.query(`UPDATE cancellation_policies SET window_minutes=2000 WHERE id=1`), /violates check constraint/, 'a window cannot be longer than a day');
    assert.match((await cancellations.refunds(customer, paid)).refundableRial, /^\d+$/, 'the ledger view stays a decimal string');
  });


  it('queues every notification once and records what the push channel did', async () => {
    // a recipient nobody else writes to, so the queue this test sees is exactly the queue it made
    const recipient = uuids.stranger;
    let sendResult: { state: 'SENT' | 'FAILED' | 'SKIPPED'; error?: string | null; permanent?: boolean } = { state: 'SENT', error: null };
    const deliveries = new NotificationDeliveryService(pool, {
      resolve: async () => ({ kind: 'local', send: async () => sendResult }),
      isConfigured: () => true,
      describe: () => ({ configured: true, vapidReady: true, subject: 'mailto:ops@jetino.app', allowLocal: false }),
      requirePublicKey: () => 'BPublic_Key_For_The_Integration_Run',
    } as never);
    const channelsOf = async (notificationId: string | null) =>
      (await rows(`SELECT channel FROM notification_deliveries WHERE notification_id=$1 ORDER BY channel`, [notificationId])).map((row) => row.channel as string);
    const pushRowOf = async (notificationId: string) =>
      (await rows(`SELECT id, state, attempts, last_error, next_attempt_at > now() AS waiting FROM notification_deliveries WHERE notification_id=$1 AND channel='PUSH'`, [notificationId]))[0];
    const requeue = (notificationId: string) =>
      pool.query(`UPDATE notification_deliveries SET state='PENDING', attempts=0, next_attempt_at=now() WHERE notification_id=$1 AND channel='PUSH'`, [notificationId]);

    // 1. an inbox row always has a delivery row beside it, even with no browser registered
    const plain = await notify(pool, recipient, 'ORDER_CONFIRMED', 'سفارش تأیید شد', 'تأیید شد.', { orderId: 'flow-1' });
    assert.ok(plain.id, 'notify returns the row it wrote');
    assert.deepEqual(await channelsOf(plain.id), ['IN_APP'], 'no push row without a subscription');
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM notification_deliveries WHERE notification_id=$1 AND state='SENT'`, [plain.id]))[0].c, 0, 'nothing has been dispatched yet');

    // 2. the same browser re-subscribing is an update, not a second target
    const subscription = { endpoint: 'https://push.example.com/s/integration-run', p256dh: 'B'.repeat(40), auth: 'a'.repeat(40), userAgent: 'Chrome' };
    const first = await deliveries.upsertSubscription(recipient, subscription);
    const second = await deliveries.upsertSubscription(recipient, { ...subscription, p256dh: 'c'.repeat(40) });
    assert.deepEqual({ created: first.created, sameId: second.id === first.id, renewed: second.created }, { created: true, sameId: true, renewed: false });
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM push_subscriptions`))[0].c, 1, 'a subscription is identified by its endpoint');
    await assert.rejects(deliveries.upsertSubscription(recipient, { ...subscription, endpoint: 'http://push.example.com/1' }), /معتبر نیست/);

    // 3. duplicate control: the same event for the same key is stored once, and queued once
    const ticket = await notify(pool, recipient, 'SUPPORT_TICKET_OPENED', 'گزارش', 'متن', { ticketId: 't-1' }, { dedupeKey: 't-1' });
    const repeat = await notify(pool, recipient, 'SUPPORT_TICKET_OPENED', 'گزارش', 'متن', { ticketId: 't-1' }, { dedupeKey: 't-1' });
    assert.deepEqual({ deduped: repeat.deduped, id: repeat.id }, { deduped: true, id: null });
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM notifications WHERE dedupe_key='t-1'`))[0].c, 1);
    // the first insert queued one row per channel; the suppressed duplicate could not add a third
    assert.deepEqual(await channelsOf(ticket.id), ['IN_APP', 'PUSH'], 'a suppressed duplicate cannot queue a second send');

    // 4. one dispatch sends every due row once, and a second pass has nothing to say
    const pushed = await notify(pool, recipient, 'ORDER_PREPARING', 'آماده‌سازی', 'در حال پخت.', { orderId: 'flow-3' });
    assert.ok(pushed.id);
    assert.deepEqual(await channelsOf(pushed.id), ['IN_APP', 'PUSH'], 'the active subscription is queued for the new event');
    const pass = await deliveries.dispatch();
    assert.ok(pass.claimed >= 4, `claimed ${pass.claimed}`);
    assert.deepEqual({ sent: pass.sent, failed: pass.failed, skipped: pass.skipped }, { sent: pass.claimed, failed: 0, skipped: 0 });
    assert.deepEqual(await deliveries.dispatch(), { due: 0, claimed: 0, sent: 0, failed: 0, skipped: 0, exhausted: 0, detached: 0, sender: 'local' }, 'a second pass sends nothing twice');
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM notification_deliveries WHERE state='SENT' AND sent_at IS NULL`))[0].c, 0);
    const sentRow = await pushRowOf(pushed.id!);
    assert.deepEqual({ state: sentRow.state, attempts: Number(sentRow.attempts), error: sentRow.last_error }, { state: 'SENT', attempts: 1, error: null });

    // 5. a transient failure keeps the row queued with a backoff instead of failing it
    await requeue(pushed.id!);
    sendResult = { state: 'FAILED', error: 'socket hang up' };
    const failing = await deliveries.dispatch();
    assert.deepEqual({ claimed: failing.claimed, failed: failing.failed, exhausted: failing.exhausted }, { claimed: 1, failed: 1, exhausted: 0 });
    const waiting = await pushRowOf(pushed.id!);
    assert.deepEqual({ state: waiting.state, attempts: Number(waiting.attempts), error: waiting.last_error, waiting: waiting.waiting },
      { state: 'PENDING', attempts: 1, error: 'socket hang up', waiting: true }, 'the retry is due later, not immediately');
    await assert.rejects(deliveries.retryDelivery(String(waiting.id)), NotFoundException, 'only a failed row is worth re-queueing');

    // 6. the attempt ceiling turns a queued row into a permanent failure
    await pool.query(`UPDATE notification_deliveries SET attempts=4, next_attempt_at=now() WHERE notification_id=$1 AND channel='PUSH'`, [pushed.id]);
    const exhausted = await deliveries.dispatch();
    assert.equal(exhausted.exhausted, 1);
    assert.deepEqual({ state: (await pushRowOf(pushed.id!)).state, attempts: Number((await pushRowOf(pushed.id!)).attempts) }, { state: 'FAILED', attempts: 5 });

    // 7. a subscription the push service rejects is deactivated, and stops being queued for
    await requeue(pushed.id!);
    sendResult = { state: 'FAILED', error: 'push service rejected the subscription (HTTP 410)', permanent: true };
    const detached = await deliveries.dispatch();
    assert.deepEqual({ claimed: detached.claimed, failed: detached.failed, detached: detached.detached }, { claimed: 1, failed: 1, detached: 1 });
    const subscriptionRow = (await rows(`SELECT active, failures FROM push_subscriptions WHERE endpoint=$1`, [subscription.endpoint]))[0];
    assert.deepEqual({ active: subscriptionRow.active, failures: Number(subscriptionRow.failures) }, { active: false, failures: 1 });
    const afterDeath = await notify(pool, recipient, 'ORDER_DELIVERED', 'تحویل', 'دوباره.', { orderId: 'flow-4' });
    assert.deepEqual(await channelsOf(afterDeath.id), ['IN_APP'], 'a dead subscription is not queued again');

    // 8. staff counters, a manual retry, and a customer who can only read their own row
    const stats = await deliveries.stats();
    assert.deepEqual({ active: stats.subscriptions.active, total: stats.subscriptions.total, pushReady: stats.sender.configured }, { active: 0, total: 1, pushReady: true });
    assert.ok(stats.push.failed >= 1 && stats.push.sent >= 1, JSON.stringify(stats.push));
    const failedRow = await pushRowOf(pushed.id!);
    assert.deepEqual(await deliveries.retryDelivery(String(failedRow.id)), { retried: 1 });
    assert.deepEqual({ state: (await pushRowOf(pushed.id!)).state, attempts: Number((await pushRowOf(pushed.id!)).attempts) }, { state: 'PENDING', attempts: 0 });
    const queue = await deliveries.recentDeliveries('SENT');
    assert.ok(queue.items.length >= 1 && queue.items.every((item: { state: string }) => item.state === 'SENT'));
    await assert.rejects(deliveries.deliveryForNotification(uuids.owner, pushed.id!), NotFoundException);
    const own = await deliveries.deliveryForNotification(recipient, pushed.id!);
    assert.deepEqual(own.deliveries.map((row: { channel: string }) => row.channel), ['IN_APP', 'PUSH']);
    assert.equal(own.push.state, 'PENDING', 'a re-queued row is owed again');

    // 9. event targeting: a muted group still lands in the inbox, it just is not pushed
    await pool.query(`UPDATE push_subscriptions SET active=true`);
    await deliveries.setPreferences(recipient, { groups: ['SUPPORT', 'SETTLEMENT'] });
    const muted = await notify(pool, recipient, 'ORDER_READY_FOR_PICKUP', 'آماده', 'بیایید.', { orderId: 'flow-5' });
    assert.deepEqual(await channelsOf(muted.id), ['IN_APP']);
    const kept = await notify(pool, recipient, 'SUPPORT_TICKET_MESSAGE', 'پاسخ', 'متن.', { ticketId: 't-2' });
    assert.deepEqual(await channelsOf(kept.id), ['IN_APP', 'PUSH']);
    assert.equal(
      (await rows(`SELECT COUNT(*)::int AS c FROM push_event_opt_outs WHERE user_id=$1`, [recipient]))[0].c,
      allPushEventTypes().length - 5,
      'every event outside the two kept groups is muted, one row each',
    );
    await deliveries.setPreferences(recipient, { groups: ['ORDER_STATUS', 'ORDER_CANCELLATION', 'DELIVERY', 'FEEDBACK', 'SUPPORT', 'SETTLEMENT', 'SHOP'] });
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM push_event_opt_outs`))[0].c, 0, 'enabling every group clears the opt-outs');
    await deliveries.unsubscribe(recipient, { endpoint: subscription.endpoint });
    assert.equal((await rows(`SELECT COUNT(*)::int AS c FROM push_subscriptions`))[0].c, 0);
  });

});

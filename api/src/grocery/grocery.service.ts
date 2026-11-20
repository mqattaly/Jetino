import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { notify } from '../notifications/notifications.util';
import { parseImageUrl } from '../security/security.util';
import { RateLimitService } from '../security/rate-limit.service';
import { staffIds, STAFF_ROLES } from '../cancellations/cancellation-writes';

type Principal = { sub: string; roles?: string[] };
type Setting = { value_int: string; value_text: string | null };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CARD_PATTERN = /^\d{16}$/;
const isStaff = (user: Principal) => STAFF_ROLES.some(role => user.roles?.includes(role));
const MIN_FEE = 10_000;
const MAX_FEE = 50_000_000;
const MAX_INVOICE = 500_000_000;

function digits(value: unknown): string {
  const text = String(value ?? '').trim()
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  return text.replace(/[\s,٬]/g, '');
}

/**
 * The text-shopping mission: the customer writes a list, couriers of the region bid a mission fee,
 * the customer accepts one, the courier buys and sends the invoice with the shop's card number,
 * the customer pays by card-to-card and uploads the receipt, and the courier confirms it with the
 * seller before the goods are handed over.
 */
@Injectable()
export class GroceryService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(RateLimitService) private readonly rateLimit: RateLimitService) {}

  private static amount(value: unknown, label: string, min: number, max: number): number {
    const text = digits(value);
    if (!/^\d+$/.test(text)) throw new BadRequestException(`${label} باید یک عدد صحیح به ریال باشد.`);
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new BadRequestException(`${label} باید بین ${new Intl.NumberFormat('fa-IR').format(min)} و ${new Intl.NumberFormat('fa-IR').format(max)} ریال باشد.`);
    }
    return parsed;
  }

  private static text(value: unknown, label: string, min: number, max: number, required = true): string | null {
    if (value === undefined || value === null) {
      if (required) throw new BadRequestException(`${label} الزامی است.`);
      return null;
    }
    if (typeof value !== 'string') throw new BadRequestException(`${label} معتبر نیست.`);
    const text = value.replace(/\r\n/g, '\n').trim();
    if (!text && !required) return null;
    if (text.length < min || text.length > max) throw new BadRequestException(`${label} باید بین ${min} تا ${max} نویسه باشد.`);
    return text;
  }

  private static cardNumber(value: unknown, required: boolean): string | null {
    if (value === undefined || value === null || value === '') {
      if (required) throw new BadRequestException('شمارهٔ کارت فروشگاه الزامی است.');
      return null;
    }
    const text = digits(value);
    if (!CARD_PATTERN.test(text)) throw new BadRequestException('شمارهٔ کارت باید ۱۶ رقم باشد.');
    return text;
  }

  private async settings(queryable: { query: Pool['query'] }) {
    const result = await queryable.query(`SELECT key,value_int,value_text FROM platform_settings WHERE key = ANY($1::text[])`, [
      ['grocery_bid_minutes', 'grocery_payment_minutes', 'grocery_revenue_mode', 'grocery_fee_bps', 'grocery_goods_bps', 'grocery_fixed_rial'],
    ]) as { rows: Array<Setting & { key: string }> };
    const map = new Map(result.rows.map(row => [row.key, row]));
    const minutes = (key: string, fallback: number) => {
      const value = Number(map.get(key)?.value_int ?? fallback);
      return Number.isFinite(value) && value >= 1 && value <= 240 ? value : fallback;
    };
    return {
      bidMinutes: minutes('grocery_bid_minutes', 15),
      paymentMinutes: minutes('grocery_payment_minutes', 15),
      revenueMode: (map.get('grocery_revenue_mode')?.value_text ?? 'NONE') as 'NONE' | 'FEE_PERCENT' | 'GOODS_PERCENT' | 'FIXED',
      feeBps: Number(map.get('grocery_fee_bps')?.value_int ?? 1000),
      goodsBps: Number(map.get('grocery_goods_bps')?.value_int ?? 0),
      fixedRial: BigInt(map.get('grocery_fixed_rial')?.value_int ?? 0),
    };
  }

  /** The courier behind a request; every driver-only action goes through this gate. */
  private async driverContext(user: Principal, queryable: { query: Pool['query'] } = this.pool) {
    const result = await queryable.query(
      `SELECT d.id,d.region_id AS "regionId",d.status,d.verification_status AS verification
       FROM drivers d WHERE d.user_id=$1`, [user.sub]);
    if (!result.rowCount) throw new ForbiddenException('فقط پیک‌های ثبت‌شده می‌توانند پیشنهاد بدهند.');
    const row = result.rows[0] as { id: string; regionId: string; status: string; verification: string };
    if (row.status !== 'ACTIVE') throw new ForbiddenException('حساب پیک شما فعال نیست.');
    const gate = await queryable.query(`SELECT value_int FROM platform_settings WHERE key='require_driver_verification'`);
    const requireVerified = Number(gate.rows[0]?.value_int ?? 0) === 1;
    if (requireVerified && row.verification !== 'APPROVED') throw new ForbiddenException('برای دریافت ماموریت، تأیید مدارک هویتی لازم است.');
    return row;
  }

  /** A bid that was never accepted must stop blocking the list once its window closes. */
  private async expireStale(queryable: { query: Pool['query'] } = this.pool) {
    await queryable.query(`UPDATE grocery_bids SET status='EXPIRED',updated_at=now() WHERE status='PENDING' AND list_id IN (SELECT id FROM grocery_lists WHERE status='OPEN' AND bid_deadline_at < now())`);
    await queryable.query(`UPDATE grocery_lists SET status='EXPIRED',updated_at=now() WHERE status='OPEN' AND bid_deadline_at < now()`);
  }

  private shape(row: Record<string, unknown>) {
    return {
      ...row,
      feeRial: row.fee_rial === null || row.fee_rial === undefined ? null : String(row.fee_rial),
      invoiceAmountRial: row.invoice_amount_rial === null || row.invoice_amount_rial === undefined ? null : String(row.invoice_amount_rial),
      platformFeeRial: row.platform_fee_rial === null || row.platform_fee_rial === undefined ? null : String(row.platform_fee_rial),
    };
  }

  async create(user: Principal, body: { itemsText?: unknown; storeName?: unknown; note?: unknown; addressId?: unknown }, idempotencyKey?: string) {
    const itemsText = GroceryService.text(body?.itemsText, 'متن لیست خرید', 5, 2000)!;
    const storeName = GroceryService.text(body?.storeName, 'نام فروشگاه', 2, 160, false);
    const note = GroceryService.text(body?.note, 'توضیح', 2, 500, false);
    const addressId = typeof body?.addressId === 'string' && uuidPattern.test(body.addressId) ? body.addressId : null;
    if (!addressId) throw new BadRequestException('نشانی تحویل را انتخاب کنید.');
    const key = typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey.trim().slice(0, 120) : null;
    if (key && !/^[A-Za-z0-9:_-]+$/.test(key)) throw new BadRequestException('هدر Idempotency-Key معتبر نیست.');
    if (this.rateLimit) await this.rateLimit.enforce(`grocery.create:${user.sub}`, 10, 600, 'ثبت لیست خرید بیش از حد مجاز است.');

    const address = await this.pool.query(
      `SELECT a.id,a.address_text,a.instructions,a.latitude::text,a.longitude::text,a.region_id AS "regionId",r.is_active
       FROM addresses a JOIN regions r ON r.id=a.region_id WHERE a.id=$1 AND a.user_id=$2`, [addressId, user.sub]);
    if (!address.rowCount || address.rows[0].is_active === false) throw new NotFoundException('نشانی انتخاب‌شده پیدا نشد.');

    const settings = await this.settings(this.pool);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        const existing = await client.query(
          `SELECT id FROM grocery_lists WHERE customer_id=$1 AND idempotency_key=$2`, [user.sub, key]);
        if (existing.rowCount) {
          const detail = await this.detailFor(client, user, existing.rows[0].id as string);
          await client.query('COMMIT');
          return { ...detail, replayed: true };
        }
      }
      const inserted = await client.query(
        `INSERT INTO grocery_lists(customer_id,region_id,store_name,items_text,note,address_id,delivery_address_snapshot,
           delivery_instructions_snapshot,delivery_latitude_snapshot,delivery_longitude_snapshot,bid_deadline_at,idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+($11 || ' minutes')::interval,$12) RETURNING id`,
        [user.sub, address.rows[0].regionId, storeName, itemsText, note, addressId, address.rows[0].address_text,
          address.rows[0].instructions, address.rows[0].latitude, address.rows[0].longitude, String(settings.bidMinutes), key]);
      const id = inserted.rows[0].id as string;
      await client.query(
        `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'GROCERY_LIST_CREATED','GROCERY_LIST',$2,$3::jsonb)`,
        [user.sub, id, JSON.stringify({ bidMinutes: settings.bidMinutes, storeName })]);
      const detail = await this.detailFor(client, user, id);
      await client.query('COMMIT');
      return { ...detail, replayed: false };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    } finally { client.release(); }
  }

  private async detailFor(queryable: { query: Pool['query'] }, user: Principal, id: string) {
    const result = await queryable.query(
      `SELECT g.id,g.customer_id AS "customerId",g.store_name AS "storeName",g.items_text AS "itemsText",g.note,
              g.delivery_address_snapshot AS "addressText",g.delivery_instructions_snapshot AS instructions,
              g.status,g.bid_deadline_at AS "bidDeadlineAt",g.fee_rial,g.invoice_amount_rial,g.invoice_photo_url AS "invoicePhotoUrl",
              g.invoice_store_card AS "storeCard",g.invoice_store_holder AS "storeHolder",g.invoice_submitted_at AS "invoiceSubmittedAt",
              g.invoice_approved_at AS "invoiceApprovedAt",g.payment_method AS "paymentMethod",g.payment_receipt_url AS "paymentReceiptUrl",
              g.payment_reference AS "paymentReference",g.payment_declared_at AS "paymentDeclaredAt",g.payment_deadline_at AS "paymentDeadlineAt",
              g.payment_confirmed_at AS "paymentConfirmedAt",g.platform_fee_rial,g.cancel_reason AS "cancelReason",g.created_at AS "createdAt",
              d.user_id AS "driverUserId",du.display_name AS "driverName",d.phone AS "driverPhone",d.plate_number AS "driverPlate",d.vehicle_type AS "driverVehicle"
       FROM grocery_lists g
       LEFT JOIN drivers d ON d.id=g.driver_id
       LEFT JOIN users du ON du.id=d.user_id
       WHERE g.id=$1`, [id]);
    if (!result.rowCount) throw new NotFoundException('لیست خرید پیدا نشد.');
    const row = result.rows[0] as Record<string, unknown> & { customerId: string; driverUserId: string | null };
    const owner = row.customerId === user.sub;
    const courier = row.driverUserId === user.sub;
    if (!owner && !courier && !isStaff(user)) throw new NotFoundException('لیست خرید پیدا نشد.');
    const items = await queryable.query(
      `SELECT name,quantity::text AS quantity,unit,unit_price_rial AS "unitPriceRial",line_total_rial AS "lineTotalRial"
       FROM grocery_invoice_items WHERE list_id=$1 ORDER BY created_at`, [id]);
    const bids = await queryable.query(
      `SELECT b.id,b.amount_rial AS "amountRial",b.note,b.status,b.created_at AS "createdAt",
              du.display_name AS "driverName",d.plate_number AS "driverPlate",d.vehicle_type AS "driverVehicle",d.user_id AS "driverUserId"
       FROM grocery_bids b JOIN drivers d ON d.id=b.driver_id JOIN users du ON du.id=d.user_id
       WHERE b.list_id=$1 ORDER BY b.amount_rial ASC, b.created_at ASC`, [id]);
    // a courier only sees their own offer, never the competing prices
    const visibleBids = owner || isStaff(user)
      ? bids.rows
      : bids.rows
        .filter((bid: Record<string, unknown>) => bid.driverUserId === user.sub)
        .map(({ driverUserId: _ignored, ...bid }: Record<string, unknown>) => bid);
    return { ...this.shape(row), items: items.rows, bids: visibleBids, viewer: owner ? 'CUSTOMER' : courier ? 'DRIVER' : 'STAFF' };
  }

  async detail(user: Principal, id: string) {
    if (!uuidPattern.test(id)) throw new NotFoundException('لیست خرید پیدا نشد.');
    await this.expireStale();
    return this.detailFor(this.pool, user, id);
  }

  async mine(user: Principal) {
    await this.expireStale();
    const result = await this.pool.query(
      `SELECT g.id,g.store_name AS "storeName",g.items_text AS "itemsText",g.status,g.fee_rial AS "feeRial",
              g.invoice_amount_rial AS "invoiceAmountRial",g.bid_deadline_at AS "bidDeadlineAt",
              g.payment_deadline_at AS "paymentDeadlineAt",g.created_at AS "createdAt",
              (SELECT count(*) FROM grocery_bids b WHERE b.list_id=g.id AND b.status='PENDING')::int AS "bidCount"
       FROM grocery_lists g WHERE g.customer_id=$1 ORDER BY g.created_at DESC LIMIT 100`, [user.sub]);
    return { items: result.rows };
  }

  /** Open lists of the courier's own region, plus the ones already assigned to them. */
  async courierBoard(user: Principal) {
    const driver = await this.driverContext(user);
    await this.expireStale();
    const [open, assigned] = await Promise.all([
      this.pool.query(
        `SELECT g.id,g.store_name AS "storeName",g.items_text AS "itemsText",g.delivery_address_snapshot AS addressText,
                g.bid_deadline_at AS "bidDeadlineAt",g.created_at AS "createdAt",
                (SELECT count(*) FROM grocery_bids b WHERE b.list_id=g.id AND b.status='PENDING')::int AS "bidCount",
                mine.amount_rial AS "myBidRial"
         FROM grocery_lists g
         LEFT JOIN grocery_bids mine ON mine.list_id=g.id AND mine.driver_id=$2
         WHERE g.region_id=$1 AND g.status='OPEN' AND g.bid_deadline_at > now() AND mine.id IS NULL
         ORDER BY g.created_at DESC LIMIT 50`, [driver.regionId, driver.id]),
      this.pool.query(
        `SELECT g.id,g.store_name AS "storeName",g.store_name, g.items_text AS "itemsText",g.status,g.fee_rial AS "feeRial",
                g.invoice_amount_rial AS "invoiceAmountRial",g.delivery_address_snapshot AS addressText,
                g.payment_deadline_at AS "paymentDeadlineAt",g.created_at AS "createdAt"
         FROM grocery_lists g WHERE g.driver_id=$1 AND g.status IN ('ASSIGNED','SHOPPING','INVOICE_SENT','AWAITING_PAYMENT','PAID','PAYMENT_CONFIRMED')
         ORDER BY g.updated_at DESC LIMIT 50`, [driver.id]),
    ]);
    return { open: open.rows, assigned: assigned.rows };
  }

  async bid(user: Principal, id: string, body: { amountRial?: unknown; note?: unknown }) {
    if (!uuidPattern.test(id)) throw new NotFoundException('لیست خرید پیدا نشد.');
    const amount = GroceryService.amount(body?.amountRial, 'هزینهٔ پیشنهادی', MIN_FEE, MAX_FEE);
    const note = GroceryService.text(body?.note, 'توضیح پیشنهاد', 2, 200, false);
    const driver = await this.driverContext(user);
    await this.expireStale();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const list = await client.query(
        `SELECT id,customer_id,region_id,status,bid_deadline_at FROM grocery_lists WHERE id=$1 FOR UPDATE`, [id]);
      if (!list.rowCount) throw new NotFoundException('لیست خرید پیدا نشد.');
      const row = list.rows[0] as { customer_id: string; region_id: string; status: string; bid_deadline_at: Date };
      if (row.customer_id === user.sub) throw new BadRequestException('برای لیست خودتان نمی‌توانید پیشنهاد بدهید.');
      if (row.region_id !== driver.regionId) throw new ForbiddenException('این لیست در منطقهٔ شما نیست.');
      if (row.status !== 'OPEN') throw new ConflictException('این لیست دیگر پیشنهاد نمی‌پذیرد.');
      if (new Date(row.bid_deadline_at).getTime() <= Date.now()) throw new ConflictException('مهلت پیشنهاد این لیست تمام شده است.');
      const saved = await client.query(
        `INSERT INTO grocery_bids(list_id,driver_id,amount_rial,note) VALUES($1,$2,$3,$4)
         ON CONFLICT (list_id,driver_id) DO UPDATE SET amount_rial=EXCLUDED.amount_rial,note=EXCLUDED.note,updated_at=now()
         RETURNING id,amount_rial AS "amountRial",note,status`,
        [id, driver.id, amount, note]);
      await notify(client, row.customer_id, 'GROCERY_BID', 'پیشنهاد تازه برای لیست خرید',
        `یک پیک برای این لیست ${new Intl.NumberFormat('fa-IR').format(amount)} ریال پیشنهاد داد.`,
        { listId: id, bidId: saved.rows[0].id });
      await client.query('COMMIT');
      return saved.rows[0];
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    } finally { client.release(); }
  }

  async acceptBid(user: Principal, id: string, bidId: string) {
    if (!uuidPattern.test(id) || !uuidPattern.test(bidId)) throw new NotFoundException('پیشنهاد پیدا نشد.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const list = await client.query(`SELECT id,customer_id,status,bid_deadline_at FROM grocery_lists WHERE id=$1 FOR UPDATE`, [id]);
      if (!list.rowCount) throw new NotFoundException('لیست خرید پیدا نشد.');
      const row = list.rows[0] as { customer_id: string; status: string };
      if (row.customer_id !== user.sub) throw new NotFoundException('لیست خرید پیدا نشد.');
      if (row.status !== 'OPEN') throw new ConflictException('این لیست قبلاً پیک گرفته یا بسته شده است.');
      const bid = await client.query(
        `SELECT b.id,b.driver_id,b.amount_rial,d.user_id FROM grocery_bids b JOIN drivers d ON d.id=b.driver_id
         WHERE b.id=$1 AND b.list_id=$2 AND b.status='PENDING' FOR UPDATE OF b`, [bidId, id]);
      if (!bid.rowCount) throw new NotFoundException('این پیشنهاد در دسترس نیست.');
      const chosen = bid.rows[0] as { driver_id: string; amount_rial: string; user_id: string };
      await client.query(
        `UPDATE grocery_lists SET driver_id=$2,accepted_bid_id=$3,fee_rial=$4,status='ASSIGNED',updated_at=now() WHERE id=$1`,
        [id, chosen.driver_id, bidId, chosen.amount_rial]);
      await client.query(`UPDATE grocery_bids SET status='ACCEPTED',updated_at=now() WHERE id=$1`, [bidId]);
      await client.query(`UPDATE grocery_bids SET status='REJECTED',updated_at=now() WHERE list_id=$1 AND id<>$2 AND status='PENDING'`, [id, bidId]);
      await notify(client, chosen.user_id, 'GROCERY_BID_ACCEPTED', 'ماموریت خرید برای شما ثبت شد',
        `مشتری پیشنهاد شما را پذیرفت؛ لیست خرید را در پنل پیک ببینید.`, { listId: id });
      await client.query(
        `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'GROCERY_BID_ACCEPTED','GROCERY_LIST',$2,$3::jsonb)`,
        [user.sub, id, JSON.stringify({ bidId, feeRial: chosen.amount_rial, driverId: chosen.driver_id })]);
      await client.query('COMMIT');
      return this.detailFor(this.pool, user, id);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    } finally { client.release(); }
  }

  /** The courier buys the goods and reports what the shop charged, with the shop's own card. */
  async submitInvoice(user: Principal, id: string, body: { amountRial?: unknown; storeCard?: unknown; storeHolder?: unknown; photoUrl?: unknown; items?: unknown }) {
    const driver = await this.driverContext(user);
    const amount = GroceryService.amount(body?.amountRial, 'مبلغ فاکتور', 1_000, MAX_INVOICE);
    const storeCard = GroceryService.cardNumber(body?.storeCard, true)!;
    const storeHolder = GroceryService.text(body?.storeHolder, 'نام صاحب حساب فروشگاه', 3, 120)!;
    const photo = parseImageUrl(body?.photoUrl, 'عکس فاکتور');
    const rawItems = body?.items === undefined ? [] : body.items;
    if (!Array.isArray(rawItems) || rawItems.length > 40) throw new BadRequestException('اقلام فاکتور باید حداکثر ۴۰ قلم باشند.');
    const items = rawItems.map((item, index) => {
      const line = item as { name?: unknown; quantity?: unknown; unit?: unknown; unitPriceRial?: unknown };
      const name = GroceryService.text(line?.name, `نام قلم ${index + 1}`, 1, 160)!;
      const unit = GroceryService.text(line?.unit, `واحد قلم ${index + 1}`, 1, 20, false) ?? 'عدد';
      const quantity = Number(digits(line?.quantity ?? 1));
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 999) throw new BadRequestException(`تعداد قلم ${index + 1} معتبر نیست.`);
      const unitPrice = GroceryService.amount(line?.unitPriceRial, `قیمت قلم ${index + 1}`, 0, MAX_INVOICE);
      return { name, unit, quantity: quantity.toFixed(2), unitPrice, lineTotal: Math.round(unitPrice * quantity) };
    });
    if (items.length && amount !== items.reduce((sum, item) => sum + item.lineTotal, 0)) {
      throw new BadRequestException('جمع اقلام با مبلغ فاکتور یکی نیست؛ یکی را اصلاح کنید.');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const list = await client.query(
        `SELECT id,customer_id,driver_id,status FROM grocery_lists WHERE id=$1 FOR UPDATE`, [id]);
      if (!list.rowCount) throw new NotFoundException('لیست خرید پیدا نشد.');
      const row = list.rows[0] as { customer_id: string; driver_id: string | null; status: string };
      if (row.driver_id !== driver.id) throw new ForbiddenException('این ماموریت به شما تعلق ندارد.');
      if (!['ASSIGNED', 'SHOPPING'].includes(row.status)) throw new ConflictException('در این وضعیت نمی‌توان فاکتور ثبت کرد.');
      await client.query(
        `UPDATE grocery_lists SET status='INVOICE_SENT',invoice_amount_rial=$2,invoice_store_card=$3,invoice_store_holder=$4,
           invoice_photo_url=$5,invoice_submitted_at=now(),updated_at=now() WHERE id=$1`,
        [id, amount, storeCard, storeHolder, photo]);
      await client.query(`DELETE FROM grocery_invoice_items WHERE list_id=$1`, [id]);
      for (const item of items) {
        await client.query(
          `INSERT INTO grocery_invoice_items(list_id,name,quantity,unit,unit_price_rial,line_total_rial) VALUES($1,$2,$3,$4,$5,$6)`,
          [id, item.name, item.quantity, item.unit, item.unitPrice, item.lineTotal]);
      }
      await notify(client, row.customer_id, 'GROCERY_INVOICE', 'فاکتور خرید شما آماده است',
        `مبلغ فاکتور ${new Intl.NumberFormat('fa-IR').format(amount)} ریال است؛ پس از بررسی، پرداخت کارت‌به‌کارت را انجام دهید.`,
        { listId: id });
      await client.query('COMMIT');
      return this.detailFor(this.pool, user, id);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    } finally { client.release(); }
  }

  async approveInvoice(user: Principal, id: string) {
    const settings = await this.settings(this.pool);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const list = await client.query(
        `SELECT g.id,g.customer_id,g.status,d.user_id AS driver_user FROM grocery_lists g
         LEFT JOIN drivers d ON d.id=g.driver_id WHERE g.id=$1 FOR UPDATE OF g`, [id]);
      if (!list.rowCount) throw new NotFoundException('لیست خرید پیدا نشد.');
      const row = list.rows[0] as { customer_id: string; status: string; driver_user: string | null };
      if (row.customer_id !== user.sub) throw new NotFoundException('لیست خرید پیدا نشد.');
      if (row.status !== 'INVOICE_SENT') throw new ConflictException('فاکتوری برای تأیید وجود ندارد.');
      await client.query(
        `UPDATE grocery_lists SET status='AWAITING_PAYMENT',invoice_approved_at=now(),
           payment_deadline_at=now()+($2 || ' minutes')::interval,updated_at=now() WHERE id=$1`,
        [id, String(settings.paymentMinutes)]);
      if (row.driver_user) {
        await notify(client, row.driver_user, 'GROCERY_INVOICE_APPROVED', 'مشتری فاکتور را تأیید کرد',
          'منتظر واریز کارت‌به‌کارت مشتری به حساب فروشگاه باشید؛ رسید را در اپ تأیید کنید.', { listId: id });
      }
      await client.query('COMMIT');
      return this.detailFor(this.pool, user, id);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    } finally { client.release(); }
  }

  /** Card-to-card is live today; the online option is refused until a gateway is connected. */
  async declarePayment(user: Principal, id: string, body: { method?: unknown; receiptUrl?: unknown; reference?: unknown }) {
    const method = body?.method === undefined ? 'CARD_TO_CARD' : body.method;
    if (method !== 'CARD_TO_CARD') {
      throw new BadRequestException('پرداخت آنلاین هنوز فعال نیست؛ فعلاً کارت‌به‌کارت با بارگذاری رسید را انتخاب کنید.');
    }
    const receipt = parseImageUrl(body?.receiptUrl, 'تصویر رسید');
    if (!receipt) throw new BadRequestException('تصویر رسید پرداخت الزامی است.');
    const reference = GroceryService.text(body?.reference, 'شمارهٔ پیگیری', 4, 80, false);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const list = await client.query(
        `SELECT g.id,g.customer_id,g.status,g.invoice_amount_rial,d.user_id AS driver_user FROM grocery_lists g
         LEFT JOIN drivers d ON d.id=g.driver_id WHERE g.id=$1 FOR UPDATE OF g`, [id]);
      if (!list.rowCount) throw new NotFoundException('لیست خرید پیدا نشد.');
      const row = list.rows[0] as { customer_id: string; status: string; driver_user: string | null; invoice_amount_rial: string | null };
      if (row.customer_id !== user.sub) throw new NotFoundException('لیست خرید پیدا نشد.');
      if (row.status === 'PAID' || row.status === 'PAYMENT_CONFIRMED') throw new ConflictException('رسید پرداخت قبلاً ثبت شده است.');
      if (!['AWAITING_PAYMENT', 'INVOICE_SENT'].includes(row.status)) throw new ConflictException('در این وضعیت پرداخت مجاز نیست.');
      await client.query(
        `UPDATE grocery_lists SET status='PAID',payment_method=$2,payment_receipt_url=$3,payment_reference=$4,
           payment_declared_at=now(),updated_at=now() WHERE id=$1`,
        [id, method, receipt, reference]);
      if (row.driver_user) {
        await notify(client, row.driver_user, 'GROCERY_RECEIPT', 'رسید پرداخت مشتری رسید',
          'با فروشنده مطمئن شوید پول به حسابش رسیده است، بعد رسید را تأیید کنید.', { listId: id });
      }
      for (const staff of await staffIds(client, user.sub)) {
        await notify(client, staff, 'GROCERY_RECEIPT_STAFF', 'رسید کارت‌به‌کارت در انتظار تأیید',
          `مشتری رسید پرداخت لیست خرید را بارگذاری کرد؛ مبلغ فاکتور ${new Intl.NumberFormat('fa-IR').format(Number(row.invoice_amount_rial ?? 0))} ریال.`,
          { listId: id });
      }
      await client.query(
        `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'GROCERY_RECEIPT_UPLOADED','GROCERY_LIST',$2,$3::jsonb)`,
        [user.sub, id, JSON.stringify({ method, hasReference: Boolean(reference) })]);
      await client.query('COMMIT');
      return this.detailFor(this.pool, user, id);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    } finally { client.release(); }
  }

  private async platformFee(queryable: { query: Pool['query'] }, feeRial: bigint, goodsRial: bigint) {
    const settings = await this.settings(queryable);
    // bps = 1/100 of a percent, so the division is by 10 000 with a half-unit rounding step
    const bpsOf = (amount: bigint, bps: number) => (amount * BigInt(bps) + 5000n) / 10000n;
    if (settings.revenueMode === 'FEE_PERCENT') return bpsOf(feeRial, settings.feeBps);
    if (settings.revenueMode === 'GOODS_PERCENT') return bpsOf(goodsRial, settings.goodsBps);
    if (settings.revenueMode === 'FIXED') return settings.fixedRial;
    return 0n;
  }

  async confirmPayment(user: Principal, id: string) {
    const driver = await this.driverContext(user);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const list = await client.query(
        `SELECT g.id,g.customer_id,g.driver_id,g.status,g.fee_rial,g.invoice_amount_rial,g.payment_receipt_url
         FROM grocery_lists g WHERE g.id=$1 FOR UPDATE`, [id]);
      if (!list.rowCount) throw new NotFoundException('لیست خرید پیدا نشد.');
      const row = list.rows[0] as { customer_id: string; driver_id: string | null; status: string; fee_rial: string | null; invoice_amount_rial: string | null; payment_receipt_url: string | null };
      if (row.driver_id !== driver.id) throw new ForbiddenException('این ماموریت به شما تعلق ندارد.');
      if (row.status === 'PAYMENT_CONFIRMED') return this.detailFor(this.pool, user, id);
      if (row.status !== 'PAID') throw new ConflictException('رسیدی برای تأیید وجود ندارد.');
      if (!row.payment_receipt_url) throw new ConflictException('رسید پرداخت ثبت نشده است.');
      const fee = await this.platformFee(client, BigInt(row.fee_rial ?? 0), BigInt(row.invoice_amount_rial ?? 0));
      await client.query(
        `UPDATE grocery_lists SET status='PAYMENT_CONFIRMED',payment_confirmed_at=now(),payment_confirmed_by=$2,
           platform_fee_rial=$3,updated_at=now() WHERE id=$1`,
        [id, user.sub, fee.toString()]);
      await notify(client, row.customer_id, 'GROCERY_PAYMENT_CONFIRMED', 'پرداخت شما تأیید شد',
        'فروشنده دریافت مبلغ را تأیید کرد؛ پیک در حال تحویل سفارش است.', { listId: id });
      await client.query(
        `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'GROCERY_PAYMENT_CONFIRMED','GROCERY_LIST',$2,$3::jsonb)`,
        [user.sub, id, JSON.stringify({ platformFeeRial: fee.toString(), invoiceRial: row.invoice_amount_rial })]);
      await client.query('COMMIT');
      return this.detailFor(this.pool, user, id);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    } finally { client.release(); }
  }

  /** SHOPPING → the courier is at the shop; DELIVERED → goods handed over. */
  async transition(user: Principal, id: string, status: unknown, reason?: unknown) {
    const driver = await this.driverContext(user);
    const next = String(status ?? '').toUpperCase();
    const allowed = ['SHOPPING', 'DELIVERED', 'CANCELLED'];
    if (!allowed.includes(next)) throw new BadRequestException('وضعیت درخواستی معتبر نیست.');
    const note = next === 'CANCELLED' ? GroceryService.text(reason, 'دلیل لغو', 5, 300) : null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const list = await client.query(`SELECT id,customer_id,driver_id,status FROM grocery_lists WHERE id=$1 FOR UPDATE`, [id]);
      if (!list.rowCount) throw new NotFoundException('لیست خرید پیدا نشد.');
      const row = list.rows[0] as { customer_id: string; driver_id: string | null; status: string };
      if (row.driver_id !== driver.id) throw new ForbiddenException('این ماموریت به شما تعلق ندارد.');
      const from = row.status;
      const legal = (next === 'SHOPPING' && from === 'ASSIGNED')
        || (next === 'DELIVERED' && ['PAYMENT_CONFIRMED', 'AWAITING_PAYMENT', 'PAID'].includes(from))
        || (next === 'CANCELLED' && ['ASSIGNED', 'SHOPPING', 'INVOICE_SENT', 'AWAITING_PAYMENT'].includes(from));
      if (!legal) throw new ConflictException('این تغییر وضعیت از وضعیت فعلی مجاز نیست.');
      await client.query(`UPDATE grocery_lists SET status=$2,cancel_reason=$3,updated_at=now() WHERE id=$1`, [id, next, note]);
      await notify(client, row.customer_id,
        next === 'CANCELLED' ? 'GROCERY_CANCELLED' : next === 'DELIVERED' ? 'GROCERY_DELIVERED' : 'GROCERY_SHOPPING',
        next === 'CANCELLED' ? 'ماموریت خرید لغو شد' : next === 'DELIVERED' ? 'سفارش شما تحویل شد' : 'پیک خرید را شروع کرد',
        next === 'CANCELLED' ? (note ?? 'پیک ماموریت را لغو کرد.') : next === 'DELIVERED' ? 'خرید شما تحویل داده شد.' : 'پیک در فروشگاه است و به‌زودی فاکتور را می‌فرستد.',
        { listId: id });
      await client.query(
        `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'GROCERY_STATUS_CHANGED','GROCERY_LIST',$2,$3::jsonb)`,
        [user.sub, id, JSON.stringify({ from, to: next, reason: note })]);
      await client.query('COMMIT');
      return this.detailFor(this.pool, user, id);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    } finally { client.release(); }
  }

  /** A customer may pull the list back while it is still collecting bids. */
  async cancel(user: Principal, id: string, reason?: unknown) {
    const note = GroceryService.text(reason, 'دلیل لغو', 5, 300, false);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const list = await client.query(`SELECT id,customer_id,status FROM grocery_lists WHERE id=$1 FOR UPDATE`, [id]);
      if (!list.rowCount) throw new NotFoundException('لیست خرید پیدا نشد.');
      const row = list.rows[0] as { customer_id: string; status: string };
      if (row.customer_id !== user.sub) throw new NotFoundException('لیست خرید پیدا نشد.');
      if (row.status !== 'OPEN') throw new ConflictException('پس از انتخاب پیک، لغو فقط از طریق پشتیبانی انجام می‌شود.');
      await client.query(`UPDATE grocery_lists SET status='CANCELLED',cancel_reason=$2,updated_at=now() WHERE id=$1`, [id, note]);
      await client.query(`UPDATE grocery_bids SET status='REJECTED',updated_at=now() WHERE list_id=$1 AND status='PENDING'`, [id]);
      await client.query(
        `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'GROCERY_LIST_CANCELLED','GROCERY_LIST',$2,$3::jsonb)`,
        [user.sub, id, JSON.stringify({ reason: note })]);
      await client.query('COMMIT');
      return this.detailFor(this.pool, user, id);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    } finally { client.release(); }
  }
}

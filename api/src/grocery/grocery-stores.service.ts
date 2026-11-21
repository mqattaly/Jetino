import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { notify } from '../notifications/notifications.util';

type Principal = { sub: string; roles?: string[] };
const STAFF_ROLES = ['SUPER_ADMIN', 'OPERATIONS_MANAGER', 'SUPPORT'];
const isStaff = (user: Principal) => STAFF_ROLES.some(role => user.roles?.includes(role));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORE_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED'];
const MAX_PRICE = 500_000_000;
const MAX_STOCK = 99_999;

function digits(value: unknown) {
  return String(value ?? '').trim()
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[\s,٬]/g, '');
}

/**
 * The supermarket side of the grocery phase: a shop signs up, staff approve it, and its shelf
 * becomes a real catalogue. Product prices are only a shelf price — the courier still buys and
 * uploads the shop's own invoice, so nothing here is ever charged automatically.
 */
@Injectable()
export class GroceryStoresService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  private static text(value: unknown, label: string, min: number, max: number, required = true): string | null {
    if (value === undefined || value === null) {
      if (required) throw new BadRequestException(`${label} الزامی است.`);
      return null;
    }
    if (typeof value !== 'string') throw new BadRequestException(`${label} معتبر نیست.`);
    const text = value.trim();
    if (!text && !required) return null;
    if (text.length < min || text.length > max) throw new BadRequestException(`${label} باید بین ${min} تا ${max} نویسه باشد.`);
    return text;
  }

  private static amount(value: unknown, label: string, min: number, max: number): number {
    const text = digits(value);
    if (!/^\d+$/.test(text)) throw new BadRequestException(`${label} باید یک عدد صحیح به ریال باشد.`);
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new BadRequestException(`${label} باید بین ${new Intl.NumberFormat('fa-IR').format(min)} و ${new Intl.NumberFormat('fa-IR').format(max)} ریال باشد.`);
    }
    return parsed;
  }

  private static stock(value: unknown): string {
    const text = digits(value ?? 0);
    if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new BadRequestException('موجودی باید عدد باشد (حداکثر دو رقم اعشار).');
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_STOCK) {
      throw new BadRequestException(`موجودی باید بین ۰ تا ${new Intl.NumberFormat('fa-IR').format(MAX_STOCK)} باشد.`);
    }
    return parsed.toFixed(2);
  }

  /** The single active service region today; the store request never invents a region. */
  private async regionId(): Promise<string> {
    const result = await this.pool.query(
      `SELECT id FROM regions WHERE is_active=true ORDER BY (slug='bandar-khamir') DESC, created_at ASC LIMIT 1`);
    if (!result.rowCount) throw new BadRequestException('منطقهٔ فعالی برای ثبت فروشگاه وجود ندارد.');
    return result.rows[0].id as string;
  }

  private async ownStore(user: Principal) {
    const result = await this.pool.query(
      `SELECT id,status,region_id AS "regionId" FROM grocery_stores WHERE owner_user_id=$1`, [user.sub]);
    if (!result.rowCount) throw new NotFoundException('اول فروشگاهت را ثبت کن.');
    return result.rows[0] as { id: string; status: string; regionId: string };
  }

  /** The catalogue the customer sees while writing a list: approved shops only. */
  async listStores(_user: Principal) {
    const result = await this.pool.query(
      `SELECT s.id,s.name,s.address_text AS "addressText",s.phone,r.name AS "regionName",
              (SELECT count(*) FROM grocery_products p WHERE p.store_id=s.id AND p.is_active)::int AS "productCount"
       FROM grocery_stores s JOIN regions r ON r.id=s.region_id
       WHERE s.status='ACTIVE' AND r.is_active=true
       ORDER BY s.name ASC LIMIT 100`);
    return { stores: result.rows };
  }

  async products(storeIdInput: unknown) {
    const storeId = typeof storeIdInput === 'string' && uuidPattern.test(storeIdInput) ? storeIdInput : null;
    if (!storeId) throw new BadRequestException('شناسهٔ فروشگاه معتبر نیست.');
    const store = await this.pool.query(
      `SELECT s.id,s.name,s.status,r.name AS "regionName" FROM grocery_stores s JOIN regions r ON r.id=s.region_id WHERE s.id=$1`, [storeId]);
    if (!store.rowCount || store.rows[0].status !== 'ACTIVE') throw new NotFoundException('این فروشگاه پیدا نشد.');
    const items = await this.pool.query(
      `SELECT id,name,category,unit,price_rial::text AS "priceRial",stock::text AS stock,image_url AS "imageUrl"
       FROM grocery_products WHERE store_id=$1 AND is_active=true
       ORDER BY COALESCE(category,''), name ASC LIMIT 300`, [storeId]);
    return { store: store.rows[0], items: items.rows };
  }

  /** The owner's own shop, whatever its status, with every product including archived ones. */
  async mine(user: Principal) {
    const store = await this.pool.query(
      `SELECT s.id,s.name,s.phone,s.address_text AS "addressText",s.note,s.status,s.created_at AS "createdAt",
              s.approved_at AS "approvedAt",r.name AS "regionName"
       FROM grocery_stores s JOIN regions r ON r.id=s.region_id WHERE s.owner_user_id=$1`, [user.sub]);
    if (!store.rowCount) return { store: null, products: [] };
    const products = await this.pool.query(
      `SELECT id,name,category,unit,price_rial::text AS "priceRial",stock::text AS stock,
              image_url AS "imageUrl",is_active AS "isActive",updated_at AS "updatedAt"
       FROM grocery_products WHERE store_id=$1 ORDER BY is_active DESC, COALESCE(category,''), name ASC LIMIT 300`,
      [store.rows[0].id]);
    return { store: store.rows[0], products: products.rows };
  }

  async save(user: Principal, body: { name?: unknown; phone?: unknown; addressText?: unknown; note?: unknown }) {
    const name = GroceryStoresService.text(body?.name, 'نام فروشگاه', 2, 160)!;
    const phone = GroceryStoresService.text(body?.phone, 'شمارهٔ تماس فروشگاه', 7, 20, false);
    if (phone && !/^0\d{9,13}$/.test(digits(phone))) throw new BadRequestException('شمارهٔ تماس فروشگاه را مثل ۰۷۶۳۰۰۰۰۰۰۰ وارد کن.');
    const addressText = GroceryStoresService.text(body?.addressText, 'نشانی فروشگاه', 5, 300)!;
    const note = GroceryStoresService.text(body?.note, 'توضیح', 2, 300, false);
    const regionId = await this.regionId();
    const saved = await this.pool.query(
      `INSERT INTO grocery_stores(owner_user_id,region_id,name,phone,address_text,note)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (owner_user_id) DO UPDATE SET
         name=EXCLUDED.name,phone=EXCLUDED.phone,address_text=EXCLUDED.address_text,note=EXCLUDED.note,updated_at=now()
       RETURNING id,status`,
      [user.sub, regionId, name, phone ? digits(phone) : null, addressText, note]);
    await this.pool.query(
      `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'GROCERY_STORE_SAVED','GROCERY_STORE',$2,$3::jsonb)`,
      [user.sub, saved.rows[0].id, JSON.stringify({ name, status: saved.rows[0].status })]);
    return this.mine(user);
  }

  async addProduct(user: Principal, body: { name?: unknown; category?: unknown; unit?: unknown; priceRial?: unknown; stock?: unknown; imageUrl?: unknown }) {
    const name = GroceryStoresService.text(body?.name, 'نام کالا', 2, 160)!;
    const category = GroceryStoresService.text(body?.category, 'دستهٔ کالا', 2, 40, false);
    const unit = GroceryStoresService.text(body?.unit, 'واحد کالا', 1, 20, false) ?? 'عدد';
    const price = GroceryStoresService.amount(body?.priceRial, 'قیمت کالا', 0, MAX_PRICE);
    const stock = GroceryStoresService.stock(body?.stock);
    const imageUrl = GroceryStoresService.text(body?.imageUrl, 'عکس کالا', 1, 420_000, false);
    const store = await this.ownStore(user);
    if (store.status === 'SUSPENDED') throw new ForbiddenException('فروشگاهت معلق است؛ با پشتیبانی تماس بگیر.');
    try {
      await this.pool.query(
        `INSERT INTO grocery_products(store_id,name,category,unit,price_rial,stock,image_url)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [store.id, name, category, unit, price, stock, imageUrl]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ConflictException('کالایی با همین اسم در فروشگاهت هست؛ همان را ویرایش کن.');
      throw error;
    }
    return this.mine(user);
  }

  async updateProduct(user: Principal, idInput: unknown, body: { name?: unknown; category?: unknown; unit?: unknown; priceRial?: unknown; stock?: unknown; imageUrl?: unknown; isActive?: unknown }) {
    const id = typeof idInput === 'string' && uuidPattern.test(idInput) ? idInput : null;
    if (!id) throw new BadRequestException('شناسهٔ کالا معتبر نیست.');
    const store = await this.ownStore(user);
    const current = await this.pool.query(`SELECT id,name,category,unit,price_rial,stock,image_url,is_active FROM grocery_products WHERE id=$1 AND store_id=$2`, [id, store.id]);
    if (!current.rowCount) throw new NotFoundException('این کالا در فروشگاهت نیست.');
    const row = current.rows[0] as Record<string, unknown>;
    const name = body?.name === undefined ? row.name as string : GroceryStoresService.text(body.name, 'نام کالا', 2, 160)!;
    const category = body?.category === undefined ? (row.category as string | null) : GroceryStoresService.text(body.category, 'دستهٔ کالا', 2, 40, false);
    const unit = body?.unit === undefined ? row.unit as string : GroceryStoresService.text(body.unit, 'واحد کالا', 1, 20, false) ?? 'عدد';
    const price = body?.priceRial === undefined ? String(row.price_rial) : String(GroceryStoresService.amount(body.priceRial, 'قیمت کالا', 0, MAX_PRICE));
    const stock = body?.stock === undefined ? String(row.stock) : GroceryStoresService.stock(body.stock);
    const imageUrl = body?.imageUrl === undefined ? (row.image_url as string | null) : GroceryStoresService.text(body.imageUrl, 'عکس کالا', 1, 420_000, false);
    const isActive = body?.isActive === undefined ? Boolean(row.is_active) : body.isActive === true;
    try {
      await this.pool.query(
        `UPDATE grocery_products SET name=$3,category=$4,unit=$5,price_rial=$6,stock=$7,image_url=$8,is_active=$9,updated_at=now()
         WHERE id=$1 AND store_id=$2`,
        [id, store.id, name, category, unit, price, stock, imageUrl, isActive]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ConflictException('کالایی با همین اسم در فروشگاهت هست.');
      throw error;
    }
    return this.mine(user);
  }

  /** Products are archived, never deleted: an old invoice must keep pointing at a real row. */
  async archiveProduct(user: Principal, idInput: unknown) {
    const id = typeof idInput === 'string' && uuidPattern.test(idInput) ? idInput : null;
    if (!id) throw new BadRequestException('شناسهٔ کالا معتبر نیست.');
    const store = await this.ownStore(user);
    const result = await this.pool.query(
      `UPDATE grocery_products SET is_active=false,updated_at=now() WHERE id=$1 AND store_id=$2 RETURNING id`, [id, store.id]);
    if (!result.rowCount) throw new NotFoundException('این کالا در فروشگاهت نیست.');
    return this.mine(user);
  }

  async adminList(actor: Principal, statusInput?: unknown) {
    if (!isStaff(actor)) throw new ForbiddenException('این فهرست فقط برای کارکنان است.');
    const status = typeof statusInput === 'string' && STORE_STATUSES.includes(statusInput.toUpperCase()) ? statusInput.toUpperCase() : null;
    const result = await this.pool.query(
      `SELECT s.id,s.name,s.phone,s.address_text AS "addressText",s.note,s.status,s.created_at AS "createdAt",
              s.approved_at AS "approvedAt",r.name AS "regionName",u.phone AS "ownerPhone",u.display_name AS "ownerName",
              (SELECT count(*) FROM grocery_products p WHERE p.store_id=s.id AND p.is_active)::int AS "productCount"
       FROM grocery_stores s
       JOIN regions r ON r.id=s.region_id
       JOIN users u ON u.id=s.owner_user_id
       WHERE ($1::text IS NULL OR s.status=$1)
       ORDER BY (s.status='PENDING') DESC, s.created_at DESC LIMIT 100`, [status]);
    return { items: result.rows };
  }

  async adminStatus(actor: Principal, idInput: unknown, body: { status?: unknown; note?: unknown }) {
    if (!isStaff(actor)) throw new ForbiddenException('این کار فقط برای کارکنان است.');
    const id = typeof idInput === 'string' && uuidPattern.test(idInput) ? idInput : null;
    if (!id) throw new BadRequestException('شناسهٔ فروشگاه معتبر نیست.');
    const next = String(body?.status ?? '').toUpperCase();
    if (!STORE_STATUSES.includes(next)) throw new BadRequestException('وضعیت فروشگاه معتبر نیست.');
    const note = GroceryStoresService.text(body?.note, 'یادداشت', 2, 300, false);
    const current = await this.pool.query(
      `SELECT s.id,s.name,s.status,s.owner_user_id AS "ownerUserId" FROM grocery_stores s WHERE s.id=$1`, [id]);
    if (!current.rowCount) throw new NotFoundException('فروشگاه پیدا نشد.');
    if (current.rows[0].status === next) return this.adminList(actor, next);
    await this.pool.query(
      `UPDATE grocery_stores SET status=$2,note=COALESCE($3,note),approved_by=$4,
         approved_at=CASE WHEN $2='ACTIVE' THEN now() ELSE approved_at END,updated_at=now() WHERE id=$1`,
      [id, next, note, actor.sub]);
    await this.pool.query(
      `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'GROCERY_STORE_STATUS','GROCERY_STORE',$2,$3::jsonb)`,
      [actor.sub, id, JSON.stringify({ from: current.rows[0].status, to: next, note })]);
    const title = next === 'ACTIVE' ? 'فروشگاهت تأیید شد' : next === 'SUSPENDED' ? 'فروشگاهت معلق شد' : 'وضعیت فروشگاهت عوض شد';
    const bodyText = next === 'ACTIVE'
      ? 'از حالا مشتری‌ها می‌توانند موقع نوشتن لیست خرید، فروشگاه تو را انتخاب کنند.'
      : next === 'SUSPENDED'
        ? (note ?? 'فروشگاهت موقتاً از دسترس مشتری‌ها خارج شد. برای پیگیری با پشتیبانی تماس بگیر.')
        : (note ?? 'وضعیت فروشگاهت به «در انتظار بررسی» برگشت.');
    await notify(this.pool, current.rows[0].ownerUserId as string, 'GROCERY_STORE_STATUS', title, bodyText, { storeId: id });
    return this.adminList(actor, next);
  }
}

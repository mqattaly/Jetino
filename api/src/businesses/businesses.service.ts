import { Inject, Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

type Principal = { sub: string };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class BusinessesService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  private id(input: unknown, label = 'شناسه'): string {
    if (typeof input !== 'string' || !uuidPattern.test(input)) throw new BadRequestException(`${label} معتبر نیست.`);
    return input;
  }

  async list(region = 'bandar-khamir', search = '') {
    const result = await this.pool.query(
      `SELECT b.id,b.name,b.description,r.name AS region_name,r.slug AS region_slug,r.delivery_fee_rial::text AS delivery_fee_rial,
       COALESCE(ARRAY(SELECT c.name FROM menu_categories c WHERE c.business_id=b.id ORDER BY c.sort_order,c.name),ARRAY[]::varchar[]) AS categories,b.created_at
       FROM businesses b JOIN regions r ON r.id=b.region_id
       WHERE b.status='ACTIVE' AND r.is_active=true AND r.slug=$1 AND ($2='' OR b.name ILIKE '%'||$2||'%')
       ORDER BY b.name`, [region.slice(0, 120), search.slice(0, 100)],
    );
    return result.rows;
  }

  async detail(idInput: unknown) {
    const id = this.id(idInput);
    const result = await this.pool.query(
      `SELECT b.id,b.name,b.description,r.name AS region_name,r.slug AS region_slug,r.delivery_fee_rial::text AS delivery_fee_rial FROM businesses b JOIN regions r ON r.id=b.region_id
       WHERE b.id=$1 AND b.status='ACTIVE' AND r.is_active=true`, [id],
    );
    if (!result.rowCount) throw new NotFoundException('کسب‌وکار پیدا نشد.');
    const categories = await this.pool.query(
      `SELECT c.id,c.name,c.sort_order,COALESCE(json_agg(json_build_object('id',p.id,'name',p.name,'description',p.description,'priceRial',p.price_rial::text) ORDER BY p.name) FILTER (WHERE p.id IS NOT NULL), '[]') AS products
       FROM menu_categories c LEFT JOIN products p ON p.category_id=c.id AND p.is_available=true
       WHERE c.business_id=$1 GROUP BY c.id ORDER BY c.sort_order,c.name`, [id],
    );
    return { ...result.rows[0], categories: categories.rows };
  }

  async create(user: Principal, body: { name?: unknown; description?: unknown; regionSlug?: unknown }) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const description = typeof body?.description === 'string' ? body.description.trim() : null;
    const regionSlug = typeof body?.regionSlug === 'string' ? body.regionSlug : 'bandar-khamir';
    if (name.length < 2 || name.length > 160) throw new BadRequestException('نام کسب‌وکار باید بین ۲ تا ۱۶۰ نویسه باشد.');
    if (description && description.length > 1000) throw new BadRequestException('توضیحات بیش از حد طولانی است.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const region = await client.query('SELECT id FROM regions WHERE slug=$1 AND is_active=true', [regionSlug]);
      if (!region.rowCount) throw new NotFoundException('منطقهٔ فعال پیدا نشد.');
      const result = await client.query(
        `INSERT INTO businesses(owner_id,region_id,name,description) VALUES($1,$2,$3,$4) RETURNING id,name,description,status,created_at`,
        [user.sub, region.rows[0].id, name, description],
      );
      await client.query(`INSERT INTO user_roles(user_id,role) VALUES($1,'BUSINESS_OWNER') ON CONFLICT DO NOTHING`, [user.sub]);
      await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id) VALUES($1,'BUSINESS_APPLICATION_CREATED','BUSINESS',$2)`, [user.sub, result.rows[0].id]);
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    } finally { client.release(); }
  }

  async mine(user: Principal) {
    const result = await this.pool.query(
      `SELECT id,name,description,status,region_id,commission_bps,created_at FROM businesses WHERE owner_id=$1 ORDER BY created_at DESC`, [user.sub],
    );
    return result.rows;
  }

  async mineMenu(user: Principal, idInput: unknown) {
    const businessId = this.id(idInput, 'شناسهٔ کسب‌وکار');
    const result = await this.pool.query(
      `SELECT c.id AS category_id,c.name AS category_name,c.sort_order,p.id AS product_id,p.name AS product_name,p.description AS product_description,p.price_rial::text AS price_rial,p.is_available
       FROM businesses b LEFT JOIN menu_categories c ON c.business_id=b.id LEFT JOIN products p ON p.category_id=c.id
       WHERE b.id=$1 AND b.owner_id=$2 ORDER BY c.sort_order,c.name,p.name`, [businessId,user.sub],
    );
    if (!result.rowCount) throw new NotFoundException('کسب‌وکار پیدا نشد یا دسترسی ندارید.');
    const categories = new Map<string,{id:string;name:string;sortOrder:number;products:Array<{id:string;name:string;description:string|null;priceRial:string;isAvailable:boolean}>}>();
    for (const row of result.rows) {
      if (!row.category_id) continue;
      if (!categories.has(row.category_id)) categories.set(row.category_id,{id:row.category_id,name:row.category_name,sortOrder:row.sort_order,products:[]});
      if (row.product_id) categories.get(row.category_id)!.products.push({id:row.product_id,name:row.product_name,description:row.product_description,priceRial:row.price_rial,isAvailable:row.is_available});
    }
    return {businessId,categories:[...categories.values()]};
  }

  async update(user: Principal, idInput: unknown, body: { name?: unknown; description?: unknown }) {
    const id = this.id(idInput);
    const name = typeof body?.name === 'string' ? body.name.trim() : null;
    const description = typeof body?.description === 'string' ? body.description.trim() : null;
    if (body?.name !== undefined && (!name || name.length > 160)) throw new BadRequestException('نام کسب‌وکار معتبر نیست.');
    if (body?.description !== undefined && description && description.length > 1000) throw new BadRequestException('توضیحات بیش از حد طولانی است.');
    const result = await this.pool.query(
      `UPDATE businesses SET name=COALESCE($3,name), description=CASE WHEN $4 THEN $5 ELSE description END
       WHERE id=$1 AND owner_id=$2 RETURNING id,name,description,status`, [id,user.sub,name,body?.description!==undefined,description],
    );
    if (!result.rowCount) throw new NotFoundException('کسب‌وکار پیدا نشد یا دسترسی ندارید.');
    await this.audit(user.sub, 'BUSINESS_UPDATED', 'BUSINESS', id);
    return result.rows[0];
  }

  async createCategory(user: Principal, businessInput: unknown, body: { name?: unknown; sortOrder?: unknown }) {
    const businessId = this.id(businessInput, 'شناسهٔ کسب‌وکار');
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 100) throw new BadRequestException('نام دسته‌بندی معتبر نیست.');
    const owns = await this.pool.query('SELECT 1 FROM businesses WHERE id=$1 AND owner_id=$2', [businessId,user.sub]);
    if (!owns.rowCount) throw new NotFoundException('کسب‌وکار پیدا نشد یا دسترسی ندارید.');
    try {
      const result = await this.pool.query('INSERT INTO menu_categories(business_id,name,sort_order) VALUES($1,$2,$3) RETURNING id,name,sort_order', [businessId,name,Number.isInteger(body.sortOrder)?body.sortOrder:0]);
      await this.audit(user.sub, 'MENU_CATEGORY_CREATED', 'BUSINESS', businessId);
      return result.rows[0];
    } catch (error: unknown) {
      if ((error as { code?: string }).code === '23505') throw new ConflictException('این دسته‌بندی از قبل وجود دارد.');
      throw error;
    }
  }

  async createProduct(user: Principal, categoryInput: unknown, body: { name?: unknown; description?: unknown; priceRial?: unknown }) {
    const categoryId = this.id(categoryInput, 'شناسهٔ دسته‌بندی');
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const description = typeof body?.description === 'string' ? body.description.trim() : null;
    const rawPrice = body?.priceRial;
    const validPrice = (typeof rawPrice === 'string' && /^\d+$/.test(rawPrice)) || (typeof rawPrice === 'number' && Number.isSafeInteger(rawPrice) && rawPrice >= 0);
    const price = validPrice ? BigInt(rawPrice as string | number) : -1n;
    if (!name || name.length > 160 || (description && description.length > 1000) || price < 0n || price > 9_000_000_000_000_000n) throw new BadRequestException('اطلاعات یا قیمت محصول معتبر نیست. قیمت را به ریال وارد کنید.');
    const owns = await this.pool.query(
      `SELECT 1 FROM menu_categories c JOIN businesses b ON b.id=c.business_id WHERE c.id=$1 AND b.owner_id=$2`, [categoryId,user.sub],
    );
    if (!owns.rowCount) throw new NotFoundException('دسته‌بندی پیدا نشد یا دسترسی ندارید.');
    const result = await this.pool.query(
      `INSERT INTO products(category_id,name,description,price_rial) VALUES($1,$2,$3,$4) RETURNING id,name,description,price_rial,is_available`,
      [categoryId,name,description,price.toString()],
    );
    await this.audit(user.sub, 'MENU_PRODUCT_CREATED', 'PRODUCT', result.rows[0].id);
    return result.rows[0];
  }

  async updateProduct(user: Principal, productInput: unknown, body: { name?: unknown; description?: unknown; priceRial?: unknown }) {
    const id = this.id(productInput, 'شناسهٔ محصول');
    if (!body || (body.name === undefined && body.description === undefined && body.priceRial === undefined)) throw new BadRequestException('حداقل یک فیلد برای ویرایش لازم است.');
    const name = body.name === undefined ? null : typeof body.name === 'string' ? body.name.trim() : '';
    const description = body.description === undefined ? null : typeof body.description === 'string' ? body.description.trim() : '';
    const rawPrice = body.priceRial;
    const validPrice = rawPrice === undefined || (typeof rawPrice === 'string' && /^\d+$/.test(rawPrice)) || (typeof rawPrice === 'number' && Number.isSafeInteger(rawPrice) && rawPrice >= 0);
    const price = rawPrice === undefined ? null : validPrice ? BigInt(rawPrice as string | number) : -1n;
    if ((name !== null && (!name || name.length > 160)) || (description !== null && description.length > 1000) || !validPrice || (price !== null && (price < 0n || price > 9_000_000_000_000_000n))) throw new BadRequestException('اطلاعات یا قیمت محصول معتبر نیست. قیمت را به ریال وارد کنید.');
    const result = await this.pool.query(
      `UPDATE products p SET name=COALESCE($3,p.name),description=CASE WHEN $4 THEN $5 ELSE p.description END,price_rial=COALESCE($6,p.price_rial)
       FROM menu_categories c,businesses b WHERE p.category_id=c.id AND c.business_id=b.id AND p.id=$1 AND b.owner_id=$2
       RETURNING p.id,p.name,p.description,p.price_rial::text AS price_rial,p.is_available`,
      [id,user.sub,name,body.description!==undefined,description,price?.toString()??null],
    );
    if (!result.rowCount) throw new NotFoundException('محصول پیدا نشد یا دسترسی ندارید.');
    await this.audit(user.sub, 'MENU_PRODUCT_UPDATED', 'PRODUCT', id);
    return result.rows[0];
  }

  async setProductAvailability(user: Principal, productInput: unknown, available: unknown) {
    const id = this.id(productInput, 'شناسهٔ محصول');
    if (typeof available !== 'boolean') throw new BadRequestException('وضعیت موجودی معتبر نیست.');
    const result = await this.pool.query(
      `UPDATE products p SET is_available=$3 FROM menu_categories c,businesses b WHERE p.category_id=c.id AND c.business_id=b.id AND p.id=$1 AND b.owner_id=$2 RETURNING p.id,p.name,p.is_available`,
      [id,user.sub,available],
    );
    if (!result.rowCount) throw new NotFoundException('محصول پیدا نشد یا دسترسی ندارید.');
    await this.audit(user.sub, available ? 'PRODUCT_ENABLED' : 'PRODUCT_DISABLED', 'PRODUCT', id);
    return result.rows[0];
  }

  private async audit(actor: string, action: string, entity: string, id: string) {
    await this.pool.query('INSERT INTO audit_logs(actor_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4)', [actor,action,entity,id]);
  }
}

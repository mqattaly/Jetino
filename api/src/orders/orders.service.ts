import { Inject, Injectable, BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException, ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../database/database.module';
import { notify } from '../notifications/notifications.util';
import { decide, readPolicy, rejectionMessage } from '../cancellations/cancellation-policy';
import { cancelOrder, staffIds, writeAudit } from '../cancellations/cancellation-writes';

type Principal = { sub: string };
type QuoteItem = { productId: string; quantity: number };
type PriceProduct = { id:string; name:string; price_rial:string; business_id:string };
type Pricing = {
  business:{id:string;name:string;owner_id:string;commission_bps:number|null;region_id:string;region_name:string;delivery_fee_rial:string|null};
  address:{id:string;label:string;address_text:string;instructions:string|null;latitude:string|null;longitude:string|null;region_id:string};
  lines:Array<{productId:string;productName:string;unitPriceRial:string;quantity:number;lineTotalRial:string}>;
  subtotal:bigint; deliveryFee:bigint; commissionBps:number; commission:bigint; total:bigint;
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class OrdersService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  private parse(user: Principal, body: { businessId?: unknown; addressId?: unknown; items?: unknown }) {
    const { businessId, addressId, items } = body ?? {};
    if (typeof businessId !== 'string' || !uuidPattern.test(businessId)) throw new BadRequestException('شناسهٔ کسب‌وکار معتبر نیست.');
    if (typeof addressId !== 'string' || !uuidPattern.test(addressId)) throw new BadRequestException('نشانی تحویل معتبر را انتخاب کنید.');
    if (!Array.isArray(items) || items.length < 1 || items.length > 50) throw new BadRequestException('سبد باید بین ۱ تا ۵۰ قلم داشته باشد.');
    const validated: QuoteItem[] = []; const seen = new Set<string>();
    for (const item of items) {
      if (!item || typeof item !== 'object' || !uuidPattern.test((item as {productId?:string}).productId ?? '') || !Number.isInteger((item as {quantity?:number}).quantity) || (item as {quantity:number}).quantity < 1 || (item as {quantity:number}).quantity > 99) throw new BadRequestException('قلم یا تعداد محصول معتبر نیست.');
      const value = item as QuoteItem;
      if (seen.has(value.productId)) throw new BadRequestException('هر محصول را فقط یک‌بار در سبد بفرستید و تعداد را در همان قلم مشخص کنید.');
      seen.add(value.productId); validated.push(value);
    }
    return { user, businessId, addressId, items: validated };
  }

  private async calculate(queryable: { query: Pool['query'] }, user: Principal, businessId: string, addressId: string, items: QuoteItem[], lock = false): Promise<Pricing> {
    const lockBusiness = lock ? 'FOR SHARE OF b,r' : '';
    const businessResult = await queryable.query(
      `SELECT b.id,b.name,b.owner_id,b.commission_bps,r.id AS region_id,r.name AS region_name,r.delivery_fee_rial
       FROM businesses b JOIN regions r ON r.id=b.region_id
       WHERE b.id=$1 AND b.status='ACTIVE' AND r.is_active=true ${lockBusiness}`, [businessId],
    );
    if (!businessResult.rowCount) throw new NotFoundException('کسب‌وکار فعال پیدا نشد.');
    const business = businessResult.rows[0] as Pricing['business'];
    const lockAddress = lock ? 'FOR SHARE OF a' : '';
    const addressResult = await queryable.query(
      `SELECT a.id,a.label,a.address_text,a.instructions,a.latitude::text,a.longitude::text,r.id AS region_id
       FROM addresses a JOIN regions r ON r.id=a.region_id
       WHERE a.id=$1 AND a.user_id=$2 AND r.is_active=true ${lockAddress}`, [addressId,user.sub],
    );
    if (!addressResult.rowCount) throw new NotFoundException('نشانی انتخاب‌شده پیدا نشد.');
    const address = addressResult.rows[0] as Pricing['address'];
    if (address.region_id !== business.region_id) throw new ConflictException('نشانی در منطقهٔ خدمت این کسب‌وکار قرار ندارد.');
    if (business.delivery_fee_rial === null) throw new ServiceUnavailableException('هزینهٔ ارسال این منطقه هنوز تنظیم نشده است.');
    const lockProducts = lock ? 'FOR SHARE OF p,c' : '';
    const products = await queryable.query(
      `SELECT p.id,p.name,p.price_rial,c.business_id FROM products p JOIN menu_categories c ON c.id=p.category_id
       WHERE p.id=ANY($1::uuid[]) AND p.is_available=true ${lockProducts}`, [items.map(item=>item.productId)],
    );
    if (products.rowCount !== items.length) throw new ConflictException('یک یا چند محصول ناموجود یا حذف شده‌اند؛ سبد را تازه‌سازی کنید.');
    const byId = new Map(products.rows.map((product: PriceProduct)=>[product.id,product]));
    let subtotal = 0n;
    const lines = items.map(item => {
      const product = byId.get(item.productId)!;
      if (product.business_id !== business.id) throw new ConflictException('در هر سفارش فقط از یک کسب‌وکار می‌توان خرید کرد.');
      const unitPrice = BigInt(product.price_rial); const lineTotal = unitPrice * BigInt(item.quantity); subtotal += lineTotal;
      return { productId: product.id, productName: product.name, unitPriceRial: unitPrice.toString(), quantity: item.quantity, lineTotalRial: lineTotal.toString() };
    });
    const commissionResult = await queryable.query(`SELECT value_int FROM platform_settings WHERE key='default_commission_bps' ${lock ? 'FOR SHARE' : ''}`);
    if (business.commission_bps === null && !commissionResult.rowCount) throw new ServiceUnavailableException('نرخ کمیسیون هنوز تنظیم نشده است.');
    const commissionBps = Number(business.commission_bps ?? commissionResult.rows[0].value_int);
    const commission = (subtotal * BigInt(commissionBps) + 5000n) / 10000n;
    const deliveryFee = BigInt(business.delivery_fee_rial);
    return { business,address,lines,subtotal,deliveryFee,commissionBps,commission,total:subtotal+deliveryFee };
  }

  private formatQuote(price: Pricing) {
    const createdAt = new Date();
    return {
      quoteOnly: true, orderPlacementEnabled: true, currency: 'IRR',
      business: { id: price.business.id, name: price.business.name },
      delivery: { addressId: price.address.id, label: price.address.label, addressText: price.address.address_text, instructions: price.address.instructions, feeRial: price.deliveryFee.toString() },
      items: price.lines, subtotalRial: price.subtotal.toString(),
      commission: { rateBps: price.commissionBps, amountRial: price.commission.toString() },
      deliveryFeeRial: price.deliveryFee.toString(), totalRial: price.total.toString(),
      paymentMethods: ['CASH'], createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime()+3*60*1000).toISOString(),
      message: 'این پیش‌فاکتور رزرو انجام نمی‌دهد؛ مبلغ نهایی هنگام ثبت سفارش دوباره در سرور محاسبه می‌شود.',
    };
  }

  async quote(user: Principal, body: { businessId?: unknown; addressId?: unknown; items?: unknown }) {
    const input = this.parse(user,body);
    return this.formatQuote(await this.calculate(this.pool,user,input.businessId,input.addressId,input.items));
  }

  async create(user: Principal, body: { businessId?: unknown; addressId?: unknown; items?: unknown; paymentMethod?: unknown }, idempotencyKey?: string) {
    const input = this.parse(user,body);
    if (body.paymentMethod !== undefined && body.paymentMethod !== 'CASH') throw new BadRequestException('در حال حاضر فقط پرداخت نقدی هنگام تحویل فعال است.');
    if (!idempotencyKey || idempotencyKey.length > 120 || !/^[A-Za-z0-9:_-]+$/.test(idempotencyKey)) throw new BadRequestException('هدر Idempotency-Key معتبر و یکتا الزامی است.');
    const stableItems = [...input.items].sort((a,b)=>a.productId.localeCompare(b.productId));
    const requestHash = createHash('sha256').update(JSON.stringify({businessId:input.businessId,addressId:input.addressId,items:stableItems,paymentMethod:'CASH'})).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${user.sub}:${idempotencyKey}`]);
      const existing = await client.query('SELECT id,request_hash FROM orders WHERE customer_id=$1 AND idempotency_key=$2', [user.sub,idempotencyKey]);
      if (existing.rowCount) {
        if (existing.rows[0].request_hash !== requestHash) throw new ConflictException('این کلید قبلاً برای محتوای سفارش دیگری استفاده شده است.');
        const order = await this.orderDetails(client,user,existing.rows[0].id);
        await client.query('COMMIT'); return { ...order, replayed: true };
      }
      const price = await this.calculate(client,user,input.businessId,input.addressId,input.items,true);
      const inserted = await client.query(
        `INSERT INTO orders(customer_id,business_id,address_id,delivery_address_snapshot,delivery_instructions_snapshot,delivery_latitude_snapshot,delivery_longitude_snapshot,status,payment_method,payment_status,subtotal_rial,delivery_fee_rial,commission_rial,commission_bps,total_rial,idempotency_key,request_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING_BUSINESS','CASH','PENDING',$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [user.sub,price.business.id,price.address.id,price.address.address_text,price.address.instructions,price.address.latitude,price.address.longitude,price.subtotal.toString(),price.deliveryFee.toString(),price.commission.toString(),price.commissionBps,price.total.toString(),idempotencyKey,requestHash],
      );
      const orderId = inserted.rows[0].id as string;
      for (const line of price.lines) await client.query(
        `INSERT INTO order_items(order_id,product_id,product_name,unit_price_rial,quantity,line_total_rial) VALUES($1,$2,$3,$4,$5,$6)`,
        [orderId,line.productId,line.productName,line.unitPriceRial,line.quantity,line.lineTotalRial],
      );
      await client.query(`INSERT INTO order_status_history(order_id,from_status,to_status,actor_id,reason) VALUES($1,NULL,'PENDING_BUSINESS',$2,'Order created')`, [orderId,user.sub]);
      await notify(client,price.business.owner_id,'ORDER_NEW','سفارش تازه دارید','یک سفارش جدید برای بررسی ثبت شده است.',{orderId},{dedupeKey:orderId});
      await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'ORDER_CREATED','ORDER',$2,$3::jsonb)`, [user.sub,orderId,JSON.stringify({paymentMethod:'CASH',currency:'IRR'})]);
      const order = await this.orderDetails(client,user,orderId);
      await client.query('COMMIT'); return { ...order, replayed: false };
    } catch(error) { try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ } throw error; }
    finally { client.release(); }
  }

  async mine(user: Principal) {
    const result = await this.pool.query(
      `SELECT id,business_id AS "businessId",status,payment_method AS "paymentMethod",payment_status AS "paymentStatus",total_rial AS "totalRial",estimated_prep_minutes AS "estimatedPrepMinutes",created_at AS "createdAt" FROM orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`, [user.sub],
    );
    return result.rows;
  }

  async businessOrders(user: Principal) {
    const result = await this.pool.query(
      `SELECT o.id,o.status,o.payment_method AS "paymentMethod",o.payment_status AS "paymentStatus",o.total_rial AS "totalRial",o.estimated_prep_minutes AS "estimatedPrepMinutes",o.created_at AS "createdAt",o.delivery_address_snapshot AS "deliveryAddress",u.phone AS "customerPhone"
       FROM orders o JOIN businesses b ON b.id=o.business_id JOIN users u ON u.id=o.customer_id WHERE b.owner_id=$1 ORDER BY o.created_at DESC LIMIT 100`, [user.sub],
    );
    return result.rows;
  }

  async detail(user: Principal, idInput: unknown) {
    if (typeof idInput !== 'string' || !uuidPattern.test(idInput)) throw new BadRequestException('شناسهٔ سفارش معتبر نیست.');
    return this.orderDetails(this.pool,user,idInput);
  }

  private async orderDetails(queryable: { query: Pool['query'] } | PoolClient, user: Principal, id: string) {
    const result = await queryable.query(
      `SELECT o.id,o.customer_id,o.business_id,o.status,o.payment_method,o.payment_status,o.subtotal_rial,o.delivery_fee_rial,o.commission_rial,o.commission_bps,o.total_rial,o.estimated_prep_minutes,o.delivery_address_snapshot,o.delivery_instructions_snapshot,o.delivery_latitude_snapshot,o.delivery_longitude_snapshot,o.created_at,o.updated_at,b.name AS business_name
       FROM orders o JOIN businesses b ON b.id=o.business_id WHERE o.id=$1 AND (o.customer_id=$2 OR b.owner_id=$2)`, [id,user.sub],
    );
    if (!result.rowCount) throw new NotFoundException('سفارش پیدا نشد.');
    const row = result.rows[0];
    const items = await queryable.query('SELECT product_name,unit_price_rial,quantity,line_total_rial FROM order_items WHERE order_id=$1 ORDER BY id',[id]);
    const history = await queryable.query('SELECT from_status,to_status,reason,created_at FROM order_status_history WHERE order_id=$1 ORDER BY created_at,id',[id]);
    return {
      id:row.id,business:{id:row.business_id,name:row.business_name},status:row.status,estimatedPrepMinutes:row.estimated_prep_minutes,
      payment:{method:row.payment_method,status:row.payment_status},currency:'IRR',
      amounts:{subtotalRial:String(row.subtotal_rial),deliveryFeeRial:String(row.delivery_fee_rial),commissionRial:String(row.commission_rial),commissionBps:row.commission_bps,totalRial:String(row.total_rial)},
      delivery:{addressText:row.delivery_address_snapshot,instructions:row.delivery_instructions_snapshot,latitude:row.delivery_latitude_snapshot===null?null:Number(row.delivery_latitude_snapshot),longitude:row.delivery_longitude_snapshot===null?null:Number(row.delivery_longitude_snapshot)},
      items:items.rows.map((item: {product_name:string;unit_price_rial:string;quantity:number;line_total_rial:string})=>({productName:item.product_name,unitPriceRial:String(item.unit_price_rial),quantity:item.quantity,lineTotalRial:String(item.line_total_rial)})),
      history:history.rows,createdAt:row.created_at,
    };
  }

  async businessTransition(user: Principal, idInput: unknown, toInput: unknown, preparationMinutesInput?: unknown) {
    if (typeof idInput !== 'string' || !uuidPattern.test(idInput)) throw new BadRequestException('شناسهٔ سفارش معتبر نیست.');
    if (!['CONFIRMED','REJECTED','PREPARING','READY_FOR_PICKUP'].includes(String(toInput))) throw new BadRequestException('وضعیت جدید مجاز نیست.');
    const to = toInput as string;
    const preparationMinutes = to === 'CONFIRMED' ? (preparationMinutesInput === undefined ? 30 : preparationMinutesInput) : null;
    if (to === 'CONFIRMED' && (!Number.isInteger(preparationMinutes) || Number(preparationMinutes) < 5 || Number(preparationMinutes) > 240)) throw new BadRequestException('زمان آماده‌سازی باید بین ۵ تا ۲۴۰ دقیقه باشد.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT o.id,o.status,o.customer_id,b.owner_id FROM orders o JOIN businesses b ON b.id=o.business_id WHERE o.id=$1 FOR UPDATE OF o`, [idInput],
      );
      if (!result.rowCount || result.rows[0].owner_id !== user.sub) throw new NotFoundException('سفارش پیدا نشد یا دسترسی ندارید.');
      const from = result.rows[0].status as string;
      const transitions: Record<string,string[]> = { PENDING_BUSINESS:['CONFIRMED','REJECTED'], CONFIRMED:['PREPARING'], PREPARING:['READY_FOR_PICKUP'] };
      if (!transitions[from]?.includes(to)) throw new ConflictException(`گذار از ${from} به ${to} مجاز نیست.`);
      await client.query('UPDATE orders SET status=$2,estimated_prep_minutes=COALESCE($3,estimated_prep_minutes),updated_at=now() WHERE id=$1',[idInput,to,preparationMinutes]);
      await client.query('INSERT INTO order_status_history(order_id,from_status,to_status,actor_id) VALUES($1,$2,$3,$4)',[idInput,from,to,user.sub]);
      const notificationText:Record<string,[string,string]>={CONFIRMED:['سفارش تأیید شد','کسب‌وکار سفارش شما را پذیرفت.'],REJECTED:['سفارش پذیرفته نشد','کسب‌وکار امکان آماده‌سازی سفارش را نداشت.'],PREPARING:['آماده‌سازی آغاز شد','سفارش شما در حال آماده‌سازی است.'],READY_FOR_PICKUP:['سفارش آماده است','سفارش برای تحویل به پیک آماده شده است.']};
      const [title,message]=notificationText[to];
      const customerMessage=to==='CONFIRMED'?`کسب‌وکار سفارش را پذیرفت؛ زمان آماده‌سازی حدود ${preparationMinutes} دقیقه است.`:message;
      await notify(client,result.rows[0].customer_id,`ORDER_${to}`,title,customerMessage,{orderId:idInput,status:to,preparationMinutes:to==='CONFIRMED'?preparationMinutes:undefined});
      await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'ORDER_STATUS_CHANGED','ORDER',$2,$3::jsonb)`,[user.sub,idInput,JSON.stringify({from,to})]);
      await client.query('COMMIT'); return {id:idInput,fromStatus:from,status:to,estimatedPrepMinutes:to==='CONFIRMED'?preparationMinutes:null};
    } catch(error) { try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ } throw error; }
    finally { client.release(); }
  }

  /**
   * §7.11 — cancelling is a request, and policy decides whether it grants itself.
   *
   * The default rules let a customer cancel alone until the business answers; after that the order
   * is not rewritten by a button any more, a row lands in the operations queue and a human answers
   * it with a reason. Statuses that already reached an outcome are refused outright, because there
   * the correct tool is the refund ledger, not a cancellation.
   */
  async cancel(user: Principal, idInput: unknown, body: { reason?: unknown } = {}) {
    if (typeof idInput !== 'string' || !uuidPattern.test(idInput)) throw new BadRequestException('شناسهٔ سفارش معتبر نیست.');
    const submitted = String(body?.reason ?? '').trim();
    if (submitted.length > 300) throw new BadRequestException('دلیل لغو نباید از ۳۰۰ نویسه بلندتر باشد.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT o.id,o.status,b.owner_id,o.created_at FROM orders o JOIN businesses b ON b.id=o.business_id WHERE o.id=$1 AND o.customer_id=$2 FOR UPDATE OF o',[idInput,user.sub]);
      if (!result.rowCount) throw new NotFoundException('سفارش پیدا نشد.');
      const order = result.rows[0] as { id:string; status:string; owner_id:string; created_at?: Date };
      const verdict = decide(await readPolicy(client), { status: order.status, createdAt: order.created_at ?? new Date() });
      if (verdict.allowed) {
        await client.query(`INSERT INTO cancellation_requests(order_id,requested_by,reason,outcome,decided_at,note) VALUES($1,$2,$3,'ACCEPTED',now(),$4)`,[idInput,user.sub,submitted||'لغو خودکار در بازهٔ مجاز','سیاست لغو این سفارش را بدون تأیید کادر مجاز دانست.']);
        await cancelOrder(client, {
          orderId: idInput, from: order.status, actorId: user.sub, reason: (submitted || 'Customer cancellation').slice(0, 300),
          owner: { userId: order.owner_id, body: 'مشتری سفارش را در بازهٔ مجاز لغو کرد؛ وجهی دریافت نشده بود.' },
        });
        await client.query('COMMIT'); return {id:idInput,status:'CANCELLED'};
      }
      if (verdict.code !== 'STAFF_ONLY' && verdict.code !== 'WINDOW') throw new ConflictException(rejectionMessage(verdict));
      if (submitted.length < 5) throw new BadRequestException('برای بررسی کادر عملیات، دلیل لغو را بنویسید (حداقل ۵ نویسه).');
      const open = await client.query(`SELECT id FROM cancellation_requests WHERE order_id=$1 AND outcome='PENDING'`,[idInput]);
      if (open.rowCount) throw new ConflictException('این سفارش یک درخواست لغو باز دارد؛ نتیجه پیش از پاسخ، دوباره ثبت نمی‌شود.');
      const inserted = await client.query(`INSERT INTO cancellation_requests(order_id,requested_by,reason) VALUES($1,$2,$3) RETURNING id`,[idInput,user.sub,submitted]);
      await writeAudit(client,user.sub,'ORDER_CANCEL_REQUESTED',idInput,{from:order.status,outcome:'PENDING'});
      await notify(client,order.owner_id,'ORDER_CANCELLATION_REQUEST','درخواست لغو مشتری','مشتری خواسته سفارش لغو شود؛ در صف عملیات پاسخ داده می‌شود.',{orderId:idInput},{dedupeKey:`request:${String((inserted.rows[0] as {id:string}).id)}`});
      for (const staff of await staffIds(client, order.owner_id)) {
        await notify(client,staff,'ORDER_CANCELLATION_REVIEW','درخواست لغو برای بررسی',`${rejectionMessage(verdict)} دلیل: ${submitted.slice(0,140)}`,{orderId:idInput,requestId:String((inserted.rows[0] as {id:string}).id)},{dedupeKey:`request:${String((inserted.rows[0] as {id:string}).id)}:review`});
      }
      await client.query('COMMIT');
      return {id:idInput,status:order.status,outcome:'PENDING',requestId:String((inserted.rows[0] as {id:string}).id),message:rejectionMessage(verdict)};
    } catch(error) { try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ } throw error; }
    finally { client.release(); }
  }
}

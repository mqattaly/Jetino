import { Inject, Injectable, BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

type Principal = { sub: string };
type QuoteItem = { productId: string; quantity: number };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class OrdersService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async quote(user: Principal, body: { businessId?: unknown; addressId?: unknown; items?: unknown }) {
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
    const businessResult = await this.pool.query(
      `SELECT b.id,b.name,b.commission_bps,r.id AS region_id,r.name AS region_name,r.delivery_fee_rial
       FROM businesses b JOIN regions r ON r.id=b.region_id
       WHERE b.id=$1 AND b.status='ACTIVE' AND r.is_active=true`, [businessId],
    );
    if (!businessResult.rowCount) throw new NotFoundException('کسب‌وکار فعال پیدا نشد.');
    const business = businessResult.rows[0] as {id:string;name:string;commission_bps:number|null;region_id:string;region_name:string;delivery_fee_rial:string|null};
    const addressResult = await this.pool.query(
      `SELECT a.id,a.label,a.address_text,a.instructions,r.id AS region_id
       FROM addresses a JOIN regions r ON r.id=a.region_id
       WHERE a.id=$1 AND a.user_id=$2 AND r.is_active=true`, [addressId,user.sub],
    );
    if (!addressResult.rowCount) throw new NotFoundException('نشانی انتخاب‌شده پیدا نشد.');
    const address = addressResult.rows[0];
    if (address.region_id !== business.region_id) throw new ConflictException('نشانی در منطقهٔ خدمت این کسب‌وکار قرار ندارد.');
    if (business.delivery_fee_rial === null) throw new ServiceUnavailableException('هزینهٔ ارسال این منطقه هنوز تنظیم نشده است.');
    const products = await this.pool.query(
      `SELECT p.id,p.name,p.price_rial,c.business_id FROM products p JOIN menu_categories c ON c.id=p.category_id
       WHERE p.id=ANY($1::uuid[]) AND p.is_available=true`, [validated.map(item=>item.productId)],
    );
    if (products.rowCount !== validated.length) throw new ConflictException('یک یا چند محصول ناموجود یا حذف شده‌اند؛ سبد را تازه‌سازی کنید.');
    const byId = new Map(products.rows.map((product: {id:string;name:string;price_rial:string;business_id:string})=>[product.id,product]));
    let subtotal = 0n;
    const lines = validated.map(item => {
      const product = byId.get(item.productId)! as {id:string;name:string;price_rial:string;business_id:string};
      if (product.business_id !== business.id) throw new ConflictException('در هر سفارش فقط از یک کسب‌وکار می‌توان خرید کرد.');
      const unitPrice = BigInt(product.price_rial); const lineTotal = unitPrice * BigInt(item.quantity); subtotal += lineTotal;
      return { productId: product.id, productName: product.name, unitPriceRial: unitPrice.toString(), quantity: item.quantity, lineTotalRial: lineTotal.toString() };
    });
    const commissionResult = await this.pool.query(`SELECT value_int FROM platform_settings WHERE key='default_commission_bps'`);
    if (business.commission_bps === null && !commissionResult.rowCount) throw new ServiceUnavailableException('نرخ کمیسیون هنوز تنظیم نشده است.');
    const commissionBps = Number(business.commission_bps ?? commissionResult.rows[0].value_int);
    const commission = (subtotal * BigInt(commissionBps) + 5000n) / 10000n;
    const deliveryFee = BigInt(business.delivery_fee_rial);
    const total = subtotal + deliveryFee;
    const createdAt = new Date();
    return {
      quoteOnly: true,
      orderPlacementEnabled: false,
      currency: 'IRR',
      business: { id: business.id, name: business.name },
      delivery: { addressId: address.id, label: address.label, addressText: address.address_text, instructions: address.instructions, feeRial: deliveryFee.toString() },
      items: lines,
      subtotalRial: subtotal.toString(),
      commission: { rateBps: commissionBps, amountRial: commission.toString() },
      deliveryFeeRial: deliveryFee.toString(),
      totalRial: total.toString(),
      paymentMethods: [],
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime()+3*60*1000).toISOString(),
      message: 'این پیش‌فاکتور نهایی نیست و محصول را رزرو نمی‌کند. ثبت سفارش تا تعیین روش پرداخت غیرفعال است.',
    };
  }
}

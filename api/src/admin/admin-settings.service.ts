import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

type Principal = { sub: string };

@Injectable()
export class AdminSettingsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async get() {
    const [region, commission] = await Promise.all([
      this.pool.query(`SELECT slug,name,delivery_fee_rial FROM regions WHERE slug='bandar-khamir'`),
      this.pool.query(`SELECT value_int FROM platform_settings WHERE key='default_commission_bps'`),
    ]);
    if (!region.rowCount || !commission.rowCount) throw new NotFoundException('تنظیمات اولیهٔ منطقه پیدا نشد؛ migrationها را اجرا کنید.');
    return {
      region: region.rows[0].name,
      regionSlug: region.rows[0].slug,
      deliveryFeeRial: region.rows[0].delivery_fee_rial === null ? null : String(region.rows[0].delivery_fee_rial),
      defaultCommissionBps: Number(commission.rows[0].value_int),
      currency: 'IRR',
    };
  }

  async update(actor: Principal, body: { deliveryFeeRial?: unknown; defaultCommissionBps?: unknown }) {
    const hasFee = body?.deliveryFeeRial !== undefined;
    const hasCommission = body?.defaultCommissionBps !== undefined;
    if (!hasFee && !hasCommission) throw new BadRequestException('حداقل یک تنظیم را برای تغییر بفرستید.');
    const fee = hasFee ? this.parseInteger(body.deliveryFeeRial, 'کرایهٔ ارسال', 0, 100_000_000_000) : undefined;
    const bps = hasCommission ? this.parseInteger(body.defaultCommissionBps, 'کمیسیون', 0, 10000) : undefined;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (fee !== undefined) {
        const result = await client.query(`UPDATE regions SET delivery_fee_rial=$1 WHERE slug='bandar-khamir' RETURNING slug`, [fee]);
        if (!result.rowCount) throw new NotFoundException('منطقهٔ بندر خمیر پیدا نشد.');
        await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'REGION_DELIVERY_FEE_UPDATED','REGION',$2,$3::jsonb)`, [actor.sub,'bandar-khamir',JSON.stringify({deliveryFeeRial:fee})]);
      }
      if (bps !== undefined) {
        await client.query(`UPDATE platform_settings SET value_int=$1,updated_by=$2,updated_at=now() WHERE key='default_commission_bps'`, [bps,actor.sub]);
        await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'DEFAULT_COMMISSION_UPDATED','PLATFORM_SETTING','default_commission_bps',$2::jsonb)`, [actor.sub,JSON.stringify({defaultCommissionBps:bps})]);
      }
      await client.query('COMMIT');
      return this.get();
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    } finally { client.release(); }
  }

  private parseInteger(input: unknown, label: string, min: number, max: number): number {
    const valid = (typeof input === 'number' && Number.isSafeInteger(input)) || (typeof input === 'string' && /^\d+$/.test(input));
    if (!valid) throw new BadRequestException(`${label} باید عدد صحیح باشد.`);
    const value = Number(input);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new BadRequestException(`${label} خارج از محدودهٔ مجاز است.`);
    return value;
  }
}

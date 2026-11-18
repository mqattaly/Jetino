import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

@Injectable()
export class AdminReportsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async summary(periodInput: unknown = '24h') {
    const periods:Record<string,{interval:string;label:string}>={'24h':{interval:'24 hours',label:'۲۴ ساعت اخیر'},'7d':{interval:'7 days',label:'۷ روز اخیر'},'30d':{interval:'30 days',label:'۳۰ روز اخیر'}};
    if(typeof periodInput!=='string'||!periods[periodInput])throw new BadRequestException('بازهٔ گزارش معتبر نیست.');
    const period=periods[periodInput];
    const result = await this.pool.query(
      `SELECT
         COUNT(*)::text AS "totalOrders",
         COUNT(*) FILTER (WHERE created_at >= now() - $1::interval)::text AS "ordersInPeriod",
         COUNT(*) FILTER (WHERE status='PENDING_BUSINESS')::text AS "awaitingBusiness",
         COUNT(*) FILTER (WHERE status IN ('DRIVER_ASSIGNED','OUT_FOR_DELIVERY'))::text AS "inDelivery",
         COUNT(*) FILTER (WHERE status='DELIVERED')::text AS "deliveredOrders",
         COALESCE(SUM(total_rial),0)::text AS "grossOrderValueRial",
         COALESCE(SUM(total_rial) FILTER (WHERE payment_status='PAID'),0)::text AS "cashCollectedRial"
       FROM orders`, [period.interval],
    );
    return { currency: 'IRR', period:periodInput, periodLabel:period.label, generatedAt: new Date().toISOString(), ...result.rows[0] };
  }
}

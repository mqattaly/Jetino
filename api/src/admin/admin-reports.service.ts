import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

@Injectable()
export class AdminReportsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async summary() {
    const result = await this.pool.query(
      `SELECT
         COUNT(*)::text AS "totalOrders",
         COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::text AS "ordersLast24Hours",
         COUNT(*) FILTER (WHERE status='PENDING_BUSINESS')::text AS "awaitingBusiness",
         COUNT(*) FILTER (WHERE status IN ('DRIVER_ASSIGNED','OUT_FOR_DELIVERY'))::text AS "inDelivery",
         COUNT(*) FILTER (WHERE status='DELIVERED')::text AS "deliveredOrders",
         COALESCE(SUM(total_rial),0)::text AS "grossOrderValueRial",
         COALESCE(SUM(total_rial) FILTER (WHERE payment_status='PAID'),0)::text AS "cashCollectedRial"
       FROM orders`,
    );
    return { currency: 'IRR', generatedAt: new Date().toISOString(), ...result.rows[0] };
  }
}

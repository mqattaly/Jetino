import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { notify } from '../notifications/notifications.util';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const periods: Record<string, { interval: string; label: string }> = {
  '24h': { interval: '24 hours', label: '۲۴ ساعت اخیر' },
  '7d': { interval: '7 days', label: '۷ روز اخیر' },
  '30d': { interval: '30 days', label: '۳۰ روز اخیر' },
};

type Principal = { sub: string };

@Injectable()
export class AdminReportsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async summary(periodInput: unknown = '24h') {
    if (typeof periodInput !== 'string' || !periods[periodInput]) throw new BadRequestException('بازهٔ گزارش معتبر نیست.');
    const period = periods[periodInput];
    const result = await this.pool.query(
      `SELECT
         COUNT(*)::text AS "totalOrders",
         COUNT(*) FILTER (WHERE created_at >= now() - $1::interval)::text AS "ordersInPeriod",
         COUNT(*) FILTER (WHERE status='PENDING_BUSINESS')::text AS "awaitingBusiness",
         COUNT(*) FILTER (WHERE status IN ('DRIVER_ASSIGNED','OUT_FOR_DELIVERY'))::text AS "inDelivery",
         COUNT(*) FILTER (WHERE status='DELIVERED')::text AS "deliveredOrders",
         COALESCE(SUM(total_rial),0)::text AS "grossOrderValueRial",
         COALESCE(SUM(total_rial) FILTER (WHERE payment_status='PAID'),0)::text AS "cashCollectedRial",
         COALESCE((SELECT SUM(amount_rial) FROM cash_collections WHERE settlement_id IS NULL),0)::text AS "unsettledCashRial",
         COALESCE((SELECT COUNT(*) FROM cash_collections WHERE settlement_id IS NULL),0)::text AS "unsettledCollections"
       FROM orders`, [period.interval],
    );
    return { currency: 'IRR', period: periodInput, periodLabel: period.label, generatedAt: new Date().toISOString(), ...result.rows[0] };
  }

  async cashOutstanding() {
    const result = await this.pool.query(
      `SELECT d.id AS "driverId", u.phone AS "driverPhone", r.name AS "regionName",
              COUNT(cc.id)::int AS "openCount",
              COALESCE(SUM(cc.amount_rial),0)::text AS "openCashRial",
              MAX(cc.collected_at) AS "lastCollectedAt"
       FROM cash_collections cc
       JOIN drivers d ON d.user_id=cc.collected_by
       JOIN users u ON u.id=d.user_id
       JOIN regions r ON r.id=d.region_id
       WHERE cc.settlement_id IS NULL
       GROUP BY d.id,u.phone,r.name
       ORDER BY COALESCE(SUM(cc.amount_rial),0) DESC`,
    );
    return result.rows;
  }

  async settle(actor: Principal, driverIdInput: unknown, expectedAmountInput: unknown, noteInput?: unknown) {
    if (typeof driverIdInput !== 'string' || !uuid.test(driverIdInput)) throw new BadRequestException('شناسهٔ راننده معتبر نیست.');
    if (typeof expectedAmountInput !== 'string' || !/^\d+$/.test(expectedAmountInput)) throw new BadRequestException('مبلغ قابل تسویه را به رقم انگلیسی وارد کنید.');
    const expected = BigInt(expectedAmountInput);
    if (expected <= 0n) throw new BadRequestException('مبلغ تسویه باید بزرگ‌تر از صفر باشد.');
    const note = noteInput === undefined || noteInput === null || noteInput === '' ? null : String(noteInput).trim().slice(0, 280);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const driver = await client.query(`SELECT d.id,d.user_id FROM drivers d WHERE d.id=$1 FOR UPDATE`, [driverIdInput]);
      if (!driver.rowCount) throw new NotFoundException('راننده پیدا نشد.');
      const driverUserId = driver.rows[0].user_id as string;
      const open = await client.query(
        `SELECT id,amount_rial FROM cash_collections WHERE settlement_id IS NULL AND collected_by=$1 ORDER BY collected_at,id FOR UPDATE`, [driverUserId],
      );
      if (!open.rowCount) throw new ConflictException('وجه باز برای تسویه این راننده ثبت نشده است.');
      const total = open.rows.reduce((sum: bigint, row: { amount_rial: string }) => sum + BigInt(row.amount_rial), 0n);
      if (total !== expected) throw new ConflictException(`مبلغ باز این راننده ${total.toString()} ریال است؛ فهرست را تازه‌سازی کنید.`);
      const settlement = await client.query(
        `INSERT INTO cash_settlements(driver_id,amount_rial,order_count,settled_by,note) VALUES($1,$2,$3,$4,$5) RETURNING id,settled_at`,
        [driverIdInput, total.toString(), open.rowCount, actor.sub, note],
      );
      const settlementId = settlement.rows[0].id as string;
      await client.query(`UPDATE cash_collections SET settlement_id=$1 WHERE id=ANY($2::uuid[])`, [settlementId, open.rows.map((row: { id: string }) => row.id)]);
      await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'CASH_SETTLEMENT_RECORDED','CASH_SETTLEMENT',$2,$3::jsonb)`, [actor.sub, settlementId, JSON.stringify({ driverId: driverIdInput, amountRial: total.toString(), orderCount: open.rowCount })]);
      await notify(client, driverUserId, 'CASH_SETTLED', 'تسویه وجه نقد انجام شد', `مبلغ ${total.toString()} ریال از ${open.rowCount} سفارش تسویه شد.`, { driverId: driverIdInput, amountRial: total.toString(), settlementId });
      await client.query('COMMIT');
      return { id: settlementId, driverId: driverIdInput, amountRial: total.toString(), orderCount: open.rowCount, settledAt: settlement.rows[0].settled_at };
    } catch (error) { try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ } throw error; }
    finally { client.release(); }
  }
}

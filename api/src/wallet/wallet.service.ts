import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

/** Wallet credit is the net of explicitly wallet-destined, append-only refund rows.
 * Old refunds have an unknown destination and are intentionally excluded. */
@Injectable()
export class WalletService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async mine(user: { sub: string }) {
    // One statement gives a consistent snapshot of balance and recent transactions.
    const result = await this.pool.query(`
      WITH entries AS (
        SELECT r.id, r.order_id, r.amount_rial, r.kind, r.reason, r.created_at
        FROM order_refunds r JOIN orders o ON o.id=r.order_id
        WHERE o.customer_id=$1 AND r.destination='WALLET'
      )
      SELECT COALESCE((SELECT SUM(amount_rial) FROM entries), 0)::text AS "balanceRial",
             COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'id', x.id, 'orderId', x.order_id, 'amountRial', x.amount_rial::text,
               'kind', x.kind, 'reason', x.reason, 'createdAt', x.created_at
             ) ORDER BY x.created_at DESC, x.id DESC)
             FROM (SELECT * FROM entries ORDER BY created_at DESC,id DESC LIMIT 50) x), '[]'::jsonb) AS items`, [user.sub]);
    return result.rows[0] as { balanceRial: string; items: Array<{ id: string; orderId: string; amountRial: string; kind: string; reason: string; createdAt: string }> };
  }
}

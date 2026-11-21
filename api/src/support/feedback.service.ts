import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { notify } from '../notifications/notifications.util';

/**
 * Ratings are written once per delivered order and stay editable by their author,
 * because a customer who notices a typo must not have to open a support ticket for
 * it. They are deliberately impossible to write before delivery: a rating on a
 * pending order is pressure on the kitchen, not feedback about it.
 */

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_COMMENT = 500;
type Principal = { sub: string; roles?: string[] };

export function requireId(value: unknown, label = 'سفارش'): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new BadRequestException(`${label} معتبر نیست.`);
  return value;
}

/** Shared with the support module: the same identifier rule everywhere. */
export const parseId = requireId;

export function stars(value: unknown, label: string, required: boolean): number | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BadRequestException(`${label} لازم است.`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) throw new BadRequestException(`${label} باید عددی بین ۱ تا ۵ باشد.`);
  return parsed;
}

export function message(value: unknown, max: number, label: string): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (text.length > max) throw new BadRequestException(`${label} نباید بیشتر از ${max} نویسه باشد.`);
  return text;
}

const shape = (row: Record<string, unknown>) => ({
  id: row.id,
  orderId: row.order_id,
  orderCode: String(row.order_id).slice(0, 8).toUpperCase(),
  businessRating: Number(row.business_rating),
  driverRating: row.driver_rating === null ? null : Number(row.driver_rating),
  comment: row.comment ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

@Injectable()
export class FeedbackService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async save(user: Principal, orderIdInput: unknown, body: { businessRating?: unknown; driverRating?: unknown; comment?: unknown }) {
    const orderId = requireId(orderIdInput);
    const businessRating = stars(body?.businessRating, 'امتیاز کسب‌وکار', true);
    const driverRating = stars(body?.driverRating, 'امتیاز پیک', false);
    const comment = message(body?.comment, MAX_COMMENT, 'بازخورد');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const order = await client.query(
        `SELECT o.id,o.status,o.business_id,da.driver_id
         FROM orders o
         LEFT JOIN delivery_assignments da ON da.order_id=o.id
         WHERE o.id=$1 AND o.customer_id=$2 FOR UPDATE OF o`, [orderId, user.sub],
      );
      if (!order.rowCount) throw new NotFoundException('سفارش پیدا نشد یا به این حساب مربوط نیست.');
      const row = order.rows[0] as { id: string; status: string; business_id: string; driver_id: string | null };
      if (row.status !== 'DELIVERED') throw new ConflictException('امتیازدهی فقط پس از تحویل سفارش ممکن است.');
      if (driverRating !== null && !row.driver_id) throw new BadRequestException('این سفارش رانندهٔ تخصیص‌یافته ندارد؛ امتیاز پیک ثبت نمی‌شود.');

      const existing = await client.query('SELECT id,user_id FROM order_feedback WHERE order_id=$1', [orderId]);
      if (existing.rowCount && (existing.rows[0] as { user_id: string; }).user_id !== user.sub) {
        throw new ConflictException('این سفارش قبلاً بازخورد گرفته است.');
      }

      const saved = await client.query(
        `INSERT INTO order_feedback(order_id,user_id,business_id,driver_id,business_rating,driver_rating,comment)
         VALUES($1,$2,$3,$4,$5,$6,NULLIF($7,''))
         ON CONFLICT(order_id) DO UPDATE
           SET business_rating=EXCLUDED.business_rating,driver_rating=EXCLUDED.driver_rating,comment=EXCLUDED.comment,updated_at=now()
         RETURNING id,order_id,business_rating,driver_rating,comment,created_at,updated_at`,
        [orderId, user.sub, row.business_id, row.driver_id, businessRating, driverRating, comment],
      );
      const created = !existing.rowCount;
      if (created) {
        const business = await client.query('SELECT owner_id,name FROM businesses WHERE id=$1', [row.business_id]);
        const owner = (business.rows[0] ?? {}) as { owner_id?: string; name?: string };
        if (owner.owner_id && owner.owner_id !== user.sub) {
          const low = businessRating! <= 2;
          await notify(client, owner.owner_id, 'ORDER_FEEDBACK', low ? 'بازخورد نیازمند توجه' : 'بازخورد جدید سفارش',
            `${owner.name}: ${businessRating} ستاره${comment ? ` — ${comment.slice(0, 120)}` : ''}`, { orderId, businessRating, needsAttention: low });
        }
        if (row.driver_id && driverRating !== null) {
          const driver = await client.query('SELECT user_id FROM drivers WHERE id=$1', [row.driver_id]);
          const driverUser = (driver.rows[0] ?? {}) as { user_id?: string };
          if (driverUser.user_id) {
            await notify(client, driverUser.user_id, 'DRIVER_FEEDBACK', 'امتیاز پیک ثبت شد', `امتیاز شما به این تحویل: ${driverRating} ستاره.`, { orderId, driverRating });
          }
        }
      }
      await client.query('COMMIT');
      return { ...shape(saved.rows[0] as Record<string, unknown>), created };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async forOrder(user: Principal, orderIdInput: unknown) {
    const orderId = requireId(orderIdInput);
    const result = await this.pool.query(
      `SELECT f.id,f.order_id,f.business_rating,f.driver_rating,f.comment,f.created_at,f.updated_at
       FROM order_feedback f JOIN orders o ON o.id=f.order_id JOIN businesses b ON b.id=o.business_id
       LEFT JOIN delivery_assignments da ON da.order_id=o.id
       LEFT JOIN drivers d ON d.id=da.driver_id
       WHERE f.order_id=$1 AND (o.customer_id=$2 OR b.owner_id=$2 OR d.user_id=$2 OR $3::boolean)`,
      [orderId, user.sub, FeedbackService.isStaff(user)],
    );
    if (!result.rowCount) return null;
    return shape(result.rows[0] as Record<string, unknown>);
  }

  static isStaff(user: Principal): boolean {
    return ['SUPER_ADMIN', 'OPERATIONS_MANAGER'].some(role => user.roles?.includes(role));
  }

  /** Aggregate plus the recent tail, so a shop can answer complaints, not just see a score. */
  async forBusiness(user: Principal, businessIdInput: unknown, limitInput?: string, offsetInput?: string) {
    const businessId = requireId(businessIdInput, 'کسب‌وکار');
    const limit = FeedbackService.page(limitInput, offsetInput);
    const access = await this.pool.query('SELECT id FROM businesses WHERE id=$1 AND (owner_id=$2 OR $3::boolean)', [businessId, user.sub, FeedbackService.isStaff(user)]);
    if (!access.rowCount) throw new NotFoundException('کسب‌وکار پیدا نشد یا دسترسی ندارید.');
    const [rows, stats] = await Promise.all([
      this.pool.query(
        `SELECT f.id,f.order_id,f.business_rating,f.driver_rating,f.comment,f.created_at,f.updated_at,u.display_name AS "authorName"
         FROM order_feedback f JOIN users u ON u.id=f.user_id
         WHERE f.business_id=$1 ORDER BY f.created_at DESC,f.id DESC LIMIT $2 OFFSET $3`, [businessId, limit.limit, limit.offset],
      ),
      this.pool.query(
        `SELECT COUNT(*)::int AS "feedbackCount",ROUND(AVG(business_rating)::numeric,2)::float AS "averageBusinessRating",
                ROUND(AVG(NULLIF(driver_rating,0))::numeric,2)::float AS "averageDriverRating",
                COUNT(*) FILTER (WHERE business_rating<=2)::int AS "needsAttention"
         FROM order_feedback WHERE business_id=$1`, [businessId],
      ),
    ]);
    return { ...stats.rows[0], items: rows.rows.map(row => ({ ...shape(row as Record<string, unknown>), authorName: (row as { authorName?: string }).authorName ?? null })), ...limit };
  }

  async forDriver(user: Principal, limitInput?: string, offsetInput?: string) {
    const limit = FeedbackService.page(limitInput, offsetInput);
    const profile = await this.pool.query(`SELECT id FROM drivers WHERE user_id=$1 AND status='ACTIVE'`, [user.sub]);
    if (!profile.rowCount) throw new NotFoundException('حساب رانندهٔ فعال پیدا نشد.');
    const driverId = (profile.rows[0] as { id: string }).id;
    const [rows, stats] = await Promise.all([
      this.pool.query(
        `SELECT f.id,f.order_id,f.business_rating,f.driver_rating,f.comment,f.created_at,f.updated_at
         FROM order_feedback f WHERE f.driver_id=$1 AND f.driver_rating IS NOT NULL ORDER BY f.created_at DESC,f.id DESC LIMIT $2 OFFSET $3`,
        [driverId, limit.limit, limit.offset],
      ),
      this.pool.query(`SELECT COUNT(*)::int AS "feedbackCount",ROUND(AVG(driver_rating)::numeric,2)::float AS "averageDriverRating" FROM order_feedback WHERE driver_id=$1 AND driver_rating IS NOT NULL`, [driverId]),
    ]);
    return { ...stats.rows[0], items: rows.rows.map(row => shape(row as Record<string, unknown>)), ...limit };
  }

  /** Staff moderation: the abusive tail of a public score must be removable. */
  async listForStaff(filters: { maxStars?: unknown; businessId?: unknown; limit?: unknown; offset?: unknown }) {
    const maxStars = filters.maxStars === undefined || filters.maxStars === '' ? null : Number(filters.maxStars);
    if (maxStars !== null && (!Number.isInteger(maxStars) || maxStars < 1 || maxStars > 5)) throw new BadRequestException('سقف امتیاز معتبر نیست.');
    const where: string[] = [];
    const values: unknown[] = [];
    if (maxStars !== null) { values.push(maxStars); where.push(`f.business_rating <= $${values.length}`); }
    if (filters.businessId) {
      const businessId = requireId(filters.businessId, 'کسب‌وکار');
      values.push(businessId);
      where.push(`f.business_id = $${values.length}`);
    }
    const limit = FeedbackService.page(filters.limit, filters.offset);
    const result = await this.pool.query(
      `SELECT f.id,f.order_id,f.business_rating,f.driver_rating,f.comment,f.created_at,f.updated_at,
              b.name AS "businessName",d.id IS NOT NULL AS "hasDriver"
       FROM order_feedback f JOIN businesses b ON b.id=f.business_id
       LEFT JOIN drivers d ON d.id=f.driver_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY f.created_at DESC,f.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit.limit, limit.offset],
    );
    const count = await this.pool.query(`SELECT COUNT(*)::int AS "totalMatches" FROM order_feedback f ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, values);
    return { items: result.rows.map(row => ({ ...shape(row as Record<string, unknown>), businessName: (row as { businessName?: string }).businessName ?? null })), ...limit, totalMatches: (count.rows[0] as { totalMatches: number }).totalMatches };
  }

  async remove(user: Principal, idInput: unknown, reason: unknown) {
    const id = requireId(idInput, 'بازخورد');
    const note = message(reason, 300, 'دلیل');
    if (!note) throw new BadRequestException('برای حذف بازخورد، دلیل لازم است.');
    const result = await this.pool.query('DELETE FROM order_feedback WHERE id=$1 RETURNING id,order_id,business_rating,business_id', [id]);
    if (!result.rowCount) throw new NotFoundException('بازخورد پیدا نشد.');
    await this.pool.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'FEEDBACK_REMOVED','ORDER_FEEDBACK',$2,$3::jsonb)`, [
      user.sub, id, JSON.stringify({ reason: note, removedBy: user.roles?.includes('SUPER_ADMIN') ? 'SUPER_ADMIN' : 'OPERATIONS_MANAGER' }),
    ]);
    return { id, removed: true };
  }

  static page(limitInput: unknown, offsetInput: unknown): { limit: number; offset: number } {
    const rawLimit = limitInput === undefined || limitInput === '' ? 25 : Number(limitInput);
    const rawOffset = offsetInput === undefined || offsetInput === '' ? 0 : Number(offsetInput);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100 || !Number.isInteger(rawOffset) || rawOffset < 0) throw new BadRequestException('صفحه‌بندی معتبر نیست.');
    return { limit: rawLimit, offset: rawOffset };
  }
}

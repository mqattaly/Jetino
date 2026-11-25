import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { notify } from '../notifications/notifications.util';
import { staffIds } from '../cancellations/cancellation-writes';
import { RateLimitService } from '../security/rate-limit.service';

type Principal = { sub: string; roles?: string[] };
type Role = 'CUSTOMER' | 'BUSINESS' | 'DRIVER';
const CATEGORIES = ['UNSAFE', 'HARASSMENT', 'ACCIDENT', 'OTHER'];
const STAFF_ROLES = ['SUPER_ADMIN', 'OPERATIONS_MANAGER', 'SUPPORT'];
const STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const categoryLabel: Record<string, string> = {
  UNSAFE: 'احساس ناامنی',
  HARASSMENT: 'مزاحمت یا رفتار تهدیدآمیز',
  ACCIDENT: 'حادثه یا آسیب',
  OTHER: 'موضوع دیگر',
};

/**
 * The emergency button. It is deliberately small and boring: one row in the
 * operations queue, one audit entry, and a notification to every staff member.
 * It never talks to the other party on its own — a human decides what happens next.
 */
@Injectable()
export class SafetyService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
  ) {}

  private async party(user: Principal, orderId: string): Promise<{ role: Role; customerId: string; driverUserId: string | null }> {
    if (!uuidPattern.test(orderId)) throw new BadRequestException('شناسهٔ سفارش معتبر نیست.');
    const result = await this.pool.query(
      `SELECT o.customer_id, b.owner_id, d.user_id AS driver_user_id
       FROM orders o JOIN businesses b ON b.id=o.business_id
       LEFT JOIN delivery_assignments da ON da.order_id=o.id
       LEFT JOIN drivers d ON d.id=da.driver_id
       WHERE o.id=$1`,
      [orderId],
    );
    if (!result.rowCount) throw new NotFoundException('سفارش پیدا نشد.');
    const row = result.rows[0];
    if (row.customer_id === user.sub) return { role: 'CUSTOMER', customerId: row.customer_id, driverUserId: row.driver_user_id };
    if (row.owner_id === user.sub) return { role: 'BUSINESS', customerId: row.customer_id, driverUserId: row.driver_user_id };
    if (row.driver_user_id === user.sub) return { role: 'DRIVER', customerId: row.customer_id, driverUserId: row.driver_user_id };
    throw new NotFoundException('این سفارش به حساب شما مربوط نیست.');
  }

  async raise(user: Principal, body: { orderId?: unknown; category?: unknown; note?: unknown }) {
    if (typeof body?.orderId !== 'string') throw new BadRequestException('برای ثبت گزارش ایمنی، سفارش جاری را مشخص کنید.');
    const category = body.category === undefined ? 'OTHER' : body.category;
    if (typeof category !== 'string' || !CATEGORIES.includes(category)) throw new BadRequestException('نوع گزارش ایمنی معتبر نیست.');
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > 500) throw new BadRequestException('توضیحات حداکثر ۵۰۰ نویسه است.');
    await this.rateLimit.enforce(`safety.sos:${user.sub}`, 5, 600, 'تعداد گزارش‌های ایمنی ثبت‌شده زیاد است.');
    const orderId = body.orderId;
    const party = await this.party(user, orderId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO safety_events(order_id,raised_by,raised_role,category,note) VALUES($1,$2,$3,$4,$5) RETURNING id,status,created_at`,
        [orderId, user.sub, party.role, category, note || null],
      );
      const event = inserted.rows[0];
      const shortOrder = orderId.slice(0, 8).toUpperCase();
      for (const staff of await staffIds(client, user.sub)) {
        await notify(
          client,
          staff,
          'SOS_RAISED',
          'گزارش ایمنی فوری',
          `سفارش ${shortOrder} · ${categoryLabel[category]} · ${party.role === 'DRIVER' ? 'پیک' : party.role === 'BUSINESS' ? 'کسب‌وکار' : 'مشتری'}`,
          { orderId, eventId: event.id, category },
        );
      }
      await client.query(
        `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'SOS_RAISED','SAFETY_EVENT',$2,$3::jsonb)`,
        [user.sub, event.id, JSON.stringify({ orderId, category, role: party.role })],
      );
      await client.query('COMMIT');
      return { id: event.id, status: event.status, reference: String(event.id).slice(0, 8).toUpperCase(), createdAt: event.created_at, message: 'پشتیبانی مطلع شد؛ اگر در خطر هستید با ۱۱۰ تماس بگیرید.' };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* closed */ }
      if ((error as { code?: string }).code === '23505') throw new ConflictException('برای این سفارش یک گزارش باز دارید؛ پشتیبانی در حال بررسی آن است.');
      throw error;
    } finally {
      client.release();
    }
  }

  async detail(user: Principal, id: string) {
    if (!uuidPattern.test(id)) throw new BadRequestException('شناسهٔ گزارش معتبر نیست.');
    const result = await this.pool.query(
      `SELECT id,order_id AS "orderId",raised_by AS "raisedBy",raised_role AS "raisedRole",category,note,status,resolution,created_at AS "createdAt",handled_at AS "handledAt"
       FROM safety_events WHERE id=$1`,
      [id],
    );
    if (!result.rowCount) throw new NotFoundException('گزارش پیدا نشد.');
    const row = result.rows[0];
    const isStaff = STAFF_ROLES.some(role => user.roles?.includes(role));
    if (row.raisedBy !== user.sub && !isStaff) throw new NotFoundException('گزارش پیدا نشد.');
    return row;
  }

  async queue(statusInput?: string) {
    const status = statusInput || 'OPEN';
    if (!STATUSES.includes(status)) throw new BadRequestException('وضعیت گزارش معتبر نیست.');
    const result = await this.pool.query(
      `SELECT e.id,e.order_id AS "orderId",e.category,e.note,e.status,e.created_at AS "createdAt",e.raised_role AS "raisedRole",e.resolution,
              u.phone AS "raisedPhone",d.plate_number AS "driverPlate",d.full_name AS "driverName"
       FROM safety_events e
       JOIN users u ON u.id=e.raised_by
       LEFT JOIN orders o ON o.id=e.order_id
       LEFT JOIN delivery_assignments da ON da.order_id=o.id
       LEFT JOIN drivers d ON d.id=da.driver_id
       WHERE e.status=$1 ORDER BY e.created_at ASC LIMIT 100`,
      [status],
    );
    return result.rows;
  }

  async handle(actor: string, id: string, body: { status?: unknown; resolution?: unknown }) {
    if (!uuidPattern.test(id)) throw new BadRequestException('شناسهٔ گزارش معتبر نیست.');
    const status = body?.status;
    if (status !== 'ACKNOWLEDGED' && status !== 'RESOLVED') throw new BadRequestException('وضعیت جدید مجاز نیست.');
    const resolution = typeof body.resolution === 'string' ? body.resolution.trim() : '';
    if (status === 'RESOLVED' && resolution.length < 3) throw new BadRequestException('برای بستن گزارش، نتیجه را دست‌کم در ۳ نویسه بنویسید.');
    if (resolution.length > 300) throw new BadRequestException('نتیجهٔ گزارش حداکثر ۳۰۰ نویسه است.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(`SELECT id,status,raised_by FROM safety_events WHERE id=$1 FOR UPDATE`, [id]);
      if (!found.rowCount) throw new NotFoundException('گزارش پیدا نشد.');
      const current = found.rows[0];
      if (current.status === 'RESOLVED') throw new ConflictException('این گزارش قبلاً بسته شده است.');
      if (status === 'ACKNOWLEDGED' && current.status !== 'OPEN') throw new ConflictException('این گزارش قبلاً برداشته شده است.');
      const updated = await client.query(
        `UPDATE safety_events SET status=$2,resolution=COALESCE(NULLIF($3,''),resolution),handled_by=$4,handled_at=now() WHERE id=$1 RETURNING id,status,resolution,handled_at AS "handledAt"`,
        [id, status, resolution, actor],
      );
      await client.query(
        `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'SOS_HANDLED','SAFETY_EVENT',$2,$3::jsonb)`,
        [actor, id, JSON.stringify({ status, resolution })],
      );
      await notify(
        client,
        current.raised_by,
        'SOS_UPDATED',
        status === 'RESOLVED' ? 'گزارش ایمنی بسته شد' : 'گزارش ایمنی شما در حال بررسی است',
        status === 'RESOLVED' ? `نتیجه: ${resolution}` : 'پشتیبانی گزارش شما را برداشته و پیگیری می‌کند.',
        { eventId: id, status },
      );
      await client.query('COMMIT');
      return updated.rows[0];
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* closed */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

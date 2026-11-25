import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { notify } from '../notifications/notifications.util';
import { message, requireId } from './feedback.service';

/**
 * A ticket is a thread, not a form: whoever is allowed to see the order is allowed
 * to keep arguing in the thread, and status only moves along a short rail. Staff
 * replies pull a ticket out of OPEN, and when a customer answers a resolved ticket
 * it goes back to OPEN by itself — a resolved flag must never be able to silence
 * someone who still has a problem.
 */

const STAFF_ROLES = ['SUPER_ADMIN', 'OPERATIONS_MANAGER'];
const STATUSES = ['OPEN', 'IN_REVIEW', 'RESOLVED', 'CLOSED'];
const TRANSITIONS: Record<string, string[]> = { OPEN: ['IN_REVIEW', 'RESOLVED', 'CLOSED'], IN_REVIEW: ['RESOLVED', 'CLOSED'], RESOLVED: ['IN_REVIEW', 'CLOSED'], CLOSED: [] };
const MAX_BODY = 2000;

type Principal = { sub: string; roles?: string[] };
const isStaff = (user: Principal) => STAFF_ROLES.some(role => user.roles?.includes(role));

/**
 * Who may see a thread: the reporter, staff, anybody who has already answered, and the
 * two parties of the order it is about. `base` is the placeholder holding the viewer id so
 * the fragment can be reused at different offsets — PostgreSQL refuses a parameter whose
 * type it cannot infer, so every placeholder here has to be used.
 */
const accessSql = (base: number, staff: number) => `
  t.opened_by=$${base}
  OR $${staff}::boolean
  OR EXISTS (SELECT 1 FROM support_messages m WHERE m.ticket_id=t.id AND m.author_id=$${base})
  OR EXISTS (SELECT 1 FROM orders o JOIN businesses b ON b.id=o.business_id WHERE o.id=t.order_id AND (o.customer_id=$${base} OR b.owner_id=$${base}))
  OR EXISTS (SELECT 1 FROM delivery_assignments da JOIN drivers d ON d.id=da.driver_id WHERE da.order_id=t.order_id AND d.user_id=$${base})`;

@Injectable()
export class SupportService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async open(user: Principal, body: { orderId?: unknown; message?: unknown }) {
    const text = message(body?.message, MAX_BODY, 'متن پیام');
    // a floor of a few characters keeps "hi" out of the queue without turning
    // a short, real complaint into a validation failure
    if (text.length < 5) throw new BadRequestException('برای ثبت مشکل، پیام را کامل‌تر بنویسید.');
    const orderId = body?.orderId === undefined || body?.orderId === '' ? null : requireId(body.orderId, 'سفارش');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let counterparty: { customer_id: string; owner_id: string } | null = null;
      if (orderId) {
        const order = await client.query(
          `SELECT o.id,o.customer_id,b.owner_id,d.user_id AS driver_user_id
           FROM orders o JOIN businesses b ON b.id=o.business_id
           LEFT JOIN delivery_assignments da ON da.order_id=o.id
           LEFT JOIN drivers d ON d.id=da.driver_id
           WHERE o.id=$1 AND (o.customer_id=$2 OR b.owner_id=$2 OR d.user_id=$2 OR $3::boolean)`, [orderId, user.sub, isStaff(user)],
        );
        if (!order.rowCount) throw new NotFoundException('سفارش پیدا نشد یا به این حساب مربوط نیست.');
        counterparty = order.rows[0] as { customer_id: string; owner_id: string };
        const existing = await client.query(
          `SELECT id FROM support_tickets WHERE order_id=$1 AND opened_by=$2 AND status IN ('OPEN','IN_REVIEW') FOR UPDATE`, [orderId, user.sub],
        );
        if (existing.rowCount) throw new ConflictException('برای این سفارش گفت‌وگوی بازی وجود دارد؛ پاسخ خود را در همان ثبت کنید.');
      }
      const ticket = await client.query(
        `INSERT INTO support_tickets(order_id,opened_by) VALUES($1,$2) RETURNING id,status,created_at`, [orderId, user.sub],
      );
      const ticketId = (ticket.rows[0] as { id: string }).id;
      await client.query('INSERT INTO support_messages(ticket_id,author_id,body,from_staff) VALUES($1,$2,$3,$4)', [ticketId, user.sub, text, isStaff(user)]);
      await client.query(`INSERT INTO support_ticket_events(ticket_id,actor_id,from_status,to_status) VALUES($1,$2,NULL,'OPEN')`, [ticketId, user.sub]);
      await client.query('UPDATE support_tickets SET updated_at=now() WHERE id=$1', [ticketId]);
      for (const userId of await this.staffIds(client)) {
        if (userId !== user.sub) await notify(client, userId, 'SUPPORT_TICKET_OPENED', 'گزارش جدید پشتیبانی', text.slice(0, 140), { ticketId, orderId }, { dedupeKey: ticketId });
      }
      // the other side of the order is told a complaint about it was opened, but the
      // thread itself stays between the reporter and support staff
      if (counterparty) {
        const watched = counterparty.customer_id === user.sub ? counterparty.owner_id : counterparty.customer_id;
        if (watched !== user.sub) {
          await notify(client, watched, 'SUPPORT_TICKET_OPENED', 'گزارشی دربارهٔ سفارش شما ثبت شد', 'کادر پشتیبانی در جریان است؛ برای توضیح بیشتر با آن‌ها گفت‌وگو کنید.', { ticketId, orderId }, { dedupeKey: ticketId });
        }
      }
      await client.query('COMMIT');
      return { id: ticketId, status: 'OPEN', orderId, createdAt: (ticket.rows[0] as { created_at: unknown }).created_at };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Bound as one placeholder per role instead of `= ANY($1)` with an array: that form
   * depends on the driver serialising the array literal, and a driver that joins the
   * values instead fails with a malformed-array error on a perfectly good query.
   */
  private async staffIds(client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> }): Promise<string[]> {
    const placeholders = STAFF_ROLES.map((_, index) => `$${index + 1}`).join(',');
    const result = await client.query(`SELECT DISTINCT ur.user_id FROM user_roles ur WHERE ur.role IN (${placeholders})`, STAFF_ROLES);
    return (result.rows as Array<{ user_id: string }>).map(row => row.user_id).slice(0, 20);
  }

  private async readable(user: Principal, ticketId: string) {
    const result = await this.pool.query(`SELECT t.id,t.order_id,t.opened_by,t.status,t.created_at,t.updated_at FROM support_tickets t WHERE t.id=$1 AND (${accessSql(2, 3)})`, [ticketId, user.sub, isStaff(user)]);
    if (!result.rowCount) throw new NotFoundException('گزارش پیدا نشد یا به آن دسترسی ندارید.');
    return result.rows[0] as { id: string; order_id: string | null; opened_by: string; status: string; created_at: Date; updated_at: Date };
  }

  async mine(user: Principal, filters: { status?: unknown; limit?: unknown; offset?: unknown }) {
    const status = filters.status && filters.status !== '' ? String(filters.status) : null;
    if (status && !STATUSES.includes(status)) throw new BadRequestException('وضعیت گزارش معتبر نیست.');
    const limit = SupportService.page(filters.limit, filters.offset);
    const where = [`(${accessSql(1, 2)})`];
    const values: unknown[] = [user.sub, isStaff(user)];
    if (status) { values.push(status); where.push(`t.status = $${values.length}`); }
    const rows = await this.pool.query(
      `SELECT t.id,t.order_id,t.status,t.created_at,t.updated_at,t.opened_by,
              (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id=t.id)::int AS "messageCount",
              (SELECT m.body FROM support_messages m WHERE m.ticket_id=t.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS "lastMessage",
              o.id IS NOT NULL AS "hasOrder"
       FROM support_tickets t LEFT JOIN orders o ON o.id=t.order_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.updated_at DESC,t.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit.limit, limit.offset],
    );
    const count = await this.pool.query(`SELECT COUNT(*)::int AS "totalMatches" FROM support_tickets t WHERE ${where.join(' AND ')}`, values);
    return {
      items: (rows.rows as Array<Record<string, unknown>>).map(row => ({
        id: row.id, orderId: row.order_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
        messageCount: row.messageCount, lastMessage: row.lastMessage ? String(row.lastMessage).slice(0, 160) : null, mine: row.opened_by === user.sub,
      })),
      totalMatches: (count.rows[0] as { totalMatches: number }).totalMatches,
      ...limit,
    };
  }

  async detail(user: Principal, ticketIdInput: unknown) {
    const ticket = await this.readable(user, requireId(ticketIdInput, 'گزارش'));
    const [messages, events] = await Promise.all([
      this.pool.query(
        `SELECT m.id,m.body,m.from_staff AS "fromStaff",m.created_at AS "createdAt",u.display_name AS "authorName"
         FROM support_messages m JOIN users u ON u.id=m.author_id WHERE m.ticket_id=$1 ORDER BY m.created_at,m.id`, [ticket.id],
      ),
      this.pool.query(
        `SELECT e.from_status AS "fromStatus",e.to_status AS "toStatus",e.note,e.created_at AS "createdAt",u.display_name AS "actorName"
         FROM support_ticket_events e JOIN users u ON u.id=e.actor_id WHERE e.ticket_id=$1 ORDER BY e.created_at,e.id DESC`, [ticket.id],
      ),
    ]);
    return {
      id: ticket.id, orderId: ticket.order_id, status: ticket.status, createdAt: ticket.created_at, updatedAt: ticket.updated_at,
      // read-only once closed: the API refuses a reply there too, but the UI must not offer it
      mine: ticket.opened_by === user.sub,
      canReply: ticket.status !== 'CLOSED',
      canChangeStatus: (isStaff(user) || ticket.opened_by === user.sub) && ticket.status !== 'CLOSED',
      messages: messages.rows, events: events.rows,
    };
  }

  async reply(user: Principal, ticketIdInput: unknown, body: { message?: unknown }) {
    const text = message(body?.message, MAX_BODY, 'متن پیام');
    if (text.length < 2) throw new BadRequestException('پاسخ خالی نمی‌تواند ثبت شود.');
    const ticketId = requireId(ticketIdInput, 'گزارش');
    const ticket = await this.readable(user, ticketId);
    if (ticket.status === 'CLOSED') throw new ConflictException('این گزارش بسته شده و پاسخ جدید پذیرفته نمی‌شود.');
    const staff = isStaff(user);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO support_messages(ticket_id,author_id,body,from_staff) VALUES($1,$2,$3,$4)', [ticketId, user.sub, text, staff]);
      let nextStatus = ticket.status;
      if (!staff && ticket.status === 'RESOLVED') nextStatus = 'OPEN';
      if (staff && ticket.status === 'OPEN') nextStatus = 'IN_REVIEW';
      if (nextStatus !== ticket.status) {
        await client.query('UPDATE support_tickets SET status=$2,updated_at=now() WHERE id=$1', [ticketId, nextStatus]);
        await client.query('INSERT INTO support_ticket_events(ticket_id,actor_id,from_status,to_status) VALUES($1,$2,$3,$4)', [ticketId, user.sub, ticket.status, nextStatus]);
        // a status that moved because somebody answered is still a status change, and the
        // audit screen must not show a thread flipping states with no entry behind it
        await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'SUPPORT_TICKET_STATUS','SUPPORT_TICKET',$2,$3::jsonb)`, [user.sub, ticketId, JSON.stringify({ from: ticket.status, to: nextStatus, staff, via: 'reply' })]);
      } else {
        await client.query('UPDATE support_tickets SET updated_at=now() WHERE id=$1', [ticketId]);
      }
      const others = new Set<string>();
      if (user.sub !== ticket.opened_by) others.add(ticket.opened_by);
      if (ticket.opened_by === user.sub) for (const id of await this.staffIds(client)) if (id !== user.sub) others.add(id);
      for (const id of others) {
        await notify(client, id, 'SUPPORT_TICKET_MESSAGE', staff ? 'پاسخ پشتیبانی' : 'پاسخ جدید در گزارش', text.slice(0, 140), { ticketId });
      }
      await client.query('COMMIT');
      return { id: ticketId, status: nextStatus, replied: true };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async setStatus(user: Principal, ticketIdInput: unknown, body: { status?: unknown; note?: unknown }) {
    const target = typeof body?.status === 'string' ? body.status : '';
    if (!STATUSES.includes(target)) throw new BadRequestException('وضعیت معتبر نیست.');
    const note = message(body?.note, 500, 'توضیح');
    const ticketId = requireId(ticketIdInput, 'گزارش');
    const ticket = await this.readable(user, ticketId);
    const staff = isStaff(user);
    if (!staff && !(target === 'CLOSED' && ticket.opened_by === user.sub)) {
      throw new BadRequestException('فقط کادر پشتیبانی می‌تواند وضعیت گزارش را تغییر دهد؛ برای بستن، دکمهٔ بستن را بزنید.');
    }
    if (target !== ticket.status && !staff && !TRANSITIONS[ticket.status]?.includes(target)) {
      throw new ConflictException(`گذار از ${ticket.status} به ${target} مجاز نیست.`);
    }
    if (staff && target !== ticket.status && !TRANSITIONS[ticket.status]?.includes(target)) {
      throw new ConflictException(`گذار از ${ticket.status} به ${target} مجاز نیست.`);
    }
    if (target === 'RESOLVED' && staff && !note) throw new BadRequestException('برای حل‌شده علامت زدن، یک توضیح کوتاه لازم است.');
    if (target === ticket.status) return { id: ticketId, status: target, unchanged: true };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE support_tickets SET status=$2,updated_at=now() WHERE id=$1 AND status=$3', [ticketId, target, ticket.status]);
      await client.query('INSERT INTO support_ticket_events(ticket_id,actor_id,from_status,to_status,note) VALUES($1,$2,$3,$4,NULLIF($5,\'\'))', [ticketId, user.sub, ticket.status, target, note]);
      await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'SUPPORT_TICKET_STATUS','SUPPORT_TICKET',$2,$3::jsonb)`, [user.sub, ticketId, JSON.stringify({ from: ticket.status, to: target, staff })]);
      if (target === 'RESOLVED' && ticket.opened_by !== user.sub) {
        await notify(client, ticket.opened_by, 'SUPPORT_TICKET_RESOLVED', 'گزارش شما رسیدگی شد', note || 'پشتیبانی این گزارش را حل‌شده علامت زد.', { ticketId });
      }
      await client.query('COMMIT');
      return { id: ticketId, status: target };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Staff queue: oldest open work first, with the order context the reply needs. */
  async queue(filters: { status?: unknown; search?: unknown; limit?: unknown; offset?: unknown }) {
    const status = filters.status && filters.status !== '' ? String(filters.status) : 'OPEN';
    if (!STATUSES.includes(status)) throw new BadRequestException('وضعیت گزارش معتبر نیست.');
    const search = typeof filters.search === 'string' ? filters.search.trim().slice(0, 120) : '';
    const limit = SupportService.page(filters.limit, filters.offset);
    const where = ['t.status=$1'];
    const values: unknown[] = [status];
    if (search) { values.push(`%${search}%`); where.push(`(u.phone ILIKE $${values.length} OR u.display_name ILIKE $${values.length} OR COALESCE(b.name,'') ILIKE $${values.length} OR LEFT(t.id::text,8) ILIKE $${values.length})`); }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const [rows, counts, matched] = await Promise.all([
      this.pool.query(
        `SELECT t.id,t.order_id,t.status,t.created_at,t.updated_at,u.display_name AS "authorName",
                COALESCE(b.name,'—') AS "businessName",
                RIGHT(REGEXP_REPLACE(u.phone, '[^0-9]', '', 'g'), 4) AS "authorTail",
                (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id=t.id)::int AS "messageCount",
                (SELECT m.body FROM support_messages m WHERE m.ticket_id=t.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS "lastMessage"
         FROM support_tickets t JOIN users u ON u.id=t.opened_by
         LEFT JOIN orders o ON o.id=t.order_id LEFT JOIN businesses b ON b.id=o.business_id
         ${whereSql}
         ORDER BY t.updated_at ASC,t.id ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit.limit, limit.offset],
      ),
      this.pool.query(`SELECT status,COUNT(*)::int AS count FROM support_tickets GROUP BY status`),
      this.pool.query(`SELECT COUNT(*)::int AS "totalMatches" FROM support_tickets t JOIN users u ON u.id=t.opened_by LEFT JOIN orders o ON o.id=t.order_id LEFT JOIN businesses b ON b.id=o.business_id ${whereSql}`, values),
    ]);
    return {
      items: (rows.rows as Array<Record<string, unknown>>).map(row => ({
        id: row.id, orderId: row.order_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
        authorName: row.authorName, authorTail: row.authorTail, businessName: row.businessName, messageCount: row.messageCount, lastMessage: row.lastMessage ? String(row.lastMessage).slice(0, 160) : null,
      })),
      counts: Object.fromEntries((counts.rows as Array<{ status: string; count: number }>).map(row => [row.status, row.count])) as Record<string, number>,
      totalMatches: (matched.rows[0] as { totalMatches: number }).totalMatches,
      ...limit,
    };
  }

  private static page(limitInput: unknown, offsetInput: unknown): { limit: number; offset: number } {
    const rawLimit = limitInput === undefined || limitInput === '' ? 25 : Number(limitInput);
    const rawOffset = offsetInput === undefined || offsetInput === '' ? 0 : Number(offsetInput);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100 || !Number.isInteger(rawOffset) || rawOffset < 0) throw new BadRequestException('صفحه‌بندی معتبر نیست.');
    return { limit: rawLimit, offset: rawOffset };
  }
}

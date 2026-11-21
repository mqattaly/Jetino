import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { notify } from '../notifications/notifications.util';
import { message, requireId } from '../support/feedback.service';
import { STAFF_ROLES, cancelOrder, staffIds, writeAudit } from './cancellation-writes';
import { CANCELLABLE, Policy, decide, parsePolicy, parsePolicyUpdate, readPolicy, rejectionMessage } from './cancellation-policy';

/**
 * §7.11 — a cancellation is a *request*, not a button that rewrites an order.
 *
 * Policy decides whether the customer may cancel alone; anything else becomes a row in a queue
 * a human answers, and every answer (including "no") keeps the reason, the actor and the time.
 * Money that was already collected in cash never gets un-written either: a refund is a new ledger
 * row, and a mistake is answered by a correction row, so the history stays readable forever.
 */
const MAX_REASON = 300;
const MAX_NOTE = 300;
const REFUND_MAX = 1_000_000_000_000;
const OUTCOMES = ['PENDING', 'ACCEPTED', 'REJECTED', 'VOIDED'];
const REFUND_PARTIES = ['PLATFORM', 'BUSINESS', 'DRIVER'];
const AUTO_NOTE = 'تأیید خودکار بر اساس سیاست لغو';

type Principal = { sub: string; roles?: string[] };
type Row = Record<string, unknown>;
type Queryable = { query(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }> };

const isStaff = (user: Principal) => STAFF_ROLES.some(role => user.roles?.includes(role));

function reason(value: unknown, label = 'دلیل'): string {
  const text = message(value, MAX_REASON, label);
  if (text.length < 5) throw new BadRequestException(`${label} را کامل‌تر بنویسید (حداقل ۵ نویسه).`);
  return text;
}

function note(value: unknown): string {
  return message(value, MAX_NOTE, 'یادداشت');
}

/**
 * Money is only ever accepted as digits, optionally grouped (۱٬۰۰۰ / 1,000 / "1 000").
 * Anything else — '1e999', '12.5', an empty box — is refused instead of being quietly
 * re-read as a different number, because a refund row cannot be edited afterwards.
 */
function amountOf(value: unknown): number {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^-?\d{1,15}([,، ]\d{3})*$/.test(text)) throw new BadRequestException('مبلغ بازپرداخت باید عدد صحیح غیرصفر (ریال) و در محدودهٔ مجاز باشد.');
  const raw = Number(text.replace(/[,، ]/g, ''));
  if (!Number.isSafeInteger(raw) || raw === 0 || Math.abs(raw) > REFUND_MAX) {
    throw new BadRequestException('مبلغ بازپرداخت باید عدد صحیح غیرصفر (ریال) و در محدودهٔ مجاز باشد.');
  }
  return raw;
}

const ORDER_ACCESS = `
  o.customer_id=$2
  OR EXISTS (SELECT 1 FROM businesses b WHERE b.id=o.business_id AND b.owner_id=$2)
  OR EXISTS (SELECT 1 FROM delivery_assignments da JOIN drivers d ON d.id=da.driver_id WHERE da.order_id=o.id AND d.user_id=$2)
  OR $3::boolean`;

@Injectable()
export class CancellationsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  policy(queryable: Queryable = this.pool): Promise<Policy> {
    return readPolicy(queryable);
  }

  async setPolicy(actor: Principal, body: { autoCancelStatuses?: unknown; windowMinutes?: unknown }): Promise<Policy> {
    let update: { autoCancelStatuses?: string[]; windowMinutes?: number };
    try {
      update = parsePolicyUpdate(body ?? {});
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const current = await this.policy();
    const next: Policy = { autoCancelStatuses: update.autoCancelStatuses ?? current.autoCancelStatuses, windowMinutes: update.windowMinutes ?? current.windowMinutes };
    const result = await this.pool.query(
      `UPDATE cancellation_policies SET auto_statuses=$1,window_minutes=$2,updated_by=$3,updated_at=now() WHERE id=1
       RETURNING auto_statuses,window_minutes`, [next.autoCancelStatuses.join(','), next.windowMinutes, actor.sub],
    );
    if (!result.rowCount) throw new NotFoundException('سیاست لغو ثبت نشده است؛ migrationها را اجرا کنید.');
    await writeAudit(this.pool, actor.sub, 'CANCEL_POLICY_UPDATED', 'cancellation_policy', {
      autoCancelStatuses: next.autoCancelStatuses, windowMinutes: next.windowMinutes, before: current,
    }, 'CANCELLATION_POLICY');
    return parsePolicy(result.rows[0] as { auto_statuses?: string; window_minutes?: number });
  }

  /**
   * What the order's own people can see about §7.11: the rules, whether the customer may still act
   * alone, and every request filed so far. The reason text is for the requester, the shop and staff —
   * never for the courier, who has no part in the decision.
   */
  async forOrder(user: Principal, orderIdInput: unknown) {
    const orderId = requireId(orderIdInput, 'سفارش');
    const staff = isStaff(user);
    const [policy, order, requests] = await Promise.all([
      this.policy(),
      this.pool.query(`SELECT o.id,o.status,o.created_at AS "createdAt",o.payment_status AS "paymentStatus",o.total_rial AS "totalRial" FROM orders o WHERE o.id=$1 AND (${ORDER_ACCESS})`, [orderId, user.sub, staff]),
      this.pool.query(
        `SELECT c.id,c.reason,c.outcome,c.note,c.created_at AS "createdAt",c.decided_at AS "decidedAt",
                CASE WHEN c.decided_by IS NULL THEN NULL WHEN c.note=$4 THEN 'سیاست لغو' ELSE u.display_name END AS "decidedBy"
         FROM cancellation_requests c JOIN orders o2 ON o2.id=c.order_id JOIN businesses b2 ON b2.id=o2.business_id
              LEFT JOIN users u ON u.id=c.decided_by
         WHERE c.order_id=$1 AND (c.requested_by=$2 OR $3::boolean OR b2.owner_id=$2) ORDER BY c.created_at DESC,c.id DESC`, [orderId, user.sub, staff, AUTO_NOTE],
      ),
    ]);
    if (!order.rowCount) throw new NotFoundException('سفارش پیدا نشد یا به این حساب مربوط نیست.');
    const row = order.rows[0] as Row;
    const status = String(row.status);
    const openRequest = requests.rows.some(item => String((item as Row).outcome) === 'PENDING');
    return {
      order: { id: String(row.id), status, paymentStatus: String(row.paymentStatus), totalRial: String(row.totalRial) },
      policy,
      requests: requests.rows,
      // three different answers, because the screens ask three different questions
      selfServe: decide(policy, { status, createdAt: row.createdAt as Date | string }).allowed && !openRequest,
      cancellable: CANCELLABLE.includes(status),
      awaitingAnswer: openRequest,
    };
  }

  async queue(filters: { outcome?: unknown; search?: unknown; limit?: unknown; offset?: unknown }) {
    const outcome = filters.outcome === undefined || filters.outcome === '' ? 'PENDING' : String(filters.outcome);
    if (!OUTCOMES.includes(outcome)) throw new BadRequestException('وضعیت درخواست معتبر نیست.');
    const where = ['c.outcome=$1'];
    const values: unknown[] = [outcome];
    const term = filters.search === undefined || filters.search === '' ? '' : String(filters.search).trim();
    if (term) { values.push(`%${term}%`); where.push(`(u.display_name ILIKE $${values.length} OR u.phone ILIKE $${values.length} OR LEFT(c.order_id::text,8) ILIKE $${values.length})`); }
    const limit = CancellationsService.page(filters.limit, filters.offset);
    const order = outcome === 'PENDING' ? 'ASC' : 'DESC';
    const clause = `WHERE ${where.join(' AND ')}`;
    const [rows, counts, matched] = await Promise.all([
      this.pool.query(
        `SELECT c.id,c.order_id AS "orderId",c.reason,c.outcome,c.note,c.created_at AS "createdAt",c.decided_at AS "decidedAt",
                o.status AS "orderStatus",o.total_rial AS "totalRial",o.payment_status AS "paymentStatus",
                u.display_name AS "requesterName",RIGHT(REGEXP_REPLACE(u.phone, '[^0-9]', '', 'g'), 4) AS "requesterTail",
                (SELECT COUNT(*)::int FROM order_refunds r WHERE r.order_id=c.order_id) AS "refundCount"
         FROM cancellation_requests c JOIN orders o ON o.id=c.order_id JOIN users u ON u.id=c.requested_by
         ${clause}
         ORDER BY c.created_at ${order},c.id ${order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit.limit, limit.offset],
      ),
      this.pool.query(`SELECT outcome,COUNT(*)::int AS count FROM cancellation_requests GROUP BY outcome`),
      this.pool.query(`SELECT COUNT(*)::int AS "totalMatches" FROM cancellation_requests c JOIN users u ON u.id=c.requested_by ${clause}`, values),
    ]);
    return {
      items: rows.rows,
      counts: Object.fromEntries((counts.rows as Array<{ outcome: string; count: number }>).map(row => [row.outcome, row.count])) as Record<string, number>,
      totalMatches: Number((matched.rows[0] as Row).totalMatches),
      ...limit,
    };
  }

  /** The human half of §7.11: an answer, with a reason, that anybody can later read. */
  async decideRequest(actor: Principal, requestIdInput: unknown, body: { decision?: unknown; note?: unknown }) {
    const requestId = requireId(requestIdInput, 'درخواست لغو');
    const decision = String(body?.decision ?? '');
    if (decision !== 'ACCEPT' && decision !== 'REJECT') throw new BadRequestException('پاسخ باید ACCEPT یا REJECT باشد.');
    const text = note(body?.note);
    if (decision === 'REJECT' && !text) throw new BadRequestException('برای رد کردن درخواست، دلیل لازم است.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT c.id,c.outcome,c.order_id AS "orderId",c.reason,c.requested_by AS "requestedBy",o.status AS "orderStatus",b.owner_id AS "ownerId"
         FROM cancellation_requests c JOIN orders o ON o.id=c.order_id JOIN businesses b ON b.id=o.business_id WHERE c.id=$1 FOR UPDATE OF c, o`, [requestId],
      );
      if (!found.rowCount) throw new NotFoundException('درخواست لغو پیدا نشد.');
      const request = found.rows[0] as Row as { id: string; outcome: string; orderId: string; reason: string; requestedBy: string; orderStatus: string; ownerId: string };
      // the shop answers for its own orders, operations answers for everything
      if (!isStaff(actor) && request.ownerId !== actor.sub) throw new ForbiddenException('پاسخ به این درخواست با کادر عملیات است.');
      if (request.outcome !== 'PENDING') throw new ConflictException('این درخواست پیش‌تر تعیین تکلیف شده است.');
      const outcome = decision === 'ACCEPT' ? (CANCELLABLE.includes(request.orderStatus) ? 'ACCEPTED' : 'VOIDED') : 'REJECTED';
      const actorLabel = isStaff(actor) ? 'کادر عملیات' : 'کسب‌وکار';
      const explained = text || (outcome === 'ACCEPTED'
        ? `${actorLabel} لغو را تأیید کرد.`
        : `سفارش در وضعیت «${request.orderStatus}» دیگر لغوپذیر نیست؛ نتیجه از این مسیر گرفته می‌شود.`);

      if (outcome === 'ACCEPTED') {
        await cancelOrder(client, {
          orderId: request.orderId, from: request.orderStatus, actorId: actor.sub, reason: `لغو با تأیید ${actorLabel}: ${request.reason}`.slice(0, MAX_REASON),
          owner: request.ownerId === actor.sub ? null : { userId: request.ownerId, body: `${actorLabel} درخواست لغوی را که باز ماند بود تأیید کرد.` },
        });
      }
      await client.query(`UPDATE cancellation_requests SET outcome=$2,decided_by=$3,decided_at=now(),note=$4 WHERE id=$1`, [
        requestId, outcome, actor.sub, explained.slice(0, MAX_NOTE),
      ]);
      await writeAudit(client, actor.sub, 'ORDER_CANCELLATION_DECIDED', request.orderId, { requestId, outcome, note: explained, orderStatus: request.orderStatus });
      const title = outcome === 'ACCEPTED' ? 'درخواست لغو شما تأیید شد' : outcome === 'VOIDED' ? 'درخواست لغو بدون اقدام ماند' : 'درخواست لغو شما رد شد';
      await notify(client, request.requestedBy, 'ORDER_CANCELLATION_DECIDED', title,
        outcome === 'ACCEPTED' ? 'سفارش لغو شد؛ وجهی از شما دریافت نشده بود.' : explained,
        { orderId: request.orderId, requestId, outcome, note: explained });
      await client.query('COMMIT');
      return { requestId, orderId: request.orderId, outcome, status: outcome === 'ACCEPTED' ? 'CANCELLED' : request.orderStatus };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The refund ledger. `collectedRial` is what was actually taken from the customer, `refundedRial`
   * is the net of every row (corrections included) and `refundableRial` is the only room left to write.
   */
  async refunds(user: Principal, orderIdInput: unknown) {
    const orderId = requireId(orderIdInput, 'سفارش');
    const result = await this.pool.query(
      `SELECT o.id,o.status,o.payment_status AS "paymentStatus",o.total_rial AS "totalRial",
              COALESCE((SELECT cc.amount_rial FROM cash_collections cc WHERE cc.order_id=o.id),0)::bigint AS "collectedRial",
              COALESCE((SELECT SUM(r.amount_rial) FROM order_refunds r WHERE r.order_id=o.id),0)::bigint AS "refundedRial"
       FROM orders o WHERE o.id=$1 AND (${ORDER_ACCESS})`, [orderId, user.sub, isStaff(user)],
    );
    if (!result.rowCount) throw new NotFoundException('سفارش پیدا نشد یا به این حساب مربوط نیست.');
    const totals = result.rows[0] as { collectedRial: string; refundedRial: string };
    const rows = await this.pool.query(
      `SELECT r.id,r.amount_rial AS "amountRial",r.kind,r.destination,r.funded_by AS "fundedBy",r.reason,r.created_at AS "createdAt",u.display_name AS "actorName"
       FROM order_refunds r JOIN users u ON u.id=r.created_by WHERE r.order_id=$1 ORDER BY r.created_at DESC,r.id DESC`, [orderId],
    );
    const collected = BigInt(totals.collectedRial);
    const refunded = BigInt(totals.refundedRial);
    return {
      orderId,
      collectedRial: collected.toString(),
      refundedRial: refunded.toString(),
      refundableRial: (collected - refunded > 0n ? collected - refunded : 0n).toString(),
      items: rows.rows,
    };
  }

  async recordRefund(actor: Principal, orderIdInput: unknown, body: { amountRial?: unknown; reason?: unknown; fundedBy?: unknown; requestKey?: unknown }) {
    // money leaving the platform is the one write here that never trusts the route's guard alone
    if (!isStaff(actor)) throw new ForbiddenException('ثبت بازپرداخت فقط با کادر عملیات است.');
    const orderId = requireId(orderIdInput, 'سفارش');
    const amount = amountOf(body?.amountRial);
    const text = reason(body?.reason, 'دلیل بازپرداخت');
    const fundedBy = body?.fundedBy === undefined || body.fundedBy === '' ? 'PLATFORM' : String(body.fundedBy);
    if (!REFUND_PARTIES.includes(fundedBy)) throw new BadRequestException('طرف پرداخت‌کننده بازپرداخت معتبر نیست.');
    if (amount > 0 && amount > REFUND_MAX) throw new BadRequestException('مبلغ بازپرداخت خارج از محدودهٔ مجاز است.');
    const requestKey = requireId(body.requestKey, 'شناسهٔ درخواست بازپرداخت');
    const kind = amount > 0 ? 'REFUND' : 'CORRECTION';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Lock in a separate statement: a waiting SELECT with subqueries can otherwise
      // see a snapshot from before the previous refund committed.
      const locked = await client.query(`SELECT id FROM orders WHERE id=$1 FOR UPDATE`, [orderId]);
      if (!locked.rowCount) throw new NotFoundException('سفارش پیدا نشد.');
      const prior = await client.query(`SELECT amount_rial,reason,funded_by FROM order_refunds WHERE order_id=$1 AND request_key=$2`, [orderId, requestKey]);
      const found = await client.query(
        `SELECT o.id,o.status,o.customer_id,o.payment_status AS "paymentStatus",
                COALESCE((SELECT cc.amount_rial FROM cash_collections cc WHERE cc.order_id=o.id),0)::bigint AS "collectedRial",
                COALESCE((SELECT SUM(r.amount_rial) FROM order_refunds r WHERE r.order_id=o.id),0)::bigint AS "refundedRial",
                COALESCE((SELECT SUM(r.amount_rial) FROM order_refunds r WHERE r.order_id=o.id AND r.destination='WALLET'),0)::bigint AS "walletRefundedRial"
         FROM orders o WHERE o.id=$1`, [orderId],
      );
      if (!found.rowCount) throw new NotFoundException('سفارش پیدا نشد.');
      const order = found.rows[0] as { id: string; status: string; customer_id: string; paymentStatus: string; collectedRial: string; refundedRial: string; walletRefundedRial: string };
      const collected = BigInt(order.collectedRial);
      const refunded = BigInt(order.refundedRial);
      if (prior.rows.length) {
        const row = prior.rows[0] as { amount_rial: string; reason: string; funded_by: string };
        if (BigInt(row.amount_rial) !== BigInt(amount) || row.reason !== text || row.funded_by !== fundedBy) throw new ConflictException('این شناسه برای بازپرداخت دیگری استفاده شده است.');
        await client.query('COMMIT');
        return { orderId, amountRial: amount, kind, fundedBy, paymentStatus: order.paymentStatus, refundedRial: refunded.toString(), refundableRial: (collected - refunded > 0n ? collected - refunded : 0n).toString(), duplicate: true };
      }
      if (collected === 0n) throw new ConflictException('وجهی از مشتری دریافت نشده که بخواهد بازپرداخت شود.');
      if (kind === 'REFUND' && BigInt(amount) > collected - refunded) {
        throw new ConflictException(`سقف بازپرداخت این سفارش ${collected - refunded > 0n ? (collected - refunded).toString() : '0'} ریال است.`);
      }
      if (kind === 'CORRECTION' && -BigInt(amount) > refunded) throw new ConflictException('جمع سوابق بازپرداخت نمی‌تواند منفی شود.');
      if (kind === 'CORRECTION' && -BigInt(amount) > BigInt(order.walletRefundedRial)) throw new ConflictException('اصلاح بیش از بازپرداخت ثبت‌شده در کیف پول این سفارش است؛ بازپرداخت‌های قدیمی خارج از کیف پول باید جداگانه بررسی شوند.');
      await client.query(`INSERT INTO order_refunds(order_id,amount_rial,kind,funded_by,reason,created_by,destination,request_key) VALUES($1,$2,$3,$4,$5,$6,'WALLET',$7)`, [orderId, amount, kind, fundedBy, text, actor.sub, requestKey]);
      const next = refunded + BigInt(amount);
      // the payment status is derived from the ledger, so it cannot say REFUNDED while money is still owed
      const paymentStatus = next >= collected ? 'REFUNDED' : 'PAID';
      await client.query(`UPDATE orders SET payment_status=$2,updated_at=now() WHERE id=$1`, [orderId, paymentStatus]);
      await writeAudit(client, actor.sub, 'ORDER_REFUNDED', orderId, { amountRial: amount, kind, fundedBy, destination: 'WALLET', reason: text, refundedRial: next.toString(), collectedRial: collected.toString(), paymentStatus });
      await notify(client, order.customer_id, 'ORDER_REFUNDED', kind === 'REFUND' ? 'بازپرداخت ثبت شد' : 'اصلاح بازپرداخت ثبت شد',
        `${new Intl.NumberFormat('fa-IR').format(Math.abs(amount))} ریال · ${kind === 'REFUND' ? 'اعتبار کیف پول' : 'اصلاح اعتبار کیف پول'} · ${text}`.slice(0, 500), { orderId, amountRial: amount, kind });
      await client.query('COMMIT');
      return { orderId, amountRial: amount, kind, fundedBy, paymentStatus, refundedRial: next.toString(), refundableRial: (collected - next > 0n ? collected - next : 0n).toString() };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  static page(limitInput: unknown, offsetInput: unknown): { limit: number; offset: number } {
    const rawLimit = limitInput === undefined || limitInput === '' ? 15 : Number(limitInput);
    const rawOffset = offsetInput === undefined || offsetInput === '' ? 0 : Number(offsetInput);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) throw new BadRequestException('اندازهٔ صفحه باید عددی بین ۱ تا ۱۰۰ باشد.');
    if (!Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset > 5000) throw new BadRequestException('جابه‌جایی در فهرست مجاز نیست.');
    return { limit: rawLimit, offset: rawOffset };
  }
}

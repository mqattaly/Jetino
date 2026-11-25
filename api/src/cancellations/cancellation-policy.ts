/**
 * Cancellation policy (§7.11): the rules the customer's own cancel button follows.
 *
 * The point of keeping this in one pure module is that the answer to "may this order still be
 * cancelled by itself?" is decided the same way in the panel, in the queue and in the tests —
 * and an operator who widens the window never has to wonder whether the check was written twice.
 */
export type Policy = { autoCancelStatuses: string[]; windowMinutes: number };
export type Decision = { allowed: boolean; code: 'POLICY' | 'WINDOW' | 'STAFF_ONLY' | 'CANCELLED' | 'SETTLED' };

export const DEFAULT_POLICY: Policy = { autoCancelStatuses: ['PENDING_BUSINESS'], windowMinutes: 0 };
/** Statuses an operator may hand to customers at all — after a courier is committed, it is a human call. */
export const POLICY_OPTIONS = ['PENDING_BUSINESS', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP'];
/** Statuses that still mean "this order can become CANCELLED", for a staff decision. */
export const CANCELLABLE = ['PENDING_BUSINESS', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'DRIVER_ASSIGNED', 'OUT_FOR_DELIVERY'];
export const REQUEST_OUTCOMES = ['PENDING', 'ACCEPTED', 'REJECTED', 'VOIDED'];
export const REFUND_MAX = 1_000_000_000_000;

export function parsePolicy(row: { auto_statuses?: unknown; window_minutes?: unknown } | undefined): Policy {
  if (!row) return DEFAULT_POLICY;
  const statuses = String(row.auto_statuses ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(value => POLICY_OPTIONS.includes(value));
  const minutes = Number(row.window_minutes ?? 0);
  return {
    autoCancelStatuses: statuses.length ? statuses : DEFAULT_POLICY.autoCancelStatuses,
    windowMinutes: Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440 ? minutes : 0,
  };
}

/** Any handle that can run one SELECT — the pool, or a transaction inside the cancel flow. */
type PolicySource = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

/** The single policy row is created by the migration; a missing row means "defaults". */
export async function readPolicy(queryable: PolicySource): Promise<Policy> {
  const result = await queryable.query(`SELECT auto_statuses,window_minutes FROM cancellation_policies WHERE id=1`);
  return parsePolicy(result.rows[0] as { auto_statuses?: string; window_minutes?: number } | undefined);
}

/** Written by an operator, so an unknown status is refused rather than silently dropped. */
export function parsePolicyUpdate(body: { autoCancelStatuses?: unknown; windowMinutes?: unknown }): { autoCancelStatuses?: string[]; windowMinutes?: number } {
  const result: { autoCancelStatuses?: string[]; windowMinutes?: number } = {};
  if (body?.autoCancelStatuses !== undefined) {
    const raw = body.autoCancelStatuses;
    const list = Array.isArray(raw) ? raw.map(value => String(value).trim()) : String(raw ?? '').split(',').map(value => value.trim());
    const statuses = Array.from(new Set(list.filter(Boolean)));
    if (!statuses.length) throw new Error('حداقل یک وضعیت برای لغو خودکار انتخاب کنید.');
    const unknown = statuses.filter(status => !POLICY_OPTIONS.includes(status));
    if (unknown.length) throw new Error(`وضعیت «${unknown.join('، ')}» برای لغو خودکار مجاز نیست.`);
    if (statuses.join(',').length > 200) throw new Error('فهرست وضعیت‌ها بسیار بلند است.');
    result.autoCancelStatuses = statuses;
  }
  if (body?.windowMinutes !== undefined) {
    const minutes = Number(body.windowMinutes);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw new Error('بازهٔ مجاز لغو باید عددی بین ۰ تا ۱۴۴۰ دقیقه باشد.');
    result.windowMinutes = minutes;
  }
  if (result.autoCancelStatuses === undefined && result.windowMinutes === undefined) throw new Error('حداقل یک قاعده برای تغییر بفرستید.');
  return result;
}

export function decide(policy: Policy, order: { status: string; createdAt: Date | string }, now = new Date()): Decision {
  if (order.status === 'CANCELLED') return { allowed: false, code: 'CANCELLED' };
  if (order.status === 'DELIVERED' || order.status === 'REJECTED') return { allowed: false, code: 'SETTLED' };
  if (!CANCELLABLE.includes(order.status)) return { allowed: false, code: 'SETTLED' };
  if (!policy.autoCancelStatuses.includes(order.status)) return { allowed: false, code: 'STAFF_ONLY' };
  if (policy.windowMinutes > 0) {
    const created = order.createdAt instanceof Date ? order.createdAt : new Date(String(order.createdAt));
    const ageMinutes = (now.getTime() - created.getTime()) / 60_000;
    if (!(ageMinutes >= 0 && ageMinutes <= policy.windowMinutes)) return { allowed: false, code: 'WINDOW' };
  }
  return { allowed: true, code: 'POLICY' };
}

export function rejectionMessage(decision: Decision): string {
  if (decision.code === 'CANCELLED') return 'این سفارش پیش‌تر لغو شده است.';
  if (decision.code === 'SETTLED') return 'این سفارش به نتیجه رسیده و دیگر قابل لغو نیست؛ برای بازپرداخت، دلیل را در گفت‌وگوی پشتیبانی بنویسید.';
  if (decision.code === 'WINDOW') return 'بازهٔ مجاز لغو گذشته است؛ درخواست شما برای بررسی کادر عملیات ثبت شد.';
  return 'لغو این سفارش نیاز به تأیید کادر عملیات دارد؛ درخواست شما ثبت شد.';
}

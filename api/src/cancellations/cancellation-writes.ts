import { notify } from '../notifications/notifications.util';

/** Anything that can run a statement inside the caller's transaction (a PoolClient, in practice). */
export type Transactional = { query(sql: string, values?: unknown[]): Promise<unknown> };
export type Queryable = { query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> };

/** Operations roles that answer cancellation requests and see the refund ledger. */
export const STAFF_ROLES = ['SUPER_ADMIN', 'OPERATIONS_MANAGER'];
const STAFF_NOTIFY_LIMIT = 20;

export async function writeAudit(client: Transactional, actorId: string, action: string, entityId: string, metadata: Record<string, unknown>, entityType = 'ORDER') {
  await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5::jsonb)`, [actorId, action, entityType, entityId, JSON.stringify(metadata)]);
}

/** One placeholder per role instead of an array parameter, so the query stays portable. */
export async function staffIds(client: Queryable, exceptUserId?: string): Promise<string[]> {
  const placeholders = STAFF_ROLES.map((_, index) => `$${index + 1}`).join(',');
  const result = await client.query(`SELECT DISTINCT ur.user_id FROM user_roles ur WHERE ur.role IN (${placeholders})`, STAFF_ROLES);
  return (result.rows as Array<{ user_id: string }>)
    .map(row => row.user_id)
    .filter(id => id !== exceptUserId)
    .slice(0, STAFF_NOTIFY_LIMIT);
}

/**
 * The one place an order becomes CANCELLED. Both the customer's own button and a staff decision go
 * through here, so the status, the history line, the notification and the audit row can never drift
 * apart depending on who cancelled it — which is exactly what §7.11 asks to stay traceable.
 */
export async function cancelOrder(
  client: Transactional,
  input: { orderId: string; from: string; actorId: string; reason: string; owner: { userId: string; body: string } | null },
): Promise<void> {
  await client.query(`UPDATE orders SET status='CANCELLED',updated_at=now() WHERE id=$1`, [input.orderId]);
  await client.query(`INSERT INTO order_status_history(order_id,from_status,to_status,actor_id,reason) VALUES($1,$2,'CANCELLED',$3,$4)`, [
    input.orderId, input.from, input.actorId, input.reason,
  ]);
  if (input.owner && input.owner.userId !== input.actorId) {
    await notify(client, input.owner.userId, 'ORDER_CANCELLED', 'سفارش لغو شد', input.owner.body, { orderId: input.orderId });
  }
  await writeAudit(client, input.actorId, 'ORDER_CANCELLED', input.orderId, { from: input.from, reason: input.reason });
}

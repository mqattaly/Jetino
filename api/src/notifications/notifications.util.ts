import type { PoolClient } from 'pg';

/** Anything that can run a statement in the caller's transaction — a PoolClient, or a narrower wrapper. */
export type Notifier = { query(sql: string, values?: unknown[]): Promise<unknown> };

export interface NotifyOptions {
  /**
   * Opt-in duplicate control (§7.12): the same event for the same recipient is stored once per key
   * (an order id, a ticket id). Callers that must always notify — a status change, a refund — leave
   * it out, so the unique partial index on notifications(user_id,event_type,dedupe_key) never eats them.
   */
  dedupeKey?: string | null;
}

export interface NotifyResult {
  id: string | null;
  /** True when an identical notification already existed and nothing was inserted. */
  deduped: boolean;
}

export async function notify(
  client: PoolClient | Notifier,
  userId: string,
  eventType: string,
  title: string,
  body: string,
  data: Record<string, unknown> = {},
  options: NotifyOptions = {},
): Promise<NotifyResult> {
  const dedupeKey = typeof options.dedupeKey === 'string' && options.dedupeKey.trim() ? options.dedupeKey.trim().slice(0, 160) : null;
  const notifier = client as Notifier;
  if (!dedupeKey) {
    const inserted = await notifier.query(`INSERT INTO notifications(user_id,event_type,title,body,data) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id`, [
      userId,
      eventType,
      title,
      body,
      JSON.stringify(data),
    ]);
    return { id: (rowsOf(inserted)[0] as { id?: string } | undefined)?.id ?? null, deduped: false };
  }
  const inserted = await notifier.query(
    `INSERT INTO notifications(user_id,event_type,title,body,data,dedupe_key) VALUES($1,$2,$3,$4,$5::jsonb,$6)
     ON CONFLICT (user_id,event_type,dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
    [userId, eventType, title, body, JSON.stringify(data), dedupeKey],
  );
  const id = (rowsOf(inserted)[0] as { id?: string } | undefined)?.id ?? null;
  return { id, deduped: id === null };
}

function rowsOf(result: unknown): unknown[] {
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? rows : [];
}

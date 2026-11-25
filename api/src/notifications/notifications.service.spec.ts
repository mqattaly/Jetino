import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { notify } from './notifications.util';

function serviceWith(query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>) {
  const deliveries = { pushStates: async () => new Map() } as never;
  return new NotificationsService({ query } as never, deliveries);
}

describe('NotificationsService', () => {
  it('returns only the authenticated user’s notifications and unread count', async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const service = serviceWith(async (sql, values) => {
      calls.push({ sql, values });
      return sql.startsWith('SELECT id')
        ? { rows: [{ id: 'notice-1' }], rowCount: 1 }
        : { rows: [{ count: 3 }], rowCount: 1 };
    });

    const result = await service.list({ sub: 'user-123' });
    assert.deepEqual(result, { items: [{ id: 'notice-1', pushState: 'NONE', pushError: null }], unreadCount: 3 });
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.match(call.sql, /user_id=\$1/);
      assert.deepEqual(call.values, ['user-123']);
    }
  });

  it('rejects malformed notification IDs before querying', async () => {
    let queried = false;
    const service = serviceWith(async () => {
      queried = true;
      return { rows: [], rowCount: 0 };
    });

    await assert.rejects(service.markRead({ sub: 'user-123' }, 'not-a-uuid'), BadRequestException);
    assert.equal(queried, false);
  });

  it('does not reveal another user’s notification when marking it read', async () => {
    let executed: { sql: string; values?: unknown[] } | undefined;
    const service = serviceWith(async (sql, values) => {
      executed = { sql, values };
      return { rows: [], rowCount: 0 };
    });

    await assert.rejects(
      service.markRead({ sub: 'user-123' }, '123e4567-e89b-12d3-a456-426614174000'),
      NotFoundException,
    );
    assert.match(executed!.sql, /WHERE id=\$1 AND user_id=\$2/);
    assert.deepEqual(executed!.values, ['123e4567-e89b-12d3-a456-426614174000', 'user-123']);
  });

  it('inserts notification payloads as JSON through the caller transaction', async () => {
    let executed: { sql: string; values?: unknown[] } | undefined;
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        executed = { sql, values };
        return { rows: [], rowCount: 1 };
      },
    };

    const result = await notify(client as never, 'user-123', 'ORDER_NEW', 'سفارش تازه', 'برای بررسی ثبت شد.', { orderId: 'order-456' });
    assert.deepEqual(result, { id: null, deduped: false });
    assert.match(executed!.sql, /INSERT INTO notifications\(user_id,event_type,title,body,data\)/);
    assert.deepEqual(executed!.values, ['user-123', 'ORDER_NEW', 'سفارش تازه', 'برای بررسی ثبت شد.', JSON.stringify({ orderId: 'order-456' })]);
  });

  it('stores a duplicate event once when the caller names a dedupe key', async () => {
    const seen: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        seen.push({ sql, values });
        return { rows: [], rowCount: 0 };
      },
    };

    const result = await notify(client as never, 'user-123', 'ORDER_NEW', 'سفارش تازه', 'برای بررسی ثبت شد.', { orderId: 'order-456' }, { dedupeKey: 'order-456' });
    assert.deepEqual(result, { id: null, deduped: true });
    assert.match(seen[0].sql, /dedupe_key/);
    assert.match(seen[0].sql, /ON CONFLICT \(user_id,event_type,dedupe_key\) WHERE dedupe_key IS NOT NULL DO NOTHING/);
    assert.deepEqual(seen[0].values, ['user-123', 'ORDER_NEW', 'سفارش تازه', 'برای بررسی ثبت شد.', JSON.stringify({ orderId: 'order-456' }), 'order-456']);
  });

  it('leaves events without a dedupe key on the plain insert path', async () => {
    let sql = '';
    const client = { query: async (statement: string) => { sql = statement; return { rows: [{ id: '7' }], rowCount: 1 }; } };
    assert.deepEqual(await notify(client as never, 'u', 'ORDER_DELIVERED', 't', 'b'), { id: '7', deduped: false });
    assert.doesNotMatch(sql, /dedupe_key|ON CONFLICT/);
  });

  it('marks only unread notifications for the current user as read', async () => {
    let executed: { sql: string; values?: unknown[] } | undefined;
    const service = serviceWith(async (sql, values) => {
      executed = { sql, values };
      return { rows: [], rowCount: 2 };
    });

    assert.deepEqual(await service.readAll({ sub: 'user-123' }), { updated: 2 });
    assert.match(executed!.sql, /WHERE user_id=\$1 AND read_at IS NULL/);
    assert.deepEqual(executed!.values, ['user-123']);
  });
});

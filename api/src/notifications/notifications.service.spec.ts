import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

function serviceWith(query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>) {
  return new NotificationsService({ query } as never);
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
    assert.deepEqual(result, { items: [{ id: 'notice-1' }], unreadCount: 3 });
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

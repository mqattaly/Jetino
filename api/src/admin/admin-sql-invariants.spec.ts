import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdminOrdersService } from './admin-orders.service';
import { AdminReportsService } from './admin-reports.service';

/**
 * These services build SQL by concatenating optional filter branches, so the
 * parameter numbering can drift from the values array. Every statement that
 * takes parameters must reference $1..$n exactly once and must never inline a
 * user-supplied string.
 */
type Captured = { sql: string; values?: unknown[] };
const PLACEHOLDER = /\$(\d+)/g;

function assertParameterisation(captured: Captured[]) {
  for (const entry of captured) {
    const used = [...new Set([...entry.sql.matchAll(PLACEHOLDER)].map(match => Number(match[1])))].sort((a, b) => a - b);
    const provided = entry.values?.length ?? 0;
    assert.deepEqual(
      used,
      Array.from({ length: provided }, (_, index) => index + 1),
      `statement references ${JSON.stringify(used)} but ${provided} values were provided: ${entry.sql.slice(0, 120)}`,
    );
  }
}

function recorder(rows: (sql: string) => { rows: unknown[]; rowCount: number }) {
  const captured: Captured[] = [];
  const query = async (sql: string, values?: unknown[]) => { captured.push({ sql, values }); return rows(sql); };
  return { captured, pool: { query, connect: async () => ({ query, release() {} }) } };
}

describe('admin report SQL parameterisation', () => {
  it('keeps order monitor filters aligned with their values in every branch', async () => {
    const { captured, pool } = recorder(sql => sql.startsWith('SELECT COUNT') ? { rows: [{ totalMatches: '3' }], rowCount: 1 } : { rows: [{ id: 'order-1' }], rowCount: 1 });
    const service = new AdminOrdersService(pool as never);
    await service.list();
    await service.list('DELIVERED');
    await service.list('DELIVERED','0912');
    await service.list(undefined,'123E4567',undefined,'25');
    await service.list('CANCELLED','کسب‌وکار','50','100');
    assert.equal(captured.length, 10);
    assertParameterisation(captured);
  });

  it('never splices the search term into the order monitor SQL text', async () => {
    const { captured, pool } = recorder(sql => sql.startsWith('SELECT COUNT') ? { rows: [{ totalMatches: '0' }], rowCount: 1 } : { rows: [], rowCount: 0 });
    const needle = "d'rop-table";
    await new AdminOrdersService(pool as never).list(undefined, needle, undefined, undefined);
    for (const entry of captured) {
      assert.ok(!entry.sql.includes(needle), 'user input must only travel as a bound value');
      assert.ok(entry.values?.includes(needle), 'the search term must be bound, not dropped');
    }
  });

  it('keeps aggregate report queries parameterised and free of raw input', async () => {
    const { captured, pool } = recorder(() => ({ rows: [{ totalOrders: '0', ordersInPeriod: '0', awaitingBusiness: '0', inDelivery: '0', deliveredOrders: '0', grossOrderValueRial: '0', cashCollectedRial: '0', unsettledCashRial: '0', unsettledCollections: '0', id: 'b-1', name: 'x', regionName: 'y', status: 'ACTIVE', orderCount: 0, ordersInPeriod2: 0, revenueRial: '0', commissionRial: '0', awaitingResponse: 0, avgPrepMinutes: null, unpaidDeliveredRial: '0', driverId: 'd-1', driverPhone: '0', openCount: 0, openCashRial: '0', lastCollectedAt: new Date().toISOString() }], rowCount: 1 }));
    const service = new AdminReportsService(pool as never);
    await service.summary('24h');
    await service.businessPerformance('30d');
    await service.cashOutstanding();
    assert.equal(captured.length, 3);
    assertParameterisation(captured);
    assert.deepEqual(captured[0].values, ['24 hours']);
    assert.deepEqual(captured[1].values, ['30 days'], 'one interval value may be referenced by several $1 filters');
    assert.equal(captured[2].values, undefined, 'the cash outstanding query has no filters');
  });
});

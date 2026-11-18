import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SupportService } from './support.service';

const opener = { sub: 'a0000000-0000-4000-8000-0000000000c1', roles: ['CUSTOMER'] };
const staff = { sub: 'a0000000-0000-4000-8000-0000000000a1', roles: ['OPERATIONS_MANAGER'] };
const ticketId = 'c0000000-0000-4000-8000-000000000001';
const orderId = 'b0000000-0000-4000-8000-000000000001';

const longText = 'پلاک سفارش اشتباه بود و غذای سرد رسید، لطفاً بررسی کنید.';

type Answer = { rows: unknown[]; rowCount: number };

function harness(options: {
  ticket?: Record<string, unknown> | null;
  order?: Record<string, unknown> | null;
  openExisting?: boolean;
  answer?: (sql: string) => Answer | null;
} = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const staffLookups: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values?: unknown[]): Promise<Answer> => {
    calls.push({ sql, values });
    const custom = options.answer?.(sql);
    if (custom) return custom;
    if (sql.includes('FROM support_tickets t WHERE t.id=$1')) {
      return options.ticket === null ? { rows: [], rowCount: 0 } : { rows: [options.ticket ?? { id: ticketId, order_id: orderId, opened_by: opener.sub, status: 'OPEN', created_at: new Date(), updated_at: new Date() }], rowCount: 1 };
    }
    if (sql.includes('FROM orders o JOIN businesses b')) {
      return options.order === null ? { rows: [], rowCount: 0 } : { rows: [options.order ?? { id: orderId, customer_id: opener.sub, owner_id: 'a0000000-0000-4000-8000-0000000000b1', driver_user_id: null }], rowCount: 1 };
    }
    if (sql.includes('FROM support_tickets WHERE order_id')) return { rows: options.openExisting ? [{ id: ticketId }] : [], rowCount: options.openExisting ? 1 : 0 };
    if (sql.includes('FROM user_roles')) {
      staffLookups.push({ sql, values: values ?? [] });
      return { rows: [{ user_id: staff.sub }, { user_id: 'a0000000-0000-4000-8000-0000000000a2' }], rowCount: 2 };
    }
    if (sql.includes('RETURNING')) return { rows: [{ id: ticketId, status: 'OPEN', created_at: new Date() }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  const client = { query, release() {} };
  const pool = { query, connect: async () => client };
  const writes = () => calls.filter(call => /^(UPDATE|INSERT)/.test(call.sql.trim()));
  return {
    service: new SupportService(pool as never), calls, writes, staffLookups,
    statuses: () => calls.filter(call => call.sql.includes('UPDATE support_tickets SET status')),
  };
}

describe('SupportService.open', () => {
  it('needs a real complaint, not a couple of keystrokes', async () => {
    const { service, calls } = harness();
    await assert.rejects(service.open(opener, { message: '   ' }), BadRequestException);
    await assert.rejects(service.open(opener, { message: 'سلام' }), BadRequestException, 'a greeting is not a complaint');
    assert.match(longText, /.{5,}/, 'the fixture stays above the floor');
    await assert.rejects(service.open(opener, { message: 'ا'.repeat(2001) }), BadRequestException);
    await assert.rejects(service.open(opener, { orderId: 'not-a-uuid', message: longText }), BadRequestException);
    assert.equal(calls.length, 0, 'nothing may be written while the payload is invalid');
  });

  it('refuses a ticket about somebody else’s order', async () => {
    const { service, writes } = harness({ order: null });
    await assert.rejects(service.open(opener, { orderId, message: longText }), NotFoundException);
    assert.deepEqual(writes(), [], 'a rejected ticket must not be stored');
  });

  it('points a duplicate at the live thread instead of opening a second one', async () => {
    const { service, writes } = harness({ openExisting: true });
    await assert.rejects(service.open(opener, { orderId, message: longText }), ConflictException);
    assert.deepEqual(writes(), [], 'the conflict must be detected before any insert');
  });

  it('records the thread, its first message and its opening event together', async () => {
    const { service, calls } = harness();
    const result = await service.open(opener, { orderId, message: `  ${longText}  ` });
    assert.equal(result.id, ticketId);
    assert.equal(result.status, 'OPEN');
    assert.equal(calls[0].sql, 'BEGIN');
    assert.match(calls.at(-1)?.sql ?? '', /^COMMIT$/);
    const insert = calls.find(call => call.sql.includes('INSERT INTO support_tickets'))!;
    assert.deepEqual(insert.values, [orderId, opener.sub]);
    const message = calls.find(call => call.sql.includes('INSERT INTO support_messages'))!;
    assert.equal(message.values?.[2], longText, 'surrounding whitespace is trimmed');
    assert.equal(message.values?.[3], false);
    const event = calls.find(call => call.sql.includes('INSERT INTO support_ticket_events'))!;
    assert.match(event.sql, /VALUES\(\$1,\$2,NULL,'OPEN'\)/, 'the opening event is a constant, so it needs no parameters');
    assert.deepEqual(event.values, [ticketId, opener.sub]);
  });

  it('tells staff and the other side of the order, but never the reporter', async () => {
    const { service, calls } = harness();
    await service.open(opener, { orderId, message: longText });
    const notified = calls.filter(call => call.sql.includes('INSERT INTO notifications')).map(call => call.values?.[0]);
    assert.ok(notified.includes(staff.sub), 'the queue must wake the staff up');
    assert.ok(notified.includes('a0000000-0000-4000-8000-0000000000b1'), 'the shop in the dispute is told a ticket exists');
    assert.equal(notified.includes(opener.sub), false, 'nobody is notified about their own message');
    assert.equal(calls.filter(call => call.sql.includes('INSERT INTO notifications')).length, 3, 'each staff member once, not once per row');
  });

  it('binds one role per placeholder instead of betting on array serialisation', async () => {
    const { service, staffLookups } = harness();
    await service.open(opener, { message: longText });
    assert.equal(staffLookups.length, 1);
    assert.match(staffLookups[0].sql, /ur\.role IN \(\$1,\$2\)/);
    assert.ok(!/ANY\(\$1\)/.test(staffLookups[0].sql), 'a JS array in ANY() is driver-dependent');
    assert.deepEqual(staffLookups[0].values, ['SUPER_ADMIN', 'OPERATIONS_MANAGER']);
  });

  it('allows a general complaint with no order attached', async () => {
    const { service, calls } = harness();
    const result = await service.open(opener, { message: longText });
    assert.equal(result.orderId, null);
    assert.equal(calls.some(call => call.sql.includes('FROM orders o JOIN businesses')), false, 'no order means no order lookup');
  });
});

describe('SupportService.reply', () => {
  it('rejects a reply on a closed thread', async () => {
    const { service, writes } = harness({ ticket: { id: ticketId, order_id: null, opened_by: opener.sub, status: 'CLOSED', created_at: new Date(), updated_at: new Date() } });
    await assert.rejects(service.reply(opener, ticketId, { message: 'یک نکتهٔ دیگر' }), ConflictException);
    assert.deepEqual(writes(), []);
  });

  it('moves a first staff answer out of OPEN and writes the event', async () => {
    const { service, statuses, calls } = harness();
    const result = await service.reply(staff, ticketId, { message: 'بررسی شد، جبران می‌شود' });
    assert.deepEqual(result, { id: ticketId, status: 'IN_REVIEW', replied: true });
    assert.equal(statuses().length, 1);
    assert.deepEqual(statuses()[0].values, [ticketId, 'IN_REVIEW']);
    const event = calls.find(call => call.sql.includes('INSERT INTO support_ticket_events'))!;
    assert.deepEqual(event.values, [ticketId, staff.sub, 'OPEN', 'IN_REVIEW']);
    const audit = calls.find(call => call.sql.includes("'SUPPORT_TICKET_STATUS'"))!;
    assert.deepEqual(JSON.parse(String(audit.values?.[2])), { from: 'OPEN', to: 'IN_REVIEW', staff: true, via: 'reply' });
    assert.ok(calls.findIndex(call => call.sql === 'BEGIN') < calls.indexOf(audit) && calls.indexOf(audit) < calls.findIndex(call => call.sql === 'COMMIT'), 'the audit row commits with the reply');
  });

  it('reopens a resolved thread when the reporter answers', async () => {
    const { service, statuses } = harness({ ticket: { id: ticketId, order_id: null, opened_by: opener.sub, status: 'RESOLVED', created_at: new Date(), updated_at: new Date() } });
    const result = await service.reply(opener, ticketId, { message: 'هنوز حل نشده است' });
    assert.equal(result.status, 'OPEN', 'a resolved flag may not silence somebody still affected');
    assert.deepEqual(statuses()[0].values, [ticketId, 'OPEN']);
  });

  it('keeps the thread status alone for a plain follow-up', async () => {
    const { service, statuses, calls } = harness({ ticket: { id: ticketId, order_id: null, opened_by: opener.sub, status: 'IN_REVIEW', created_at: new Date(), updated_at: new Date() } });
    const result = await service.reply(opener, ticketId, { message: 'تصویر را فرستادم' });
    assert.equal(result.status, 'IN_REVIEW');
    assert.equal(statuses().length, 0, 'no transition means no status write');
    assert.equal(calls.some(call => call.sql.includes('INSERT INTO support_ticket_events')), false);
    assert.equal(calls.some(call => call.sql.includes("'SUPPORT_TICKET_STATUS'")), false, 'no transition means nothing to audit');
    assert.ok(calls.some(call => call.sql.includes('UPDATE support_tickets SET updated_at')));
  });

  it('notifies only the other side of the conversation', async () => {
    const { service, calls } = harness();
    await service.reply(staff, ticketId, { message: 'پاسخ پشتیبانی' });
    const notified = calls.filter(call => call.sql.includes('INSERT INTO notifications')).map(call => call.values?.[0]);
    assert.deepEqual(notified, [opener.sub]);
  });
});

describe('SupportService.setStatus', () => {
  const ticketWith = (status: string) => ({ ticket: { id: ticketId, order_id: null, opened_by: opener.sub, status, created_at: new Date(), updated_at: new Date() } });

  it('only walks the allowed rail', async () => {
    for (const [from, to] of [['CLOSED', 'IN_REVIEW'], ['CLOSED', 'RESOLVED'], ['RESOLVED', 'OPEN']] as const) {
      const { service, statuses } = harness({ ...ticketWith(from) });
      await assert.rejects(service.setStatus(staff, ticketId, { status: to, note: 'بازبینی' }), ConflictException, `${from} -> ${to} must stay impossible`);
      assert.equal(statuses().length, 0);
    }
  });

  it('refuses unknown statuses before touching the database', async () => {
    const { service, calls } = harness();
    for (const status of ['DONE', 'open', '', 'WAITING']) await assert.rejects(service.setStatus(staff, ticketId, { status }), BadRequestException);
    assert.equal(calls.length, 0, 'an unknown status must be refused before anybody else’s ticket is looked up');
  });

  it('keeps customers out of the status machine except closing their own ticket', async () => {
    const { service, writes } = harness(ticketWith('OPEN'));
    await assert.rejects(service.setStatus(opener, ticketId, { status: 'IN_REVIEW' }), BadRequestException);
    await assert.rejects(service.setStatus(opener, ticketId, { status: 'RESOLVED', note: 'خودم حل کردم' }), BadRequestException);
    assert.deepEqual(writes(), []);
    const allowed = harness(ticketWith('OPEN'));
    assert.deepEqual(await allowed.service.setStatus(opener, ticketId, { status: 'CLOSED' }), { id: ticketId, status: 'CLOSED' });
  });

  it('demands an explanation before calling a complaint resolved', async () => {
    const { service, statuses } = harness(ticketWith('IN_REVIEW'));
    await assert.rejects(service.setStatus(staff, ticketId, { status: 'RESOLVED' }), BadRequestException);
    await assert.rejects(service.setStatus(staff, ticketId, { status: 'RESOLVED', note: '   ' }), BadRequestException);
    assert.equal(statuses().length, 0);
  });

  it('guards against a status that moved underneath and tells the reporter', async () => {
    const { service, calls } = harness(ticketWith('IN_REVIEW'));
    const result = await service.setStatus(staff, ticketId, { status: 'RESOLVED', note: 'مبلغ بازگشت داده شد' });
    assert.deepEqual(result, { id: ticketId, status: 'RESOLVED' });
    const update = calls.find(call => call.sql.includes('UPDATE support_tickets SET status'))!;
    assert.match(update.sql, /WHERE id=\$1 AND status=\$3/, 'the write must compare the status it read');
    assert.deepEqual(update.values, [ticketId, 'RESOLVED', 'IN_REVIEW']);
    const notice = calls.find(call => call.sql.includes('INSERT INTO notifications'))!;
    assert.equal(notice.values?.[1], 'SUPPORT_TICKET_RESOLVED');
    assert.equal(notice.values?.[0], opener.sub);
    const audit = calls.find(call => call.sql.includes("'SUPPORT_TICKET_STATUS'"))!;
    assert.deepEqual(JSON.parse(String(audit.values?.[2])), { from: 'IN_REVIEW', to: 'RESOLVED', staff: true });
  });

  it('says nothing when the status is already what was asked for', async () => {
    const { service, writes } = harness(ticketWith('RESOLVED'));
    const result = await service.setStatus(staff, ticketId, { status: 'RESOLVED', note: 'تأکید دوباره' });
    assert.deepEqual(result, { id: ticketId, status: 'RESOLVED', unchanged: true });
    assert.deepEqual(writes(), []);
  });
});

describe('SupportService access and queues', () => {
  it('lets participants read a thread and nobody else', async () => {
    const { service, calls } = harness();
    const detail = await service.detail(opener, ticketId);
    assert.equal(detail.canChangeStatus, true, 'the reporter may close their own ticket');
    assert.equal(detail.canReply, true);
    const closedThread = harness({ ticket: { id: ticketId, order_id: null, opened_by: opener.sub, status: 'CLOSED', created_at: new Date(), updated_at: new Date() } });
    const closed = await closedThread.service.detail(opener, ticketId);
    assert.deepEqual({ canReply: closed.canReply, canChangeStatus: closed.canChangeStatus }, { canReply: false, canChangeStatus: false }, 'a closed thread is read-only, and the UI must know');
    const sql = calls[0].sql;
    assert.match(sql, /t\.opened_by=\$2/);
    assert.match(sql, /support_messages m WHERE m\.ticket_id=t\.id AND m\.author_id=\$2/);
    assert.match(sql, /b\.owner_id=\$2/);
    assert.match(sql, /d\.user_id=\$2/);
    assert.deepEqual(calls[0].values, [ticketId, opener.sub, false], 'the viewer id is bound once and reused by every branch');

    const denied = harness({ ticket: null });
    await assert.rejects(denied.service.detail({ sub: 'a0000000-0000-4000-8000-0000000000ff', roles: ['CUSTOMER'] }, ticketId), NotFoundException);
  });

  it('marks staff so their replies are recognisable in the thread', async () => {
    const { service, calls } = harness();
    await service.detail(staff, ticketId);
    assert.equal(calls[0].values?.[2], true);
    const [, second] = calls;
    assert.match(second.sql, /FROM support_messages|FROM support_ticket_events/, 'the thread and the events are read in parallel');
  });

  it('refuses to guess a ticket id into somebody else’s conversation', async () => {
    const { service, calls } = harness();
    await assert.rejects(service.detail(opener, 'everything'), BadRequestException);
    await assert.rejects(service.reply(opener, 'x'.repeat(40), { message: 'محتوای کافی دارد اینجا' }), BadRequestException);
    assert.equal(calls.length, 0);
  });

  it('filters my list by a known status only', async () => {
    const { service, calls } = harness();
    await service.mine(opener, { status: 'IN_REVIEW', limit: '10', offset: '0' });
    const list = calls.find(call => call.sql.includes('FROM support_tickets t LEFT JOIN orders'))!;
    assert.match(list.sql, /t\.status = \$3/);
    assert.deepEqual(list.values, [opener.sub, false, 'IN_REVIEW', 10, 0]);
    const { service: other } = harness();
    await assert.rejects(other.mine(opener, { status: 'ANYTHING' }), BadRequestException);
    await assert.rejects(other.mine(opener, { limit: '9999' }), BadRequestException);
    assert.equal(calls.length >= 2, true);
  });

  it('starts the staff queue on the oldest open work and counts every bucket', async () => {
    const { service, calls } = harness({ answer: sql => sql.includes('GROUP BY status')
      ? { rows: [{ status: 'OPEN', count: 4 }, { status: 'IN_REVIEW', count: 1 }], rowCount: 2 }
      : sql.includes('COUNT(*)::int AS "totalMatches"')
        ? { rows: [{ totalMatches: 4 }], rowCount: 1 }
        : null });
    const queue = await service.queue({ search: '0912' });
    assert.equal(calls.length, 3, 'the list, the buckets and the page total are read together');
    assert.deepEqual(queue.counts, { OPEN: 4, IN_REVIEW: 1 });
    const list = calls[0];
    assert.match(list.sql, /ORDER BY t\.updated_at ASC/, 'oldest first: nobody should sit at the back of the queue');
    assert.match(list.sql, /u\.phone ILIKE \$2 OR u\.display_name ILIKE \$2/, 'searching by number stays possible');
    assert.match(list.sql, /RIGHT\(REGEXP_REPLACE\(u\.phone/, 'the number goes through a normaliser');
    assert.match(list.sql, /4\) AS "authorTail"/, 'only the last four digits are returned');
    assert.ok(!/u\.phone AS/.test(list.sql), 'the queue must not select the whole phone number');
    assert.deepEqual(list.values, ['OPEN', '%0912%', 25, 0], 'one search term, four columns, bound once');
    const defaults = await service.queue({});
    assert.equal(defaults.totalMatches, 4, 'no status means the open pile');
    const total = calls.find(call => call.sql.includes('totalMatches'))!;
    const whereOf = (sql: string) => { const from = sql.lastIndexOf(' WHERE'); const to = sql.indexOf(' ORDER BY', from); return sql.slice(from, to === -1 ? undefined : to).trim(); };
    assert.equal(whereOf(total.sql), whereOf(list.sql), 'the total counts exactly what the page lists');
    assert.deepEqual(total.values, ['OPEN', '%0912%']);
  });
});

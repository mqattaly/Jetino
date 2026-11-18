import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DeliveryService } from './delivery.service';

const orderId = '123e4567-e89b-12d3-a456-426614174040';
// principals carry real uuid subjects, exactly like the JWT strategy hands them to the service
const customer = { sub: 'a0000000-0000-4000-8000-0000000000c1', roles: ['CUSTOMER'] };
const staff = { sub: 'a0000000-0000-4000-8000-0000000000a1', roles: ['OPERATIONS_MANAGER'] };

type Pins = { originLatitude: string | null; originLongitude: string | null; destinationLatitude: string | null; destinationLongitude: string | null };
const withPins = (overrides: Partial<Pins> = {}): Pins & { id: string } => ({
  id: orderId,
  originLatitude: '27.200000', originLongitude: '55.700000',
  destinationLatitude: '27.210000', destinationLongitude: '55.710000',
  ...overrides,
});

function serviceFor(rows: unknown[] | null) {
  const queries: string[] = [];
  const pool = { query: async (sql: string) => { queries.push(sql); return { rows: rows ?? [], rowCount: rows?.length ?? 0 }; } };
  return { service: new DeliveryService(pool as never), queries };
}

const originalKey = process.env.NESHAN_SERVER_KEY;
const originalTimeout = process.env.NESHAN_TIMEOUT_MS;
type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;
const previousFetch = globalThis.fetch;

function useFetch(stub: FetchStub) {
  let calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return stub(url, init);
  }) as never;
  return { calls: () => calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => { process.env.NESHAN_SERVER_KEY = ''; });
afterEach(() => {
  process.env.NESHAN_SERVER_KEY = originalKey ?? '';
  process.env.NESHAN_TIMEOUT_MS = originalTimeout;
  globalThis.fetch = previousFetch;
});

describe('DeliveryService access control', () => {
  it('rejects a malformed order id before touching the database', async () => {
    const service = new DeliveryService({ query: async () => { throw new Error('unreachable'); } } as never);
    await assert.rejects(service.estimateForOrder(customer, 'not-an-id'), BadRequestException);
  });

  it('hides orders that do not belong to the caller', async () => {
    const { service, queries } = serviceFor(null);
    await assert.rejects(service.estimateForOrder(customer, orderId), NotFoundException);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /o\.customer_id=\$2 OR b\.owner_id=\$2 OR d\.user_id=\$2/);
  });

  it('treats a caller whose subject is not an id as having no access', async () => {
    let queried = false;
    const service = new DeliveryService({ query: async () => { queried = true; return { rows: [withPins()], rowCount: 1 }; } } as never);
    await assert.rejects(service.estimateForOrder({ sub: 'stranger', roles: ['CUSTOMER'] }, orderId), NotFoundException);
    assert.equal(queried, false, 'a malformed subject must not reach a uuid comparison in SQL');
  });

  it('grants staff a read-only estimate without a driver assignment', async () => {
    const { service, queries } = serviceFor([withPins({ destinationLatitude: null, destinationLongitude: null })]);
    const result = await service.estimateForOrder(staff, orderId);
    assert.deepEqual(result, {
      available: false, reason: 'DESTINATION_LOCATION_MISSING',
      message: 'این نشانی مختصات ندارد؛ برآورد مسیر فقط پس از ثبت مختصات ممکن است.', orderId,
    });
    assert.equal(queries.length, 1, 'a missing pin must not trigger an upstream call');
  });
});

describe('DeliveryService fallback estimate', () => {
  it('stretches the straight line to a road distance when no routing key is configured', async () => {
    const { service } = serviceFor([withPins()]);
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return json({}); }) as never;
    const estimate = await service.estimateForOrder(customer, orderId);
    assert.equal(estimate.available, true);
    if (!estimate.available) return assert.fail('expected an estimate');
    assert.equal(estimate.source, 'ESTIMATED');
    assert.equal(estimate.distanceMeters, 2009, '1488 m straight line × 1.35 road factor');
    assert.equal(estimate.durationMinutes, 5);
    assert.match(String(estimate.note), /کلید مسیریابی/);
    assert.equal(fetched, false, 'nothing may leave the server without a key');
  });

  it('refuses to invent a route when either end lacks a pin', async () => {
    const missingOrigin = serviceFor([withPins({ originLatitude: null, originLongitude: null })]);
    assert.deepEqual(await missingOrigin.service.estimateForOrder(customer, orderId), {
      available: false, reason: 'BUSINESS_LOCATION_MISSING',
      message: 'برای محاسبهٔ مسیر، صاحب کسب‌وکار باید محل فروشگاه را ثبت کند.', orderId,
    });
    const missingDestination = serviceFor([withPins({ destinationLatitude: null })]);
    const second = await missingDestination.service.estimateForOrder(customer, orderId);
    assert.equal(second.available, false);
    if (!second.available) assert.equal(second.reason, 'DESTINATION_LOCATION_MISSING');
  });
});

describe('DeliveryService Neshan routing', () => {
  it('sends the key as a header, reads distance and duration, and never echoes the secret', async () => {
    process.env.NESHAN_SERVER_KEY = 'super-secret-routing-key';
    const { calls } = useFetch(async () => json({ routes: [{ legs: [{ distance: { value: 6420.6, text: '۶ کیلومتر' }, duration: { value: 1210, text: '۲۰ دقیقه' } }] }] }));
    const { service } = serviceFor([withPins()]);
    const estimate = await service.estimateForOrder(customer, orderId);
    assert.equal(estimate.available, true);
    if (!estimate.available) return assert.fail('expected a route');
    assert.deepEqual({ source: estimate.source, distanceMeters: estimate.distanceMeters, durationMinutes: estimate.durationMinutes, cached: estimate.cached }, { source: 'NESHAN', distanceMeters: 6421, durationMinutes: 20, cached: false });
    assert.equal(JSON.stringify(estimate).includes('super-secret-routing-key'), false, 'the response must not carry the key');

    const [request] = calls();
    assert.match(request.url, /^https:\/\/api\.neshan\.org\/v4\/direction\?type=car&origin=27\.2,55\.7&destination=27\.21,55\.71$/);
    assert.ok(!request.url.includes('super-secret-routing-key'), 'the key must never be part of the URL');
    assert.equal((request.init?.headers as Record<string, string>)['Api-Key'], 'super-secret-routing-key');
  });

  it('serves a repeat lookup for the same pair from cache and skips the network', async () => {
    process.env.NESHAN_SERVER_KEY = 'routing-key';
    let responses = 0;
    const { calls } = useFetch(async () => { responses += 1; return json({ routes: [{ legs: [{ distance: { value: 1000 }, duration: { value: 300 } }] }] }); });
    const first = serviceFor([withPins()]);
    const a = await first.service.estimateForOrder(customer, orderId);
    const b = await first.service.estimateForOrder(customer, orderId);
    assert.equal(a.available && 'distanceMeters' in a ? a.distanceMeters : 0, 1000);
    if (b.available) assert.deepEqual({ cached: b.cached, distanceMeters: b.distanceMeters }, { cached: true, distanceMeters: 1000 });
    assert.equal(calls().length, 1);
    assert.equal(responses, 1);
  });

  it('degrades quietly on upstream failures without leaking the upstream message', async () => {
    process.env.NESHAN_SERVER_KEY = 'routing-key';
    const failing = [
      async () => { throw new Error('ECONNREFUSED 10.0.0.5 with Api-Key routing-key'); },
      async () => json({ error: 'quota exceeded' }, 429),
      async () => json({ routes: [] }),
      async () => json({ routes: [{ legs: [{ distance: { value: -5 }, duration: { value: 10 } }] }] }),
    ];
    for (const stub of failing) {
      useFetch(stub);
      const { service } = serviceFor([withPins()]);
      const estimate = await service.estimateForOrder(customer, orderId);
      assert.equal(estimate.available, true);
      if (!estimate.available) continue;
      assert.equal(estimate.source, 'ESTIMATED');
      assert.equal(estimate.distanceMeters, 2009);
      const text = JSON.stringify(estimate);
      assert.ok(!/ECONN|quota|routing-key/.test(text), `upstream detail leaked: ${text}`);
    }
  });

  it('aborts a hanging provider request and returns the estimate', async () => {
    process.env.NESHAN_SERVER_KEY = 'routing-key';
    process.env.NESHAN_TIMEOUT_MS = '500';
    let aborted = false;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    })) as never;
    const { service } = serviceFor([withPins()]);
    const estimate = await service.estimateForOrder(customer, orderId);
    if (!estimate.available) return assert.fail('expected an estimate');
    assert.deepEqual({ source: estimate.source, cached: estimate.cached }, { source: 'ESTIMATED', cached: false });
    assert.equal(aborted, true, 'the request must be cancelled so a slow provider cannot pin a worker');
  });

  it('keeps an unusable configured type or url out of the request', async () => {
    process.env.NESHAN_SERVER_KEY = 'routing-key';
    process.env.NESHAN_DIRECTION_TYPE = 'helicopter';
    const { calls } = useFetch(async () => json({ routes: [{ legs: [{ distance: { value: 500 }, duration: { value: 120 } }] }] }));
    const { service } = serviceFor([withPins()]);
    await service.estimateForOrder(customer, orderId);
    assert.match(calls()[0].url, /type=car/);
    delete process.env.NESHAN_DIRECTION_TYPE;
  });
});

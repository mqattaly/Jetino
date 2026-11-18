import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { REQUIRED_ROLES, RolesGuard } from '../auth/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CancellationsController } from './cancellations.controller';
import { OrdersController } from '../orders/orders.controller';
import { POLICY_OPTIONS, REQUEST_OUTCOMES } from './cancellation-policy';

/**
 * §7.11 is wired from three screens written apart from these controllers, and a dropped role guard on
 * the refund route would quietly let any signed-in customer move money. So the paths, the guard stack
 * and the names the client types into fetch() are pinned here, in one file.
 */
const GUARDS_METADATA = '__guards__';
const mainSource = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
const globalPrefix = (mainSource.match(/setGlobalPrefix\('([^']+)'\)/) ?? [])[1];
assert.equal(globalPrefix, 'api/v1', 'the HTTP surface test below assumes the versioned prefix the client uses');

type Route = { controller: string; handler: string; method: string; path: string; jwt: boolean; rolesGuard: boolean; roles: string[] | undefined };

function routesOf(controller: { name: string; prototype: object }): Route[] {
  const base = String(Reflect.getMetadata('path', controller) ?? '');
  const classGuards = (Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as unknown[];
  const classRoles = Reflect.getMetadata(REQUIRED_ROLES, controller) as string[] | undefined;
  return Object.getOwnPropertyNames(controller.prototype)
    .filter(name => name !== 'constructor')
    .map(name => ({ handler: name, value: Object.getOwnPropertyDescriptor(controller.prototype, name)?.value as ((...args: unknown[]) => unknown) | undefined }))
    .filter((entry): entry is { handler: string; value: (...args: unknown[]) => unknown } => entry.value !== undefined)
    .map(({ handler, value }) => {
      const method = Reflect.getMetadata('method', value);
      const sub = Reflect.getMetadata('path', value);
      if (typeof method !== 'number' || typeof sub !== 'string') return undefined;
      const joined = [`/${globalPrefix}`, base, sub].filter(part => part !== '').join('/').replace(/\/{2,}/g, '/').replace(/\/$/, '');
      const guards = [...classGuards, ...((Reflect.getMetadata(GUARDS_METADATA, value) ?? []) as unknown[])];
      return {
        controller: controller.name, handler, method: RequestMethod[method],
        path: joined.startsWith('/') ? joined : `/${joined}`,
        jwt: guards.includes(JwtAuthGuard), rolesGuard: guards.includes(RolesGuard),
        roles: (Reflect.getMetadata(REQUIRED_ROLES, value) ?? classRoles) as string[] | undefined,
      };
    })
    .filter((route): route is Route => route !== undefined);
}

const cancellations = routesOf(CancellationsController);
const surface = [...cancellations, ...routesOf(OrdersController)];
const find = (method: string, path: string) => surface.find(route => route.method === method && route.path === path);
const STAFF = ['OPERATIONS_MANAGER', 'SUPER_ADMIN'];

describe('cancellation HTTP surface', () => {
  it('exposes exactly the paths the panels call', () => {
    assert.deepEqual(
      cancellations.map(route => `${route.method} ${route.path}`).sort(),
      [
        'GET /api/v1/cancellations/policy',
        'PATCH /api/v1/cancellations/policy',
        'GET /api/v1/cancellations/orders/:orderId',
        'GET /api/v1/cancellations/orders/:orderId/refunds',
        'POST /api/v1/cancellations/orders/:orderId/refunds',
        'GET /api/v1/cancellations/queue',
        'PATCH /api/v1/cancellations/requests/:id',
      ].sort(),
    );
  });

  it('requires a login token on every one of them', () => {
    assert.deepEqual(surface.filter(route => !route.jwt && route.controller === 'CancellationsController').map(route => route.path), []);
  });

  it('keeps money and platform rules behind roles, and leaves the answer to a request open', () => {
    assert.deepEqual(cancellations.filter(route => route.rolesGuard).map(route => `${route.method} ${route.path}`).sort(), [
      'GET /api/v1/cancellations/queue',
      'PATCH /api/v1/cancellations/policy',
      'POST /api/v1/cancellations/orders/:orderId/refunds',
    ].sort(), 'only staff may read the whole queue, change the rules or record a refund');
    assert.deepEqual(find('PATCH', '/api/v1/cancellations/policy')!.roles, ['SUPER_ADMIN'], 'the platform-wide rule is a super admin decision');
    for (const route of cancellations.filter(entry => entry.rolesGuard)) {
      if (route.path === '/api/v1/cancellations/policy') continue;
      assert.deepEqual([...(route.roles ?? [])].sort(), STAFF, `${route.path} must name both staff roles`);
    }
    const decide = find('PATCH', '/api/v1/cancellations/requests/:id');
    assert.ok(decide);
    assert.equal(decide.rolesGuard, false, 'the shop that owns the order answers its own requests, so the service decides');
    const ledger = find('GET', '/api/v1/cancellations/orders/:orderId/refunds');
    assert.equal(ledger!.rolesGuard, false, 'a customer may always read what was refunded to them');
  });

  it('still lets the customer cancel through the order route', () => {
    const cancel = find('POST', '/api/v1/orders/:id/cancel');
    assert.ok(cancel, 'the request is filed on the order it belongs to');
    assert.equal(cancel.jwt, true);
    assert.equal(cancel.rolesGuard, false, 'a customer must not need a staff role to ask for a cancellation');
  });

  it('matches the paths the screens actually call', () => {
    const clientSource = readFileSync(join(__dirname, '..', '..', '..', 'src', 'Cancellations.tsx'), 'utf8');
    const raw = Array.from(clientSource.matchAll(/[`']\/api\/v1\/(?:cancellations|orders)\/[^`']*[`']/g)).map(match => match[0].slice(1, -1));
    const called = raw.map(path => path.replace(/\$\{[^}]+\}/g, ':x').replace(/\?[^`]*$/, ''));
    // a filter the server does not read is silently ignored, so the parameter names are pinned too
    const sent = new Set<string>(Array.from(clientSource.matchAll(/query\.set\('([a-z]+)'/g)).map(match => match[1]));
    for (const literal of clientSource.match(/new URLSearchParams\(\{([^}]*)\}\)/g) ?? []) {
      for (const key of literal.matchAll(/([a-zA-Z]+):/g)) sent.add(key[1]);
    }
    assert.deepEqual(Array.from(sent).sort(), ['limit', 'offset', 'outcome', 'search'], 'the board may only send filters the queue understands');
    assert.ok(called.length >= 5, `the screens should be talking to this module (found ${called.length} calls)`);
    const known = new Set(surface.map(route => route.path.replace(/:[A-Za-z]+/g, ':x')));
    assert.deepEqual(Array.from(new Set(called)).filter(path => !known.has(path)), [], 'a typo in a fetch() path is a silent 404 in production');
    for (const path of ['/api/v1/cancellations/queue', '/api/v1/cancellations/policy', '/api/v1/cancellations/orders/:x', '/api/v1/orders/:x/cancel']) {
      assert.ok(called.includes(path), `the client must still call ${path}`);
    }
  });

  it('offers the client only the options the API accepts', () => {
    const clientSource = readFileSync(join(__dirname, '..', '..', '..', 'src', 'Cancellations.tsx'), 'utf8');
    const optionBlock = (clientSource.match(/const STATUS_OPTIONS = \[([\s\S]*?)\] as const;/) ?? [])[1];
    assert.ok(optionBlock, 'the board must list the statuses an operator may grant');
    const offered = Array.from(optionBlock.matchAll(/value:'([A-Z_]+)'/g)).map(match => match[1]);
    assert.deepEqual(offered, POLICY_OPTIONS, 'the tickboxes are exactly the statuses the parser accepts, in the same order');
    const tabBlock = clientSource.match(/const OUTCOMES = \[([^\]]+)\]/);
    assert.ok(tabBlock, 'the queue tabs come from the outcomes the table can hold');
    assert.deepEqual(tabBlock[1].match(/'[A-Z]+'/g)?.map(value => value.replace(/'/g, '')), REQUEST_OUTCOMES);
  });
});

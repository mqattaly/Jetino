import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { REQUIRED_ROLES, RolesGuard } from '../auth/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  FeedbackAdminController,
  FeedbackQueryController,
  OrderFeedbackController,
  SupportTicketController,
} from './support.controller';

/**
 * The admin queue, the moderation route and the customer endpoints are wired from screens
 * written separately from these controllers, so a renamed path would only show up as a
 * silent 404 in a panel and a dropped guard only as a hole. Both are cheap to pin here.
 */
/** Nest keeps @UseGuards under its own metadata key; reading it is the only way to test the guard stack without bootting the app. */
const GUARDS_METADATA = '__guards__';

type Route = { controller: string; handler: string; method: string; path: string; jwt: boolean; rolesGuard: boolean; roles: string[] | undefined };

/** The URL prefix is set once, in main.ts; the panels call the prefixed form, so read it rather than duplicate it. */
const mainSource = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
const globalPrefix = (mainSource.match(/setGlobalPrefix\('([^']+)'\)/) ?? [])[1];
assert.equal(globalPrefix, 'api/v1', 'the HTTP surface test below assumes the versioned prefix the client uses');

function endpoint(prototype: object, handler: string): ((...args: unknown[]) => unknown) | undefined {
  return Object.getOwnPropertyDescriptor(prototype, handler)?.value as ((...args: unknown[]) => unknown) | undefined;
}

function routesOf(controller: { name: string; prototype: object }): Route[] {
  const base = String(Reflect.getMetadata('path', controller) ?? '');
  const classGuards = (Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as unknown[];
  const classRoles = Reflect.getMetadata(REQUIRED_ROLES, controller) as string[] | undefined;
  return Object.getOwnPropertyNames(controller.prototype)
    .filter(name => name !== 'constructor')
    .map(name => ({ handler: name, value: endpoint(controller.prototype, name) }))
    .filter((entry): entry is { handler: string; value: (...args: unknown[]) => unknown } => entry.value !== undefined)
    .map(({ handler, value }) => {
      const method = Reflect.getMetadata('method', value);
      const sub = Reflect.getMetadata('path', value);
      if (typeof method !== 'number' || typeof sub !== 'string') return undefined;
      const joined = [`/${globalPrefix}`, base, sub].filter(part => part !== '').join('/').replace(/\/{2,}/g, '/').replace(/\/$/, '');
      const guards = [...classGuards, ...((Reflect.getMetadata(GUARDS_METADATA, value) ?? []) as unknown[])];
      return {
        controller: controller.name,
        handler,
        method: RequestMethod[method],
        path: joined.startsWith('/') ? joined : `/${joined}`,
        jwt: guards.includes(JwtAuthGuard),
        rolesGuard: guards.includes(RolesGuard),
        roles: (Reflect.getMetadata(REQUIRED_ROLES, value) ?? classRoles) as string[] | undefined,
      };
    })
    .filter((route): route is Route => route !== undefined);
}

const surface = [OrderFeedbackController, FeedbackQueryController, FeedbackAdminController, SupportTicketController].flatMap(routesOf);
const find = (method: string, path: string) => surface.find(route => route.method === method && route.path === path);
const STAFF = ['OPERATIONS_MANAGER', 'SUPER_ADMIN'];

/**
 * The panels are plain fetch() calls with hand-written paths, so this reads the screen file
 * and proves every path it names under this module is a route that actually exists.
 */
const clientSource = readFileSync(join(__dirname, '..', '..', '..', 'src', 'FeedbackSupport.tsx'), 'utf8');

describe('feedback and support HTTP surface', () => {
  it('exposes exactly the paths the panels call', () => {
    assert.deepEqual(
      surface.map(route => `${route.method} ${route.path}`).sort(),
      [
        'GET /api/v1/orders/:orderId/feedback',
        'PUT /api/v1/orders/:orderId/feedback',
        'GET /api/v1/feedback/businesses/:businessId',
        'GET /api/v1/feedback/drivers/me',
        'GET /api/v1/feedback/admin',
        'DELETE /api/v1/feedback/admin/:id',
        'GET /api/v1/support/tickets/mine',
        'GET /api/v1/support/tickets/admin/queue',
        'GET /api/v1/support/tickets/:id',
        'POST /api/v1/support/tickets',
        'POST /api/v1/support/tickets/:id/messages',
        'PATCH /api/v1/support/tickets/:id/status',
      ].sort(),
    );
  });

  it('requires a login token on every one of them', () => {
    assert.deepEqual(surface.filter(route => !route.jwt).map(route => route.path), [], 'a feedback or support route without JwtAuthGuard is never public');
  });

  it('keeps moderation and the staff queue behind roles, and nothing else', () => {
    assert.deepEqual(surface.filter(route => route.rolesGuard).map(route => `${route.method} ${route.path}`).sort(), [
      'DELETE /api/v1/feedback/admin/:id',
      'GET /api/v1/feedback/admin',
      'GET /api/v1/support/tickets/admin/queue',
    ]);
    for (const route of surface.filter(entry => entry.rolesGuard)) {
      assert.deepEqual([...(route.roles ?? [])].sort(), STAFF, `${route.path} must name both staff roles`);
    }
    for (const [method, path] of [['GET', '/api/v1/orders/:orderId/feedback'], ['PUT', '/api/v1/orders/:orderId/feedback'], ['POST', '/api/v1/support/tickets'], ['POST', '/api/v1/support/tickets/:id/messages'], ['GET', '/api/v1/feedback/drivers/me']] as const) {
      const route = find(method, path);
      assert.ok(route, `${method} ${path} exists`);
      assert.equal(route.rolesGuard, false, `${path} is written by customers and couriers, so a role guard would lock them out of their own feedback`);
    }
  });

  it('matches the paths the screens actually call', () => {
    const called = Array.from(clientSource.matchAll(/`?(\/api\/v1\/(?:orders\/\$\{[^}]+\}|orders\/:orderId)\/feedback|\/api\/v1\/feedback[^`'?,]*|\/api\/v1\/support\/tickets[^`'?,]*)`?/g))
      .map(match => match[1].replace(/\/\$\{[^}]+\}/g, '/:x').replace(/\?\$\{[^}]+\}/g, ''));
    assert.ok(called.length >= 8, `the screens should be talking to this module (found ${called.length} calls)`);
    const known = new Set(surface.map(route => route.path.replace(/:[A-Za-z]+/g, ':x')));
    const unknown = Array.from(new Set(called)).filter(path => !known.has(path));
    assert.deepEqual(unknown, [], 'a typo in a fetch() path is a silent 404 in production');
    for (const path of ['/api/v1/support/tickets/mine', '/api/v1/support/tickets/admin/queue', '/api/v1/feedback/drivers/me', '/api/v1/feedback/businesses/:x']) {
      assert.ok(called.includes(path), `the client must still call ${path}`);
    }
  });

  it('lets the reporter close a thread without giving them the staff guard', () => {
    const status = find('PATCH', '/api/v1/support/tickets/:id/status');
    assert.ok(status);
    assert.equal(status.rolesGuard, false, 'a customer may close their own report, and the service decides whether they may');
    assert.equal(status.controller, 'SupportTicketController');
  });
});

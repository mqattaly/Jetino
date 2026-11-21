import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

/**
 * A feature module that is imported at the top of app.module.ts but never listed in `imports`
 * still compiles, still type-checks and still passes every service test — because Nest only wires
 * controllers when it walks the module graph. The result is an entire feature returning 404 in
 * production with a green CI, which is how this project actually lost the support surface once.
 * So the graph is checked here instead of trusted.
 */
const sourceRoot = __dirname;

function filesIn(directory: string, predicate: (name: string) => boolean, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) filesIn(join(directory, entry.name), predicate, found);
    else if (predicate(entry.name)) found.push(join(directory, entry.name));
  }
  return found;
}

/** Controllers carry metadata only if their module is mounted, so walk AppModule's imports instead of guessing. */
function mountedControllers(): Map<string, string[]> {
  const { AppModule } = require(join(sourceRoot, 'app.module.ts')) as { AppModule: Function };
  const seen = new Map<string, string[]>();
  const queue: unknown[] = [AppModule];
  while (queue.length) {
    const node = queue.shift() as Function | { module?: unknown };
    const target = (typeof node === 'function' ? node : (node as { module?: unknown }).module) as Function | undefined;
    if (!target) continue;
    for (const controller of (Reflect.getMetadata('controllers', target) ?? []) as Function[]) {
      const path = String(Reflect.getMetadata('path', controller) ?? '');
      seen.set(path, [...(seen.get(path) ?? []), controller.name]);
    }
    for (const imported of (Reflect.getMetadata('imports', target) ?? []) as unknown[]) if (imported) queue.push(imported);
  }
  return seen;
}

/** Full `METHOD /path` for every handler on every mounted controller. */
function mountedRoutes(): string[] {
  const { AppModule } = require(join(sourceRoot, 'app.module.ts')) as { AppModule: Function };
  const routes: string[] = [];
  const queue: unknown[] = [AppModule];
  const methods: Record<number, string> = { 0: 'GET', 1: 'POST', 2: 'PUT', 3: 'DELETE', 4: 'PATCH', 5: 'ALL', 6: 'OPTIONS', 7: 'HEAD' };
  while (queue.length) {
    const node = queue.shift() as Function | { module?: unknown };
    const target = (typeof node === 'function' ? node : (node as { module?: unknown }).module) as Function | undefined;
    if (!target) continue;
    for (const controller of (Reflect.getMetadata('controllers', target) ?? []) as Function[]) {
      const prefix = String(Reflect.getMetadata('path', controller) ?? '');
      for (const key of Object.getOwnPropertyNames(controller.prototype)) {
        if (key === 'constructor') continue;
        const handler = (controller.prototype as unknown as Record<string, unknown>)[key] as Function;
        const method = methods[Number(Reflect.getMetadata('method', handler))];
        if (!method) continue;
        const paths = Reflect.getMetadata('path', handler);
        for (const path of (Array.isArray(paths) ? paths : [paths ?? '']) as string[]) {
          routes.push(`${method} /${[prefix, String(path)].filter(Boolean).join('/')}`.replace(/\/+/g, '/'));
        }
      }
    }
    for (const imported of (Reflect.getMetadata('imports', target) ?? []) as unknown[]) if (imported) queue.push(imported);
  }
  return routes;
}

describe('module graph', () => {
  it('mounts every controller that exists in the source tree', () => {
    const mounted = mountedControllers();
    const files = filesIn(sourceRoot, name => name.endsWith('.controller.ts') && !name.endsWith('.spec.ts'));
    assert.ok(files.length >= 10, `the scan should find the app's controllers (found ${files.length})`);
    const missing: string[] = [];
    for (const file of files) {
      const loaded = require(file) as Record<string, unknown>;
      const controllers = Object.values(loaded).filter(value => typeof value === 'function' && Reflect.hasMetadata('path', value as object)) as Function[];
      assert.ok(controllers.length >= 1, `${file.split('/').pop()} declares no controller`);
      for (const controller of controllers) {
        const path = String(Reflect.getMetadata('path', controller) ?? '');
        if (!mounted.has(path)) missing.push(`${controller.name} → ${path || '/'}`);
      }
    }
    assert.deepEqual(missing, [], 'a controller whose module is not in AppModule.imports is unreachable at runtime');
  });

  it('keeps the feedback and support surfaces mounted', () => {
    const mounted = mountedControllers();
    for (const path of ['orders/:orderId/feedback', 'feedback', 'feedback/admin', 'support/tickets']) {
      assert.ok(mounted.has(path), `${path} must be mounted for the panels to work`);
    }
  });

  it('registers each method and path once, however many controllers share a prefix', () => {
    const routes = mountedRoutes();
    const duplicates = routes.filter((route, index) => routes.findIndex(other => other === route) !== index);
    assert.deepEqual([...new Set(duplicates)], [], 'two controllers answering the same METHOD path makes the handler depend on module order');
  });

  it('keeps the notifications prefix split between the inbox and the delivery ledger', () => {
    // both controllers live under `notifications`; that is only safe because their paths are disjoint
    const routes = mountedRoutes();
    for (const route of ['GET /notifications/:id/delivery', 'GET /notifications/delivery/stats', 'POST /notifications/dispatch']) {
      assert.ok(routes.includes(route), `${route} has to stay reachable`);
    }
    assert.ok(!routes.includes('GET /notifications/delivery'), 'the admin queue must not shadow the per-notification route');
  });
});

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

  it('wires each feature module exactly once', () => {
    const mounted = mountedControllers();
    const duplicates = Array.from(mounted.entries()).filter(([, owners]) => owners.length > 1).map(([path, owners]) => `${path}: ${owners.join(', ')}`);
    assert.deepEqual(duplicates, [], 'the same route prefix registered twice makes the served handler depend on module order');
  });
});

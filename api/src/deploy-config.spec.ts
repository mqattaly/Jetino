import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

/**
 * The deployment shape is code, so it is tested like code. Every mistake in this file has already
 * happened once: a rewrite rule that still pointed at a deleted entry file deploys as a READY build
 * and answers 404 on every request, which no API test can see.
 */
const ROOT = resolve(__dirname, '..', '..');
const config = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8')) as {
  framework: string | null;
  builds?: Array<{ src: string; use: string; config?: { includeFiles?: string; distDir?: string } }>;
  routes?: Array<{ src?: string; dest?: string; handle?: string }>;
  crons?: Array<{ path: string; schedule: string }>;
  functions?: unknown;
};

const nodeBuilders = (config.builds ?? []).filter((entry) => entry.use === '@vercel/node');

describe('vercel deployment configuration', () => {
  it('turns framework detection off and keeps `functions` out of the way', () => {
    assert.equal(config.framework, null, 'auto-detection would turn every file under api/ into a function');
    assert.equal(config.functions, undefined, '`functions` and `builds` cannot both be set');
  });

  it('ships only one API function, from a file that exists', () => {
    assert.equal(nodeBuilders.length, 1);
    const entry = nodeBuilders[0];
    assert.ok(existsSync(resolve(ROOT, entry.src)), `${entry.src} must exist`);
    assert.match(entry.src, /^[^/]+\.cjs$/, 'the entry has to sit at the repository root: its directory becomes the bundle root');
    assert.ok(existsSync(resolve(ROOT, entry.config?.includeFiles?.replace('/**', '') ?? '')), 'includeFiles points at a real directory');
  });

  it('routes every API path at that same entry file', () => {
    const api = (config.routes ?? []).find((route) => route.src === '/api/(.*)');
    assert.ok(api, 'a /api/(.*) rewrite is required');
    assert.equal(api.dest, nodeBuilders[0].src, 'the rewrite and the builder must name the same file');
  });

  it('lets the scheduler in through the API, not around it', () => {
    const cron = (config.crons ?? []).find((entry) => entry.path.includes('dispatch'));
    assert.ok(cron, 'the delivery queue needs a platform schedule as a backstop');
    assert.match(cron.path, /^\/api\/v1\/notifications\/dispatch$/);
    assert.match(cron.schedule, /^\d+ \d+ \* \* \*$/, 'the hobby plan allows one run a day; faster cadence belongs to the Actions workflow');
  });

  it('drives the scheduler route the API actually opens for it', () => {
    const workflow = readFileSync(resolve(ROOT, '.github/workflows/notification-sweep.yml'), 'utf8').replace(/\s+/g, ' ');
    const controller = readFileSync(resolve(__dirname, 'notifications/notification-delivery.controller.ts'), 'utf8').replace(/\s+/g, ' ');
    // POST /notifications/dispatch is the staff action behind a JWT; a scheduler must use the GET half
    assert.match(controller, /@Get\('dispatch'\)/);
    assert.match(workflow, /notifications\/dispatch\?limit=50/);
    assert.doesNotMatch(workflow, /-X POST/, 'the cron cannot hold a staff session');
    assert.match(workflow, /Authorization: Bearer \$CRON_SECRET/, 'the bearer header is what cronAuthorized checks');
  });

  it('loads the API boot dependencies as CommonJS', () => {
    // api/dist is CommonJS, so anything a module-scope `import … from` turns into `require()` has to
    // be requirable. web-push is deliberately absent from this rule: it is reached through an awaited
    // dynamic import() inside a try/catch, so an ESM-only web-push degrades the sender instead of
    // killing the cold start. @nestjs/jwt v12 shipped as ESM-only and broke the deploy exactly this way.
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'api/package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const runtime = Object.keys(pkg.dependencies);
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (path.endsWith('.ts') && !path.endsWith('.spec.ts')) files.push(path);
      }
    };
    walk(resolve(ROOT, 'api/src'));
    const staticallyImported = new Set<string>();
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/^import\s[^;]*?from\s*['"]([^'".\/][^'"]*)['"]/gm)) {
        staticallyImported.add(match[1].startsWith('@') ? match[1].split('/').slice(0, 2).join('/') : match[1].split('/')[0]);
      }
    }
    const esmOnly = runtime.filter((name) => {
      if (!staticallyImported.has(name)) return false;
      try {
        const meta = JSON.parse(readFileSync(require.resolve(`${name}/package.json`, { paths: [resolve(ROOT, 'api')] }), 'utf8')) as { type?: string; exports?: Record<string, unknown> };
        const conditions = meta.exports?.['.'] ?? meta.exports;
        const hasRequire = typeof conditions === 'object' && conditions !== null && 'require' in (conditions as Record<string, unknown>);
        return meta.type === 'module' && !hasRequire;
      } catch {
        return false;
      }
    });
    assert.deepEqual(esmOnly, [], 'an ESM-only dependency in the boot graph makes the serverless function fail to start');
  });

  it('requires nothing outside its own bundle root', () => {
    const entry = readFileSync(resolve(ROOT, nodeBuilders[0].src), 'utf8');
    const paths = [...entry.matchAll(/require\('(\.[^']+)'\)/g)].map((match) => match[1]);
    assert.ok(paths.length >= 3, 'the entry loads the Nest runtime from relative paths on purpose');
    for (const specifier of paths) {
      assert.ok(!specifier.startsWith('../'), `${specifier} leaves the bundle root and cannot resolve on the platform`);
      assert.ok(existsSync(resolve(ROOT, specifier)), `${specifier} does not exist at build time`);
    }
  });
});

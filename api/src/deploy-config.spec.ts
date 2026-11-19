import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
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

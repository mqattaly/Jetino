import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { LEDGER, LEDGER_DDL, RECORD_SQL, planBaseline } from './baseline';

/**
 * A baseline is the one migration tool that must not migrate anything: it declares what the database
 * already has. These checks hold that line — no SQL execution, an explicit confirmation flag, and a
 * writer that cannot duplicate a name the ledger already carries.
 */
async function source(): Promise<string> {
  return (await readFile(resolve(__dirname, 'baseline.ts'), 'utf8')).replace(/\s+/g, ' ');
}

describe('migration baseline', () => {
  it('marks only the names the ledger is missing', async () => {
    const seen = new Set(['001_initial', '002_auth_rbac']);
    const missing = await planBaseline(['001_initial', '002_auth_rbac', '003_commerce_configuration'], async (name) => seen.has(name));
    assert.deepEqual(missing, ['003_commerce_configuration']);
  });

  it('keeps a ledger that is already current untouched', async () => {
    const missing = await planBaseline(['001_initial'], async () => true);
    assert.deepEqual(missing, []);
  });

  it('refuses to run without a database and without confirmation', async () => {
    const text = await source();
    assert.match(text, /if \(!process\.env\.DATABASE_URL\) throw new Error\('DATABASE_URL must be set'\)/);
    assert.match(text, /process\.env\.BASELINE_CONFIRM === 'yes'/);
    assert.match(text, /if \(!confirmed\) \{[^}]*process\.exitCode = 1/s, 'a dry run must fail the command so nobody mistakes it for a baseline');
  });

  it('records names instead of executing the migration files', async () => {
    const text = await source();
    assert.doesNotMatch(text, /client\.query\(contents\)|client\.query\(await readFile/, 'the file body must never reach the database');
    assert.match(text, /await readFile\(resolve\(directory, `\$\{name\}\.sql`\), 'utf8'\);/, 'the file is only read to prove it is there');
    assert.equal(RECORD_SQL, `INSERT INTO ${LEDGER}(name) VALUES ($1) ON CONFLICT (name) DO NOTHING`);
  });

  it('creates the ledger the same way migrate.ts does', async () => {
    const migrate = (await readFile(resolve(__dirname, 'migrate.ts'), 'utf8')).replace(/\s+/g, ' ');
    assert.equal(LEDGER_DDL, `CREATE TABLE IF NOT EXISTS ${LEDGER} (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    assert.match(migrate, new RegExp(`CREATE TABLE IF NOT EXISTS ${LEDGER} \\(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now\\(\\)\\)`));
  });

  it('is a script the operator runs, never a step of the build', async () => {
    const pkg = JSON.parse(await readFile(resolve(__dirname, '../../package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts['db:baseline'], 'tsx src/database/baseline.ts');
    const buildScript = (await readFile(resolve(__dirname, '../../../scripts/vercel-build.cjs'), 'utf8')).replace(/\s+/g, ' ');
    assert.doesNotMatch(buildScript, /db:baseline|BASELINE_CONFIRM/, 'a build that baselines on its own can mark an unapplied migration as applied');
    const readme = (await readFile(resolve(__dirname, '../../../README.md'), 'utf8'));
    assert.match(readme, /db:baseline/, 'the README has to say when to run it');
  });
});

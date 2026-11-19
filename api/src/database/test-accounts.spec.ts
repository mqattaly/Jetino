import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REGION_SLUG, TEST_ACCOUNTS, accountsReport, buildStatements } from './seed-test-accounts';

/**
 * These rows are the only way the deployed environment can be walked without an SMS provider, so the
 * properties that matter are the ones a demo account must never lose: one login per surface, no
 * credentials attached, and a second run that changes nothing.
 */
const ROOT = resolve(__dirname, '..', '..', '..');

describe('test account seed', () => {
  it('opens exactly one surface per role the panels check', () => {
    const granted = new Set(TEST_ACCOUNTS.flatMap((account) => account.roles));
    for (const role of ['CUSTOMER', 'BUSINESS_OWNER', 'DRIVER', 'OPERATIONS_MANAGER', 'SUPER_ADMIN', 'SUPPORT']) {
      assert.ok(granted.has(role), `${role} needs an account so its panel can be tested`);
    }
    assert.equal(new Set(TEST_ACCOUNTS.map((account) => account.phone)).size, TEST_ACCOUNTS.length);
  });

  it('uses only roles the database knows', () => {
    const migration = readFileSync(resolve(ROOT, 'api/src/database/migrations/002_auth_rbac.sql'), 'utf8');
    const enumBody = /CREATE TYPE app_role AS ENUM \(([^)]*)\)/.exec(migration)?.[1] ?? '';
    const known = new Set([...enumBody.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]));
    for (const role of TEST_ACCOUNTS.flatMap((account) => account.roles)) assert.ok(known.has(role), `${role} is not in app_role`);
  });

  it('carries no credentials of any kind', () => {
    for (const account of TEST_ACCOUNTS) {
      assert.match(account.phone, /^\+989\d{9}$/, 'phones have to satisfy the same normalization the API applies');
      assert.equal(Object.keys(account).join(','), 'id,phone,displayName,roles,surface');
    }
    assert.doesNotMatch(accountsReport(), /password|secret|token/i, 'the report lists logins, not credentials');
  });

  it('is idempotent and reuses the region row instead of inventing one', () => {
    const statements = buildStatements();
    assert.ok(statements.length >= TEST_ACCOUNTS.length * 2);
    for (const sql of statements) {
      assert.match(sql, /ON CONFLICT/, 'a second run must not duplicate or fail');
      assert.doesNotMatch(sql, /gen_random_uuid\(\)/, 'ids are fixed so rows line up across databases');
    }
    for (const sql of statements.filter((entry) => /region_id/.test(entry))) {
      assert.match(sql, new RegExp(`\\(SELECT id FROM regions WHERE slug='${REGION_SLUG}'\\)`));
    }
  });

  it('hangs the shared data off the accounts that own it', () => {
    const statements = buildStatements().join(' ');
    const owner = TEST_ACCOUNTS.find((account) => account.roles.includes('BUSINESS_OWNER'))!;
    const driver = TEST_ACCOUNTS.find((account) => account.roles.includes('DRIVER'))!;
    const customer = TEST_ACCOUNTS.find((account) => account.roles.includes('CUSTOMER'))!;
    const business = statements.split(';').find((sql) => /INSERT INTO businesses/.test(sql)) ?? '';
    assert.match(business, new RegExp(owner.id), 'the business panel only lists businesses of the signed-in owner');
    assert.match(statements, new RegExp(`INSERT INTO drivers[^]*?${driver.id}`));
    assert.match(statements, new RegExp(`INSERT INTO addresses[^]*?${customer.id}`));
    assert.match(statements, /status','ACTIVE'|status='ACTIVE'/, 'the driver and the business have to be usable at once');
  });

  it('only writes columns the live schema actually has', () => {
    // `updated_at` is the trap: users/drivers/addresses have it, businesses/menu_categories/products do
    // not, and one stray mention makes the whole seed abort halfway through the run.
    for (const statement of buildStatements()) {
      const table = /^INSERT INTO ([a-z_]+)/.exec(statement)?.[1];
      if (!table || !/ON CONFLICT/.test(statement)) continue;
      if (['users', 'drivers', 'addresses'].includes(table)) continue;
      assert.ok(!/updated_at=/.test(statement), `${table} has no updated_at column: ${statement}`);
    }
  });

  it('is reachable as a script and documents the flag it depends on', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'api/package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts['db:seed:accounts'], 'tsx src/database/seed-test-accounts.ts');
    const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
    assert.match(readme, /JETINO_ALLOW_TEST_OTP/, 'the switch that lets these accounts sign in must not be folklore');
  });
});

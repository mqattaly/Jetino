import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { AuthService } from './auth.service';
import { BusinessesService } from '../businesses/businesses.service';
import { AdminAuditService } from '../admin/admin-audit.service';
import { buildStatements } from '../database/seed-test-accounts';

/**
 * Login is the one flow the unit specs cannot prove: `verifyOtp` writes an audit row whose actor_id is
 * a uuid and whose entity_id is a varchar, and PostgreSQL rejects a single placeholder bound to both.
 * The same SQL also carries the throttle, the FOR UPDATE row lock and the digest comparison, so this
 * runs the seeded test accounts against a real instance — the accounts the deployed environment is
 * walked with. Skipped unless DATABASE_URL_TEST points at a scratch database, as every other flow test
 * here does; CI always sets one.
 */
const databaseUrl = process.env.DATABASE_URL_TEST ?? '';
const suite = databaseUrl ? describe : describe.skip;
const migrationDirectory = resolve(process.cwd(), 'src/database/migrations');

const phoneOf = (lastTwo: string) => ({ local: `091200000${lastTwo}`, e164: `+9891200000${lastTwo}` });
const CUSTOMER = phoneOf('21');
const OWNER = phoneOf('22');
const MANAGER = phoneOf('24');
const SUPPORT = phoneOf('26');

suite('signed-in test accounts against PostgreSQL', () => {
  const schema = `jetino_it_${Date.now().toString(36)}`;
  let pool: Pool;
  let auth: AuthService;
  let previousEnv: Record<string, string | undefined>;

  before(async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`SET search_path TO ${schema}`);
      for (const file of (await readdir(migrationDirectory)).filter((name) => name.endsWith('.sql')).sort()) {
        await admin.query(await readFile(resolve(migrationDirectory, file), 'utf8'));
      }
      for (const statement of buildStatements()) await admin.query(statement);
    } finally { await admin.end(); }

    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    previousEnv = {
      JWT_SECRET: process.env.JWT_SECRET,
      OTP_HMAC_SECRET: process.env.OTP_HMAC_SECRET,
      JETINO_ALLOW_TEST_OTP: process.env.JETINO_ALLOW_TEST_OTP,
      KAVENEGAR_API_KEY: process.env.KAVENEGAR_API_KEY,
      KAVENEGAR_OTP_TEMPLATE: process.env.KAVENEGAR_OTP_TEMPLATE,
    };
    process.env.JWT_SECRET = `integration-jwt-secret-${randomUUID()}`;
    process.env.OTP_HMAC_SECRET = `integration-otp-secret-${randomUUID()}`;
    process.env.KAVENEGAR_API_KEY = '';
    process.env.KAVENEGAR_OTP_TEMPLATE = '';
    auth = new AuthService(pool);
  });

  after(async () => {
    await pool?.end();
    for (const [key, value] of Object.entries(previousEnv ?? {})) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
  });

  const digest = (phone: string, code: string) =>
    createHmac('sha256', process.env.OTP_HMAC_SECRET ?? '').update(`${phone}:${code}`).digest('hex');

  /** Mirrors what a provider-less environment does: the code is only ever read back from the response. */
  const signIn = async (localPhone: string) => {
    const requested = await auth.requestOtp(localPhone);
    const code = (requested as { testCode?: string }).testCode;
    assert.ok(code, 'the echoed code is what a tester types, so it has to be in the response');
    return auth.verifyOtp(localPhone, code);
  };

  it('signs the seeded numbers in and keeps every role in the token', async () => {
    process.env.JETINO_ALLOW_TEST_OTP = 'yes';
    const session = await signIn(OWNER.local);
    assert.equal(session.user.phone, OWNER.e164);
    assert.ok(session.user.roles.includes('BUSINESS_OWNER'), 'the business panel is reachable with this token');
    assert.ok(session.accessToken.split('.').length === 3);
    const businesses = new BusinessesService(pool);
    const mine = await businesses.mine({ sub: session.user.id });
    assert.equal(mine.length, 1, 'the owner sees exactly the seeded shop');
    assert.equal(mine[0].name, 'کبابی نمونه');
    assert.equal(mine[0].status, 'ACTIVE');
    const menu = await businesses.mineMenu({ sub: session.user.id }, mine[0].id);
    assert.equal(menu.categories.length, 1);
    assert.equal(menu.categories[0].products.length, 2, 'the seeded menu has something to edit');
  });

  it('records the login in the audit log instead of failing the request', async () => {
    // the row that used to break: actor_id is uuid, entity_id is varchar
    const audit = new AdminAuditService(pool);
    const session = await signIn(CUSTOMER.local);
    const list = await audit.list({ sub: session.user.id }, { limit: 50 });
    const row = list.items.find((item) => item.action === 'AUTH_OTP_LOGIN');
    assert.ok(row, 'a login without a password has to leave a trace');
    assert.equal(row.entityId, session.user.id);
  });

  it('still consumes the echoed code once and expires the challenge', async () => {
    process.env.JETINO_ALLOW_TEST_OTP = 'yes';
    const requested = await auth.requestOtp(MANAGER.local) as { testCode: string };
    await auth.verifyOtp(MANAGER.local, requested.testCode);
    await assert.rejects(() => auth.verifyOtp(MANAGER.local, requested.testCode), /نامعتبر|منقضی/, 'a code is spent the moment it works');

    const next = await auth.requestOtp(MANAGER.local) as { testCode: string };
    const expired = await pool.query(
      `UPDATE otp_challenges SET expires_at = now() - interval '1 minute' WHERE phone=$1 AND consumed_at IS NULL`,
      [MANAGER.e164],
    );
    assert.ok(expired.rowCount, 'the fresh challenge is the one being aged out');
    await assert.rejects(() => auth.verifyOtp(MANAGER.local, next.testCode), /نامعتبر|منقضی/, 'five minutes, not forever');
  });

  it('keeps the five-minute throttle without a provider', async () => {
    process.env.JETINO_ALLOW_TEST_OTP = 'yes';
    for (let i = 0; i < 3; i += 1) await auth.requestOtp(SUPPORT.local);
    await assert.rejects(() => auth.requestOtp(SUPPORT.local), (error: { getStatus?: () => number }) => {
      assert.equal(error.getStatus?.(), 429, 'the third request inside the window must not send a fourth code');
      return true;
    });
  });

  it('refuses to echo anything once the switch is closed', async () => {
    delete process.env.JETINO_ALLOW_TEST_OTP;
    await assert.rejects(() => auth.requestOtp(phoneOf('23').local), (error: { getStatus?: () => number }) => {
      assert.equal(error.getStatus?.(), 503, 'without a provider and without the flag there is no way in');
      return true;
    });
  });

  it('hashes the code it sends, so a leaked table is not a list of codes', async () => {
    process.env.JETINO_ALLOW_TEST_OTP = 'yes';
    const superAdmin = phoneOf('25');
    const requested = await auth.requestOtp(superAdmin.local) as { testCode: string };
    const row = await pool.query(
      `SELECT code_digest FROM otp_challenges WHERE phone=$1 ORDER BY created_at DESC LIMIT 1`,
      [superAdmin.e164],
    );
    assert.equal(row.rows[0].code_digest, digest(superAdmin.e164, requested.testCode));
    assert.ok(!String(row.rows[0].code_digest).includes(requested.testCode), 'the digest must not contain the code');
  });
});

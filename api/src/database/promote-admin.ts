import 'dotenv/config';
import { Client } from 'pg';

async function promote() {
  const input = process.env.ADMIN_PHONE?.replace(/[\s()-]/g, '');
  if (!process.env.DATABASE_URL || !input) throw new Error('Set DATABASE_URL and ADMIN_PHONE to an existing verified user phone.');
  const phone = /^09\d{9}$/.test(input) ? `+98${input.slice(1)}` : input;
  if (!/^\+989\d{9}$/.test(phone)) throw new Error('ADMIN_PHONE must be a valid Iranian mobile number.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query('SELECT id FROM users WHERE phone=$1 FOR UPDATE', [phone]);
    if (!user.rowCount) throw new Error('No user found. The user must complete OTP login before promotion.');
    await client.query(`INSERT INTO user_roles(user_id,role) VALUES($1,'SUPER_ADMIN') ON CONFLICT DO NOTHING`, [user.rows[0].id]);
    // the audit row names the same user twice, but actor_id is uuid and entity_id is varchar: one
    // placeholder for both makes PostgreSQL refuse the statement, so the value is bound twice
    await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id) VALUES($1,'SUPER_ADMIN_BOOTSTRAPPED','USER',$2)`, [user.rows[0].id, user.rows[0].id]);
    await client.query('COMMIT');
    console.log('SUPER_ADMIN role granted. Ask the user to sign in again so the new role is included in the JWT.');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* no active transaction */ }
    throw error;
  } finally { await client.end(); }
}
void promote().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

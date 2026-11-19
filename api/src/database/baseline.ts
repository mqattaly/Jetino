import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';

/**
 * Records migrations that a database already has but that our ledger never saw — the case when the
 * schema arrived by `supabase db push`, by a restored backup, or by hand-run SQL. Those paths leave
 * `schema_migrations` empty, so the next `db:migrate` replays 001 and dies on the first constraint
 * that already exists; on Vercel that failure is the build failing.
 *
 * The script never touches a schema object, and it cannot prove the SQL inside a file was applied —
 * so the default run is a dry read of the plan, and rows are written only with `BASELINE_CONFIRM=yes`.
 */
export const LEDGER = 'schema_migrations';
export const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${LEDGER} (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
export const RECORD_SQL = `INSERT INTO ${LEDGER}(name) VALUES ($1) ON CONFLICT (name) DO NOTHING`;

export function migrationDirectory(cwd: string = process.cwd()): string {
  return resolve(cwd, 'src/database/migrations');
}

/** Every `.sql` file on disk, in apply order, paired with whether the ledger already names it. */
export async function planBaseline(names: string[], recorded: (name: string) => Promise<boolean>): Promise<string[]> {
  const missing: string[] = [];
  for (const name of names) if (!(await recorded(name))) missing.push(name);
  return missing;
}

async function baseline() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
  const confirmed = process.env.BASELINE_CONFIRM === 'yes';
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(LEDGER_DDL);
    const directory = migrationDirectory();
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    const seen = await client.query(`SELECT name FROM ${LEDGER}`);
    const recorded = new Set(seen.rows.map((row: { name: string }) => row.name));
    const missing = await planBaseline(files.map((file) => file.replace(/\.sql$/, '')), async (name) => recorded.has(name));
    // read each file so a corrupt or empty migration is reported here rather than at deploy time
    for (const name of missing) await readFile(resolve(directory, `${name}.sql`), 'utf8');
    console.log(`${LEDGER} holds ${recorded.size} of ${files.length} migrations`);
    console.log(`to baseline: ${missing.join(', ') || '— nothing, the ledger is current —'}`);
    if (!missing.length) return;
    if (!confirmed) {
      console.error('dry run only: re-run with BASELINE_CONFIRM=yes to record these names (this asserts the SQL was already applied).');
      process.exitCode = 1;
      return;
    }
    for (const name of missing) await client.query(RECORD_SQL, [name]);
    console.log(`recorded ${missing.length} migration names without executing them`);
  } finally {
    await client.end();
  }
}

if (require.main === module) void baseline().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

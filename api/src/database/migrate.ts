import 'dotenv/config';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../config/database-url';

/**
 * The SQL files live next to the TypeScript source, but a container image ships the compiled
 * `dist/` and only copies the migrations, so the working directory is not enough on its own.
 */
function migrationDirectory(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    resolve(process.cwd(), 'src/database/migrations'),
    resolve(__dirname, '..', '..', 'src', 'database', 'migrations'),
    resolve(__dirname, '..', '..', 'migrations'),
  ].filter((dir): dir is string => Boolean(dir));
  const found = candidates.find((dir) => existsSync(dir));
  if (!found) throw new Error(`پوشهٔ مایگریشن‌ها پیدا نشد. مسیرها: ${candidates.join(', ')}`);
  return found;
}

async function migrate() {
  const client = new Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = migrationDirectory();
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      const name = file.replace(/\.sql$/, '');
      const exists = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (exists.rowCount) { console.log(`Migration ${name} already applied`); continue; }
      await client.query('BEGIN');
      try {
        await client.query(await readFile(resolve(directory, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        console.log(`Applied migration ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}
void migrate().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';

async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = resolve(process.cwd(), 'src/database/migrations');
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

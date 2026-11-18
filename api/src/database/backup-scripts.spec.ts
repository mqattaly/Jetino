import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * The backup scripts are the only defence against "we have dumps but no idea if
 * they work", and their failures are silent: a missing checksum check, a dump that
 * is never pruned, or a drill that quietly compares nothing. They cannot be
 * exercised against a live server here, so the safety-critical parts of their
 * text are pinned instead, and CI runs the real drill end to end.
 */
const repoRoot = resolve(process.cwd(), '..');
const read = (relative: string) => readFile(resolve(process.cwd(), relative), 'utf8');

describe('database backup scripts', () => {
  it('exist as executable npm scripts rather than prose in a runbook', async () => {
    const manifest = JSON.parse(await read('package.json')) as { scripts: Record<string, string> };
    assert.equal(manifest.scripts['db:backup'], 'bash scripts/backup.sh');
    assert.equal(manifest.scripts['db:restore-drill'], 'bash scripts/restore-drill.sh');
    for (const file of ['scripts/backup.sh', 'scripts/restore-drill.sh']) {
      assert.ok(existsSync(resolve(process.cwd(), file)), `${file} is missing`);
    }
  });

  it('fail fast instead of half-running', async () => {
    for (const file of ['scripts/backup.sh', 'scripts/restore-drill.sh']) {
      const script = await read(file);
      assert.match(script, /^set -euo pipefail$/m, `${file} must stop on the first error`);
      assert.doesNotMatch(script, /jetino_local_only|jetino_ci_only/, 'no environment password may be baked into a script');
    }
  });

  it('hand libpq a connection string it can actually parse', async () => {
    const backup = await read('scripts/backup.sh');
    const drill = await read('scripts/restore-drill.sh');
    // ?schema=public comes from the app's own config and makes psql/pg_dump fail outright
    assert.ok(backup.includes('${DATABASE_URL%%\\?*}'), 'the backup must strip query parameters before calling the tools');
    assert.ok(drill.includes('${DRILL_DATABASE_URL%%\\?*}'), 'the drill must strip them too');
    assert.doesNotMatch(backup, /psql "\$DATABASE_URL"/, 'the raw URL must not reach psql');
    assert.doesNotMatch(drill, /psql "\$DRILL_DATABASE_URL"/, 'the raw URL must not reach psql');
  });

  it('write a dump, a checksum and the row counts a restore is judged against', async () => {
    const backup = await read('scripts/backup.sh');
    assert.match(backup, /DATABASE_URL:\?DATABASE_URL must be set/, 'a backup with an unset connection string must refuse to run');
    assert.match(backup, /--format=custom/);
    assert.match(backup, /sha256sum .*\.sha256/);
    assert.match(backup, /\.rows/);
    assert.match(backup, /count\(\*\) FROM/, 'the sidecar must record real row counts');
    assert.match(backup, /BACKUP_KEEP/, 'retention has to be a knob, not an accident');
    assert.match(backup, /ls -1t .* \| tail -n \+"\$\(\(keep \+ 1\)\)"/, 'only the newest dumps may survive');
  });

  it('refuse to trust an unverified dump and to compare nothing', async () => {
    const drill = await read('scripts/restore-drill.sh');
    assert.match(drill, /DRILL_DATABASE_URL:\?/, 'the scratch connection is mandatory');
    assert.match(drill, /sha256sum -c/, 'the checksum must be verified before restoring');
    assert.match(drill, /missing row-count sidecar/, 'a dump without counts is not a proven backup');
    assert.match(drill, /pg_restore/);
    assert.match(drill, /FROM schema_migrations/, 'the migration ledger has to travel with the dump');
    assert.match(drill, /did not match the backup/, 'a mismatch must be reported as a failure');
    assert.match(drill, /failures \+ 1/, 'every table is checked, not just the first');
  });

  it('only ever drop the throwaway database it created itself', async () => {
    const drill = await read('scripts/restore-drill.sh');
    assert.match(drill, /DRILL_DB_PREFIX:-jetino_drill_/);
    assert.match(drill, /trap cleanup EXIT/, 'cleanup must run on a failed drill too');
    assert.match(drill, /\[ "\$created" = "1" \]/, 'the drill may only remove a database it created');
    assert.match(drill, /KEEP_DRILL_DB/, 'a failed drill has to leave the copy for inspection');
    assert.doesNotMatch(drill, /DROP DATABASE[^;]*jetino\b/, 'the real database must never be a drop target');
  });

  it('is wired into CI so every push proves the restore path', async () => {
    const workflow = await readFile(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    const job = workflow.slice(workflow.indexOf('backup-drill:'));
    assert.ok(job.length > 0, 'the backup-drill job is missing');
    assert.match(job, /npm run db:backup/);
    assert.match(job, /npm run db:restore-drill/);
    assert.match(job, /npm run db:seed:demo/, 'a drill over an empty schema proves nothing');
    assert.match(job, /needs: verify/, 'the drill runs once the tests have established a working schema');
  });
});

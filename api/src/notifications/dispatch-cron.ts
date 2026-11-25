import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { Pool } from 'pg';
import { AppModule } from '../app.module';
import { PG_POOL } from '../database/database.module';
import { NotificationDeliveryService } from './notification-delivery.service';
import { DISPATCH_BATCH_LIMIT } from './notification-delivery.util';

/**
 * Scheduler entry point for the notification queue — what a cron service actually runs.
 *
 * Why not just curl the HTTP route? A scheduler that runs the same image can talk to the
 * database directly: no public URL, no `CRON_SECRET` copied into a second place, and a failure
 * shows up as a non-zero exit code instead of an unnoticed HTTP 403. The HTTP route stays for
 * schedulers that can only make a request (Vercel cron, GitHub Actions).
 *
 * Overlap is safe: `dispatch` claims each row with a lease (`DISPATCH_LEASE_SECONDS`), so a slow
 * run and the next tick cannot send the same push twice.
 */

/** `CRON_LIMIT` (default and ceiling: `DISPATCH_BATCH_LIMIT`) keeps one tick bounded. */
export function readCronLimit(raw: string | number | undefined): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DISPATCH_BATCH_LIMIT;
  return Math.min(parsed, DISPATCH_BATCH_LIMIT);
}

async function main(): Promise<void> {
  const limit = readCronLimit(process.env.CRON_LIMIT);
  const startedAt = new Date().toISOString();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const pool = app.get<Pool>(PG_POOL);

  let exitCode = 0;
  try {
    const summary = await app.get(NotificationDeliveryService).dispatch(limit);
    // one JSON line per tick: a log viewer on the platform can be filtered on `dispatch`
    console.log(JSON.stringify({ event: 'dispatch', startedAt, limit, ...summary }));
    // individual pushes that failed are retried by the next tick, so they do not fail the job;
    // an exception (database down, bad configuration) does, and that is what exitCode 1 reports
  } catch (error) {
    console.error(`dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  } finally {
    await app.close().catch(() => undefined);
    // the pool is not tied to the Nest lifecycle; without this the process waits on idle clients
    await pool.end().catch(() => undefined);
  }

  process.exit(exitCode);
}

if (require.main === module) {
  void main();
}

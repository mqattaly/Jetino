import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterSeconds: number };

/**
 * Function instances do not share memory, so a per-process counter would let a
 * caller spend the whole budget on every warm lambda. The counter therefore lives
 * in PostgreSQL, keyed by a fixed window, and is a single upsert per call.
 *
 * The limits here are abuse brakes, not the primary security control: every path
 * they guard (SOS, location sharing, order creation, menu writes) is already
 * authorised and validated. A database hiccup must not take those actions down,
 * so `consume` fails open and lets the request through.
 */
@Injectable()
export class RateLimitService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowSeconds) || windowSeconds < 1) {
      throw new Error('rate limit configuration is invalid');
    }
    try {
      // Housekeeping rides along on roughly one call in fifty instead of a cron job.
      if (Math.random() < 0.02) {
        await this.pool.query(`DELETE FROM rate_limit_counters WHERE window_start < now() - interval '2 hours'`);
      }
      const result = await this.pool.query(
        `INSERT INTO rate_limit_counters(bucket,window_start,hits)
         VALUES($1,to_timestamp(floor(extract(epoch from now())/$2)*$2),1)
         ON CONFLICT (bucket,window_start) DO UPDATE SET hits=rate_limit_counters.hits+1
         RETURNING hits`,
        [key.slice(0, 200), windowSeconds],
      );
      const hits = Number(result.rows[0]?.hits ?? 1);
      return { allowed: hits <= limit, remaining: Math.max(0, limit - hits), retryAfterSeconds: windowSeconds };
    } catch {
      return { allowed: true, remaining: limit, retryAfterSeconds: windowSeconds };
    }
  }

  /** Throws the Persian 429 every caller shows as-is. */
  async enforce(key: string, limit: number, windowSeconds: number, message: string): Promise<void> {
    const result = await this.consume(key, limit, windowSeconds);
    if (!result.allowed) {
      throw new HttpException(`${message} (${result.retryAfterSeconds} ثانیه دیگر دوباره تلاش کنید.)`, HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}

/**
 * Resolve the PostgreSQL connection string from the environment.
 *
 * `DATABASE_URL` stays the first choice (local development, Vercel, Supabase). Iranian
 * PaaS panels such as Chabakan hand the database over as separate fields
 * (host/port/user/password/database), often under their own names, so an app that only
 * reads `DATABASE_URL` cannot boot there without a manual assembly. This module keeps
 * that assembly in one place instead of repeating it in every script.
 *
 * Deliberately *not* reading bare `HOST`/`PORT`: `PORT` is the HTTP port on every one of
 * these platforms, and a wrong guess would point the app at itself.
 */

const TRUEISH = new Set(['1', 'true', 'yes', 'on', 'require', 'required']);

function first(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * The sslmode to append, or `undefined` when the operator asked for no TLS.
 *
 * `DB_SSL=1` means "require", but the value may also name a mode directly
 * (`no-verify`, `prefer`, `disable`, …) because `require` is verify-full in `pg` and some
 * managed databases — Supabase's pooler, for one — only answer with `no-verify`.
 */
const SSL_MODES = new Set(['require', 'no-verify', 'prefer', 'disable', 'allow', 'verify-ca', 'verify-full']);

function sslMode(): string | undefined {
  const flag = first('DB_SSL', 'DATABASE_SSL', 'PGSSLMODE');
  if (!flag) return undefined;
  const value = flag.toLowerCase();
  if (SSL_MODES.has(value)) return value;
  return TRUEISH.has(value) ? 'require' : undefined;
}

function withSsl(url: string): string {
  const mode = sslMode();
  if (!mode || /[?&]sslmode=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}sslmode=${mode}`;
}

/**
 * The connection string, or `undefined` when nothing is configured (pg then falls back
 * to its own `PG*` defaults, which is what local development relies on).
 */
export function databaseUrl(): string | undefined {
  const explicit = first('DATABASE_URL');
  if (explicit) return withSsl(explicit);

  const host = first('DB_HOST', 'PGHOST');
  const database = first('DB_NAME', 'DB_DATABASE', 'PGDATABASE');
  if (!host || !database) return undefined;

  const user = first('DB_USER', 'DB_USERNAME', 'PGUSER');
  const password = first('DB_PASSWORD', 'DB_PASS', 'PGPASSWORD');
  const port = first('DB_PORT', 'PGPORT') ?? '5432';

  const credentials = user ? `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ''}@` : '';
  return withSsl(`postgresql://${credentials}${host}:${port}/${database}`);
}

/** Same as {@link databaseUrl}, but fails loudly for scripts that cannot run without a database. */
export function requireDatabaseUrl(): string {
  const url = databaseUrl();
  if (!url) {
    throw new Error(
      'اتصال دیتابیس تنظیم نشده است: DATABASE_URL را بدهید، یا DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME را.',
    );
  }
  return url;
}

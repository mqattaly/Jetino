import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { databaseUrl, requireDatabaseUrl } from './database-url';

const KEYS = [
  'DATABASE_URL',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_USERNAME',
  'DB_PASSWORD',
  'DB_PASS',
  'DB_NAME',
  'DB_DATABASE',
  'DB_SSL',
  'DATABASE_SSL',
  'PGSSLMODE',
  'PGHOST',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'PGDATABASE',
  'PORT',
];

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const saved = new Map(KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('databaseUrl', () => {
  afterEach(() => {
    // every case manages its own environment; nothing to do here beyond documenting the contract
  });

  it('prefers an explicit DATABASE_URL', () => {
    withEnv({ DATABASE_URL: 'postgresql://a:b@db:5432/one', DB_HOST: 'other' }, () => {
      assert.equal(databaseUrl(), 'postgresql://a:b@db:5432/one');
    });
  });

  it('assembles the split DB_* form the PaaS panel exposes', () => {
    withEnv(
      { DB_HOST: 'db.internal', DB_PORT: '6432', DB_USER: 'jetino', DB_PASSWORD: 'p@ss', DB_NAME: 'jetino' },
      () => {
        assert.equal(databaseUrl(), 'postgresql://jetino:p%40ss@db.internal:6432/jetino');
      },
    );
  });

  it('defaults the port to 5432 and tolerates a user without a password', () => {
    withEnv({ DB_HOST: 'db', DB_USER: 'jetino', DB_NAME: 'jetino' }, () => {
      assert.equal(databaseUrl(), 'postgresql://jetino@db:5432/jetino');
    });
  });

  it('never reads PORT, because that is the HTTP port', () => {
    withEnv({ PORT: '3000', DB_HOST: 'db', DB_USER: 'u', DB_NAME: 'd' }, () => {
      assert.equal(databaseUrl(), 'postgresql://u@db:5432/d');
    });
  });

  it('returns undefined when nothing is configured', () => {
    withEnv({}, () => {
      assert.equal(databaseUrl(), undefined);
    });
  });

  it('needs both host and database name before it invents a URL', () => {
    withEnv({ DB_HOST: 'db' }, () => {
      assert.equal(databaseUrl(), undefined);
    });
  });

  it('appends sslmode when TLS is requested and the URL does not say so', () => {
    withEnv({ DATABASE_URL: 'postgresql://a:b@db:5432/one', DB_SSL: '1' }, () => {
      assert.equal(databaseUrl(), 'postgresql://a:b@db:5432/one?sslmode=require');
    });
  });

  it('keeps an sslmode that the URL already carries', () => {
    withEnv({ DATABASE_URL: 'postgresql://a:b@db:5432/one?sslmode=prefer', DB_SSL: 'require' }, () => {
      assert.equal(databaseUrl(), 'postgresql://a:b@db:5432/one?sslmode=prefer');
    });
  });

  it('accepts an explicit sslmode instead of a boolean, because require means verify-full', () => {
    withEnv({ DATABASE_URL: 'postgresql://a:b@db:5432/one', DB_SSL: 'no-verify' }, () => {
      assert.equal(databaseUrl(), 'postgresql://a:b@db:5432/one?sslmode=no-verify');
    });
  });

  it('ignores a falsy TLS flag', () => {
    withEnv({ DATABASE_URL: 'postgresql://a:b@db:5432/one', DB_SSL: '0' }, () => {
      assert.equal(databaseUrl(), 'postgresql://a:b@db:5432/one');
    });
  });

  it('requireDatabaseUrl explains what to set instead of throwing a bare error', () => {
    withEnv({}, () => {
      assert.throws(() => requireDatabaseUrl(), /DATABASE_URL/);
      assert.throws(() => requireDatabaseUrl(), /DB_HOST/);
    });
  });
});

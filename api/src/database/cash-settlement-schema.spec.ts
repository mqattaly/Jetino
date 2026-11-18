import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// specs run through `npm test` from the api package, which resolves migrations relative to that folder
const directory = resolve(process.cwd(), 'src/database/migrations');
const read = async (file: string) => await readFile(resolve(directory, file), 'utf8');

describe('feedback and support schema', () => {
  it('keeps one editable rating per delivered order, tied to both sides', async () => {
    const sql = await read('013_feedback_support.sql');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS order_feedback/);
    assert.match(sql, /order_id uuid NOT NULL UNIQUE REFERENCES orders\(id\) ON DELETE CASCADE/, 'a second row for the same order must be impossible in the database, not just in code');
    assert.match(sql, /business_rating smallint NOT NULL CHECK \(business_rating BETWEEN 1 AND 5\)/);
    assert.match(sql, /driver_rating smallint NULL CHECK \(driver_rating IS NULL OR driver_rating BETWEEN 1 AND 5\)/);
    assert.match(sql, /comment varchar\(500\)/, 'feedback has a bound, so it cannot become an essay');
    assert.match(sql, /driver_id uuid NULL REFERENCES drivers\(id\) ON DELETE SET NULL/, 'deleting a driver profile must not delete the customer review');
  });

  it('gives support a thread, an event trail and one live ticket per order', async () => {
    const sql = await read('013_feedback_support.sql');
    assert.match(sql, /status varchar\(20\) NOT NULL DEFAULT 'OPEN' CHECK \(status IN \('OPEN','IN_REVIEW','RESOLVED','CLOSED'\)\)/);
    assert.ok(sql.includes('support_messages'), 'the thread has to be a table, not a jsonb blob');
    assert.ok(sql.includes('support_ticket_events'), 'who moved the status and when belongs in the schema');
    assert.match(sql, /ON DELETE CASCADE/);
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_open_per_order_person\s+ON support_tickets\(order_id, opened_by\) WHERE status IN \('OPEN','IN_REVIEW'\)/s);
    assert.match(sql, /ALTER TABLE support_ticket_events ADD COLUMN IF NOT EXISTS id uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/, 'the file may already have been applied, so the extra column has to be additive');
  });
});

describe('business location schema', () => {
  it('stores the shop pin as a validated coordinate pair', async () => {
    const sql = await read('012_business_location.sql');
    assert.match(sql, /ALTER TABLE businesses ADD COLUMN IF NOT EXISTS latitude numeric\(9,6\), ADD COLUMN IF NOT EXISTS longitude numeric\(9,6\)/);
    assert.match(sql, /ADD CONSTRAINT businesses_location_pair_check/);
    assert.match(sql, /\(latitude IS NULL AND longitude IS NULL\) OR \(latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180\)/);
  });
});

describe('cash settlement schema', () => {
  it('creates the settlement table with the columns the admin report writes', async () => {
    const sql = await read('011_cash_settlements.sql');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS cash_settlements/);
    for (const column of ['driver_id uuid NOT NULL REFERENCES drivers(id)', 'amount_rial bigint NOT NULL CHECK(amount_rial > 0)', 'order_count integer NOT NULL CHECK(order_count > 0)', 'settled_by uuid NOT NULL REFERENCES users(id)', 'settled_at timestamptz NOT NULL DEFAULT now()', 'note text']) {
      assert.ok(sql.includes(column), `missing column definition: ${column}`);
    }
    assert.match(sql, /CREATE INDEX IF NOT EXISTS cash_settlements_driver_idx ON cash_settlements\(driver_id,settled_at DESC\)/);
  });

  it('links collections to settlements so open balances stay queryable', async () => {
    const sql = await read('011_cash_settlements.sql');
    assert.match(sql, /ALTER TABLE cash_collections ADD COLUMN IF NOT EXISTS settlement_id uuid REFERENCES cash_settlements\(id\) ON DELETE SET NULL/);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS cash_collections_open_idx ON cash_collections\(collected_by\) WHERE settlement_id IS NULL/);
    const collections = await read('007_delivery_cash_collection.sql');
    assert.match(collections, /CREATE TABLE IF NOT EXISTS cash_collections/);
    assert.match(collections, /order_id uuid NOT NULL UNIQUE REFERENCES orders\(id\)/);
    assert.match(collections, /collected_by uuid NOT NULL REFERENCES users\(id\)/);
  });

  it('ships migrations as gap-free, zero-padded files because the runner applies them in sorted order', async () => {
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
    assert.ok(files.length > 0);
    files.forEach((file, index) => {
      const [prefix, ...rest] = file.replace(/\.sql$/, '').split('_');
      assert.match(prefix, /^\d{3}$/, `migration ${file} must start with a three digit prefix`);
      assert.ok(rest.length > 0, `migration ${file} must have a name after the prefix`);
      assert.equal(Number(prefix), index + 1, `migration numbering must be gap-free, got ${prefix} at position ${index + 1}`);
    });
    const position = (name: string) => files.indexOf(name);
    assert.ok(position('007_delivery_cash_collection.sql') < position('011_cash_settlements.sql'), 'settlements are recorded against collected cash');
    assert.ok(position('011_cash_settlements.sql') < position('012_business_location.sql'), 'new schema is applied after the settlement tables');
    assert.ok(position('012_business_location.sql') < position('013_feedback_support.sql'), 'feedback needs the shops and orders created before it');
  });
});

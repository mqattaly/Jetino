import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve(import.meta.dirname ?? '.', 'migrations');
const read = async (file: string) => await readFile(resolve(directory, file), 'utf8');

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
    assert.equal(files.at(-1), '011_cash_settlements.sql', 'the settlement schema must be applied after the collection table');
  });
});

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
    assert.ok(position('013_feedback_support.sql') < position('014_cancellation_refunds.sql'), 'refunds are recorded against orders that already exist');
    assert.ok(position('014_cancellation_refunds.sql') < position('015_notification_delivery.sql'), 'delivery state belongs to notifications that already exist');
  });
});
describe('cancellation and refund schema', () => {
  it('records who asked, when, why and what happened', async () => {
    const sql = await read('014_cancellation_refunds.sql');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS cancellation_requests/);
    assert.match(sql, /reason varchar\(300\) NOT NULL/, '§7.11 asks for a reason on every request, so the column cannot be optional');
    assert.match(sql, /CHECK \(outcome IN \('PENDING','ACCEPTED','REJECTED','VOIDED'\)\)/);
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS cancellation_requests_one_open_per_order ON cancellation_requests\(order_id\) WHERE outcome = 'PENDING'/, 'one live request per order, enforced by the database');
    assert.match(sql, /decided_by uuid NULL REFERENCES users\(id\) ON DELETE SET NULL/, 'an answer stays readable after the staff account goes away');
  });

  it('makes the refund ledger append-only by construction', async () => {
    const sql = await read('014_cancellation_refunds.sql');
    assert.match(sql, /amount_rial bigint NOT NULL CHECK \(amount_rial <> 0\)/, 'a zero row would be an edit disguised as a record');
    assert.match(sql, /CONSTRAINT order_refunds_kind_matches_sign CHECK \(\(kind = 'CORRECTION'\) = \(amount_rial < 0\)\)/, 'a correction is negative and a refund positive, in the database');
    assert.match(sql, /created_by uuid NOT NULL REFERENCES users\(id\) ON DELETE RESTRICT/, 'who moved money must never be unlinkable');
  });

  it('keeps one bounded policy row per platform', async () => {
    const sql = await read('014_cancellation_refunds.sql');
    assert.match(sql, /id smallint PRIMARY KEY DEFAULT 1 CHECK \(id = 1\)/, 'the rules are a single row, not a per-region list someone forgets to update');
    assert.match(sql, /window_minutes smallint NOT NULL DEFAULT 0 CHECK \(window_minutes BETWEEN 0 AND 1440\)/);
    assert.match(sql, /INSERT INTO cancellation_policies\(id\) VALUES \(1\) ON CONFLICT\(id\) DO NOTHING;/, 'the row must exist without a second migration');
  });
});

describe('notification delivery schema', () => {
  it('keeps the inbox intact and adds the ledger beside it', async () => {
    const sql = await read('015_notification_delivery.sql');
    assert.match(sql, /ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key varchar\(160\)/);
    assert.doesNotMatch(sql, /DROP COLUMN|ALTER COLUMN|DROP TABLE|DELETE FROM notifications/, 'the inbox must not be rebuilt or trimmed');
  });

  it('lets duplicate control be enforced by the database', async () => {
    const sql = await read('015_notification_delivery.sql');
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_uniq ON notifications\(user_id, event_type, dedupe_key\)/);
    assert.match(sql, /WHERE dedupe_key IS NOT NULL/, 'only events that opted into dedupe are constrained');
  });

  it('stores one delivery row per notification, channel and subscription', async () => {
    const sql = await read('015_notification_delivery.sql');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS notification_deliveries/);
    assert.match(sql, /CONSTRAINT notification_deliveries_channel_check CHECK \(channel IN \('IN_APP','PUSH'\)\)/);
    assert.match(sql, /CONSTRAINT notification_deliveries_state_check CHECK \(state IN \('PENDING','SENT','FAILED','SKIPPED'\)\)/);
    assert.match(sql, /CONSTRAINT notification_deliveries_once_uniq UNIQUE \(notification_id, channel, push_subscription_id\)/, 'a retried dispatch must not be able to insert a second send');
    assert.match(sql, /attempts integer NOT NULL DEFAULT 0 CHECK \(attempts >= 0\)/);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS notification_deliveries_queue_idx ON notification_deliveries\(state, next_attempt_at\)/, 'the queue is read by state and due time');
  });

  it('queues deliveries where the inbox row is written', async () => {
    const sql = await read('015_notification_delivery.sql');
    assert.match(sql, /CREATE OR REPLACE FUNCTION notifications_queue_deliveries\(\) RETURNS trigger/);
    assert.match(sql, /AFTER INSERT ON notifications/);
    assert.match(sql, /FOR EACH ROW EXECUTE FUNCTION notifications_queue_deliveries\(\)/);
    assert.match(sql, /INSERT INTO notification_deliveries\(notification_id, user_id, channel\)\s*\n?\s*VALUES \(NEW.id, NEW.user_id, 'IN_APP'\)/);
    assert.match(sql, /FROM push_subscriptions AS s\s*\n?\s*WHERE s\.user_id = NEW\.user_id AND s\.active/, 'only live subscriptions are queued');
    assert.match(sql, /NOT EXISTS \(\s*SELECT 1 FROM push_event_opt_outs/,'an opt-out must silence the push, and nothing else');
    assert.match(sql, /ON CONFLICT \(notification_id, channel, push_subscription_id\) DO NOTHING/g);
  });

  it('identifies a browser subscription by the endpoint the browser gave us', async () => {
    const sql = await read('015_notification_delivery.sql');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS push_subscriptions/);
    assert.match(sql, /endpoint text NOT NULL UNIQUE/, 'one row per browser, so re-subscribing cannot double-deliver');
    assert.match(sql, /user_id uuid NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    assert.match(sql, /failures integer NOT NULL DEFAULT 0 CHECK \(failures >= 0\)/);
    assert.match(sql, /active boolean NOT NULL DEFAULT true/);
  });
});

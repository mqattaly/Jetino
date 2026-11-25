CREATE TABLE IF NOT EXISTS cash_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES drivers(id) ON DELETE RESTRICT,
  amount_rial bigint NOT NULL CHECK(amount_rial > 0),
  order_count integer NOT NULL CHECK(order_count > 0),
  settled_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  settled_at timestamptz NOT NULL DEFAULT now(),
  note text CHECK(note IS NULL OR char_length(note) <= 280)
);
CREATE INDEX IF NOT EXISTS cash_settlements_driver_idx ON cash_settlements(driver_id,settled_at DESC);
ALTER TABLE cash_collections ADD COLUMN IF NOT EXISTS settlement_id uuid REFERENCES cash_settlements(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS cash_collections_open_idx ON cash_collections(collected_by) WHERE settlement_id IS NULL;

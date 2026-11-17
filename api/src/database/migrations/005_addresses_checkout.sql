CREATE TABLE IF NOT EXISTS addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  label varchar(80) NOT NULL,
  address_text varchar(500) NOT NULL,
  instructions varchar(500),
  latitude numeric(9,6),
  longitude numeric(9,6),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((latitude IS NULL AND longitude IS NULL) OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180))
);
CREATE INDEX IF NOT EXISTS addresses_user_created_idx ON addresses(user_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS addresses_one_default_per_user_idx ON addresses(user_id) WHERE is_default=true;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS address_id uuid REFERENCES addresses(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address_snapshot varchar(500);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_instructions_snapshot varchar(500);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key varchar(120);
CREATE UNIQUE INDEX IF NOT EXISTS orders_customer_idempotency_idx ON orders(customer_id,idempotency_key) WHERE idempotency_key IS NOT NULL;

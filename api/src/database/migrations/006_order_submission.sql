ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_hash char(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

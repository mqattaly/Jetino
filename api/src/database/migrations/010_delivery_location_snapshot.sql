ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_latitude_snapshot numeric(9,6),
  ADD COLUMN IF NOT EXISTS delivery_longitude_snapshot numeric(9,6);

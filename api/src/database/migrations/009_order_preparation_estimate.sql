ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS estimated_prep_minutes integer;

ALTER TABLE orders
  ADD CONSTRAINT orders_estimated_prep_minutes_check
  CHECK (estimated_prep_minutes IS NULL OR estimated_prep_minutes BETWEEN 5 AND 240);

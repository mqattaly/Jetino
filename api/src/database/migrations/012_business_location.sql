ALTER TABLE businesses ADD COLUMN IF NOT EXISTS latitude numeric(9,6), ADD COLUMN IF NOT EXISTS longitude numeric(9,6);
ALTER TABLE businesses
  ADD CONSTRAINT businesses_location_pair_check
  CHECK ((latitude IS NULL AND longitude IS NULL) OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180));

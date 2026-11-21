-- Product photos and verified driver identity: the customer and the shop must be able to
-- recognise the food and the courier before the handover, the way Snapp-style apps do it.
-- Photos arrive as an https URL or a small base64 data URL (the browser downscales first);
-- the API validates type, magic bytes and size before anything lands here.
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url text CHECK (image_url IS NULL OR char_length(image_url) <= 420000);

-- A driver is only assignable once the identity the customer checks at the door is on file:
-- real name, vehicle, Iranian plate and a face photo. All four stay nullable so existing
-- rows survive the migration; the assignment gate in the API refuses incomplete profiles.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS full_name varchar(120);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_type varchar(20) CHECK (vehicle_type IS NULL OR vehicle_type IN ('MOTORCYCLE','CAR','BICYCLE','OTHER'));
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS plate_number varchar(20);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS photo_url text CHECK (photo_url IS NULL OR char_length(photo_url) <= 420000);
-- One plate, one courier: a second account cannot reuse the same vehicle.
CREATE UNIQUE INDEX IF NOT EXISTS drivers_plate_unique ON drivers(plate_number) WHERE plate_number IS NOT NULL;

-- Backfill what we already know so approved drivers are not needlessly incomplete:
-- the account display name, then the latest approved application.
UPDATE drivers d SET full_name = u.display_name FROM users u
 WHERE u.id = d.user_id AND d.full_name IS NULL AND u.display_name IS NOT NULL;
UPDATE drivers d SET full_name = COALESCE(d.full_name, a.full_name), vehicle_type = COALESCE(d.vehicle_type, a.vehicle_type)
FROM (SELECT DISTINCT ON (user_id) user_id, full_name, vehicle_type FROM driver_applications WHERE status = 'APPROVED' ORDER BY user_id, created_at DESC) a
WHERE a.user_id = d.user_id;

-- Handover code: the customer holds a 4-digit code, the courier must type it to finish a
-- delivery. Only a hash is compared; the code itself is stored encrypted so the customer
-- can read it back from their order. Attempts are capped so the code cannot be brute-forced.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_code_hash varchar(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_code_encrypted text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_code_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_code_attempts >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_code_locked_at timestamptz;

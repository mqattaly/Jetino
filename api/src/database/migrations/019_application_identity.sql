-- A courier application now carries the same door-check identity as the driver profile:
-- plate and face photo. They are copied onto `drivers` when a manager approves the
-- application, so an approved driver is assignable immediately.
ALTER TABLE driver_applications ADD COLUMN IF NOT EXISTS plate_number varchar(20);
ALTER TABLE driver_applications ADD COLUMN IF NOT EXISTS photo_url text CHECK (photo_url IS NULL OR char_length(photo_url) <= 420000);
-- Two live applications cannot claim the same plate; the partial index only covers claims
-- that are still open or approved, so a rejected application frees the plate again.
CREATE UNIQUE INDEX IF NOT EXISTS driver_applications_plate_pending ON driver_applications(plate_number) WHERE plate_number IS NOT NULL AND status IN ('PENDING','APPROVED');

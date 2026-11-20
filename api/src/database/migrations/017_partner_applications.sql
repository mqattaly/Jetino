-- Applications do not activate drivers; a manager explicitly decides them.
CREATE TABLE driver_applications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
 full_name varchar(120) NOT NULL,
 vehicle_type varchar(20) NOT NULL CHECK (vehicle_type IN ('MOTORCYCLE','CAR','BICYCLE','OTHER')),
 note varchar(500),
 status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
 decision_note varchar(300),
 decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
 decided_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX driver_applications_one_pending ON driver_applications(user_id) WHERE status='PENDING';
CREATE INDEX driver_applications_status_created_idx ON driver_applications(status,created_at);
ALTER TABLE businesses ADD COLUMN address_text varchar(500), ADD COLUMN contact_phone varchar(20), ADD COLUMN working_hours varchar(200), ADD COLUMN decision_note varchar(300), ADD COLUMN admin_suspended boolean NOT NULL DEFAULT false, ADD COLUMN application_key uuid;
CREATE UNIQUE INDEX businesses_owner_application_key ON businesses(owner_id,application_key) WHERE application_key IS NOT NULL;
-- Historic PAUSED rows did not distinguish an owner pause from an administrative
-- suspension. Fail closed until an administrator explicitly reviews/reactivates them.
UPDATE businesses SET admin_suspended=true WHERE status='PAUSED';

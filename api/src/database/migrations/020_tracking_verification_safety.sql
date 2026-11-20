-- Live tracking, document verification, safety events and rate limiting.
-- All four answer the same question a customer asks at the door: who is coming,
-- is that person verified, and what happens if something goes wrong.

-- One live position per courier. Rows exist only while a mission is running;
-- the driver's app clears it when delivery finishes or sharing is switched off.
CREATE TABLE driver_locations (
  driver_id uuid PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
  latitude numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_meters integer CHECK (accuracy_meters IS NULL OR (accuracy_meters >= 0 AND accuracy_meters <= 5000)),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX driver_locations_updated_idx ON driver_locations(updated_at);

-- Documents on file. A courier uploads the national ID card and a selfie; a
-- manager approves or rejects them. The assignment gate can require approval.
ALTER TABLE drivers ADD COLUMN id_card_url text CHECK (id_card_url IS NULL OR char_length(id_card_url) <= 420000);
ALTER TABLE drivers ADD COLUMN selfie_url text CHECK (selfie_url IS NULL OR char_length(selfie_url) <= 420000);
ALTER TABLE drivers ADD COLUMN verification_submitted_at timestamptz;
ALTER TABLE drivers ADD COLUMN verification_status varchar(16) NOT NULL DEFAULT 'UNVERIFIED'
  CHECK (verification_status IN ('UNVERIFIED','PENDING','APPROVED','REJECTED'));
ALTER TABLE drivers ADD COLUMN verification_note varchar(300);
ALTER TABLE drivers ADD COLUMN verified_at timestamptz;
ALTER TABLE drivers ADD COLUMN verified_by uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX drivers_verification_idx ON drivers(verification_status);

CREATE TABLE driver_verification_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  status varchar(16) NOT NULL,
  note varchar(300),
  -- the reviewer ticks this after comparing the selfie with the profile photo and the ID card
  selfie_match boolean,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX driver_verification_history_driver_idx ON driver_verification_history(driver_id, created_at DESC);

-- Off by default: an operator turns it on once enough couriers are reviewed,
-- so switching it on never silently strands drivers who already run missions.
INSERT INTO platform_settings(key,value_int) VALUES('require_driver_verification',0) ON CONFLICT(key) DO NOTHING;

-- Emergency reports from any party of an order. They stay in the operations
-- queue until a human acknowledges and closes them.
CREATE TABLE safety_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  raised_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  raised_role varchar(16) NOT NULL CHECK (raised_role IN ('CUSTOMER','BUSINESS','DRIVER')),
  category varchar(20) NOT NULL DEFAULT 'OTHER' CHECK (category IN ('UNSAFE','HARASSMENT','ACCIDENT','OTHER')),
  note varchar(500),
  status varchar(16) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  handled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  handled_at timestamptz,
  resolution varchar(300),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX safety_events_status_created_idx ON safety_events(status, created_at);
-- One open alarm per person per order: pressing the button twice must not spam the queue.
CREATE UNIQUE INDEX safety_events_one_open ON safety_events(order_id, raised_by) WHERE status <> 'RESOLVED';

-- A database-backed counter so every serverless instance shares the same limit.
CREATE TABLE rate_limit_counters (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX rate_limit_counters_window_idx ON rate_limit_counters(window_start);

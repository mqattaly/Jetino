CREATE TABLE IF NOT EXISTS order_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  driver_id uuid NULL REFERENCES drivers(id) ON DELETE SET NULL,
  business_rating smallint NOT NULL CHECK (business_rating BETWEEN 1 AND 5),
  driver_rating smallint NULL CHECK (driver_rating IS NULL OR driver_rating BETWEEN 1 AND 5),
  comment varchar(500) NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_feedback_business_idx ON order_feedback(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS order_feedback_driver_idx ON order_feedback(driver_id, created_at DESC);

CREATE TABLE IF NOT EXISTS support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NULL REFERENCES orders(id) ON DELETE SET NULL,
  opened_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_REVIEW','RESOLVED','CLOSED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body varchar(2000) NOT NULL,
  from_staff boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS support_ticket_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_status varchar(20) NULL,
  to_status varchar(20) NOT NULL,
  note varchar(500) NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS support_messages_ticket_idx ON support_messages(ticket_id, created_at, id);
-- one live complaint per order per person; a second one goes into the existing thread
CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_open_per_order_person
  ON support_tickets(order_id, opened_by) WHERE status IN ('OPEN','IN_REVIEW');
-- a database that already applied an earlier draft of this file has no id column,
-- and events are read ordered by (created_at,id), so the tiebreaker is not optional
ALTER TABLE support_ticket_events ADD COLUMN IF NOT EXISTS id uuid PRIMARY KEY DEFAULT gen_random_uuid();

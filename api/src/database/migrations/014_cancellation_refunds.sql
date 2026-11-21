-- §7.11: cancellation requests and refunds.
-- A cancel is a *request* that policy may grant on its own, plus an append-only refund
-- ledger: money that changed hands is never unwritten, only answered by another row.
CREATE TABLE IF NOT EXISTS cancellation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason varchar(300) NOT NULL,
  outcome varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (outcome IN ('PENDING','ACCEPTED','REJECTED','VOIDED')),
  decided_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz NULL,
  note varchar(300) NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- one live request per order, so the queue cannot be flooded by an impatient customer
CREATE UNIQUE INDEX IF NOT EXISTS cancellation_requests_one_open_per_order ON cancellation_requests(order_id) WHERE outcome = 'PENDING';
CREATE INDEX IF NOT EXISTS cancellation_requests_outcome_created_idx ON cancellation_requests(outcome, created_at);

CREATE TABLE IF NOT EXISTS order_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  amount_rial bigint NOT NULL CHECK (amount_rial <> 0),
  kind varchar(16) NOT NULL DEFAULT 'REFUND' CHECK (kind IN ('REFUND','CORRECTION')),
  funded_by varchar(16) NOT NULL DEFAULT 'PLATFORM' CHECK (funded_by IN ('PLATFORM','BUSINESS','DRIVER')),
  reason varchar(300) NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- a clawback is the only reason a row may be negative, and a refund the only reason for a positive one
  CONSTRAINT order_refunds_kind_matches_sign CHECK ((kind = 'CORRECTION') = (amount_rial < 0))
);
CREATE INDEX IF NOT EXISTS order_refunds_order_created_idx ON order_refunds(order_id, created_at);

-- one row per platform: the rules the customer's own cancel button follows
CREATE TABLE IF NOT EXISTS cancellation_policies (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  auto_statuses varchar(200) NOT NULL DEFAULT 'PENDING_BUSINESS',
  window_minutes smallint NOT NULL DEFAULT 0 CHECK (window_minutes BETWEEN 0 AND 1440),
  updated_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO cancellation_policies(id) VALUES (1) ON CONFLICT(id) DO NOTHING;

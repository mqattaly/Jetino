-- §7.12 notifications: delivery state, duplicate control and browser push subscriptions.
-- The inbox table from 008 keeps its meaning ("what the user sees"); this migration adds the
-- delivery ledger next to it ("what we tried to send, through which channel, and what happened").
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth_secret text NOT NULL,
  user_agent varchar(200),
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id, active);

-- Duplicate control lives in the database, not in the call sites: one inbox row per
-- (recipient, event, dedupe key), so a retried request cannot spam a phone.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key varchar(160);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_uniq ON notifications(user_id, event_type, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel varchar(16) NOT NULL,
  push_subscription_id bigint REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state varchar(16) NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_deliveries_channel_check CHECK (channel IN ('IN_APP','PUSH')),
  CONSTRAINT notification_deliveries_state_check CHECK (state IN ('PENDING','SENT','FAILED','SKIPPED')),
  -- One row per (notification, channel, subscription): a retried dispatch can never send twice.
  CONSTRAINT notification_deliveries_once_uniq UNIQUE (notification_id, channel, push_subscription_id)
);
CREATE INDEX IF NOT EXISTS notification_deliveries_queue_idx ON notification_deliveries(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS notification_deliveries_user_idx ON notification_deliveries(user_id, created_at DESC);

-- Event targeting (§7.12): a user opts out of a push by event type. Only refusals are stored, so
-- an event type added next release is still delivered until somebody says otherwise. The inbox
-- itself is never filtered — an opt-out silences the push, it does not hide the message.
CREATE TABLE IF NOT EXISTS push_event_opt_outs (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type varchar(80) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, event_type)
);

-- The ledger is written where the inbox row is written, so no call site can create a
-- notification that nobody will ever see: every inbox row gets an IN_APP delivery, and every
-- active push subscription of that user gets one PUSH delivery. Rows are PENDING; the dispatcher
-- decides whether they can actually go out.
CREATE OR REPLACE FUNCTION notifications_queue_deliveries() RETURNS trigger AS $$
BEGIN
  INSERT INTO notification_deliveries(notification_id, user_id, channel)
    VALUES (NEW.id, NEW.user_id, 'IN_APP')
    ON CONFLICT (notification_id, channel, push_subscription_id) DO NOTHING;
  INSERT INTO notification_deliveries(notification_id, user_id, channel, push_subscription_id)
    SELECT NEW.id, NEW.user_id, 'PUSH', s.id
    FROM push_subscriptions AS s
    WHERE s.user_id = NEW.user_id AND s.active
      AND NOT EXISTS (
        SELECT 1 FROM push_event_opt_outs AS o
        WHERE o.user_id = NEW.user_id AND o.event_type = NEW.event_type
      )
    ON CONFLICT (notification_id, channel, push_subscription_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notifications_queue_deliveries_trigger ON notifications;
CREATE TRIGGER notifications_queue_deliveries_trigger
  AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_queue_deliveries();

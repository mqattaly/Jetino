CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type varchar(80) NOT NULL,
  title varchar(160) NOT NULL,
  body varchar(500) NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications(user_id,created_at DESC) WHERE read_at IS NULL;

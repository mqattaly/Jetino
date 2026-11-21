DO $$ BEGIN CREATE TYPE app_role AS ENUM ('CUSTOMER','BUSINESS_OWNER','BUSINESS_STAFF','DRIVER','SUPPORT','REGION_MANAGER','OPERATIONS_MANAGER','FINANCE','SUPER_ADMIN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS otp_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone varchar(20) NOT NULL,
 code_digest char(64) NOT NULL, expires_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0), consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_phone_created_idx ON otp_challenges(phone,created_at DESC);
CREATE TABLE IF NOT EXISTS user_roles (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 role app_role NOT NULL, granted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,role)
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid REFERENCES users(id) ON DELETE RESTRICT,
 action varchar(120) NOT NULL, entity_type varchar(80) NOT NULL, entity_id varchar(120),
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);

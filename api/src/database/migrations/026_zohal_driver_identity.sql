-- احراز هویت پیک با وب‌سرویس زحل: شاهکار (تطبیق موبایل با کد ملی)، استعلام ثبت احوال
-- (کد ملی + تاریخ تولد) و احراز هویت بیومتریک (ویدئوی سلفی/Liveness).
-- همهٔ ستون‌ها nullable هستند تا پیک‌های فعلی دست‌نخورده بمانند؛ دروازهٔ مأموریت فقط وقتی
-- روشن می‌شود که صریحاً در تنظیمات فعال شود.

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS national_code char(10);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS birth_date date;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS national_card_serial varchar(10);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS gender smallint CHECK (gender IS NULL OR gender IN (0,1));
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS shahkar_matched boolean;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS identity_matched boolean;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS identity_first_name varchar(60);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS identity_last_name varchar(60);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS identity_father_name varchar(60);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS identity_checked_at timestamptz;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS biometric_status varchar(16) NOT NULL DEFAULT 'NONE'
  CHECK (biometric_status IN ('NONE','PENDING','MATCHED','REJECTED','FAILED'));
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS biometric_session_id varchar(80);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS biometric_reason varchar(60);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS biometric_checked_at timestamptz;

-- یک کد ملی، یک پیک: با این ایندکس نمی‌شود با دو حساب و یک هویت مأموریت گرفت.
CREATE UNIQUE INDEX IF NOT EXISTS drivers_national_code_unique ON drivers(national_code) WHERE national_code IS NOT NULL;

-- هر فراخوانی زحل (موفق یا ناموفق) یک ردیف است: پول هر استعلام هزینه دارد و باید
-- بتوانیم بگوییم کِی، برای کدام پیک و با چه نتیجه‌ای صدا زده شد. کد ملی کامل این‌جا نمی‌نشیند.
CREATE TABLE IF NOT EXISTS identity_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid REFERENCES drivers(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  provider varchar(20) NOT NULL DEFAULT 'ZOHAL',
  kind varchar(24) NOT NULL CHECK (kind IN ('SHAHKAR','ID_INQUIRY','BIOMETRIC_UPLOAD','BIOMETRIC_SESSION','BIOMETRIC_RESULT')),
  ok boolean NOT NULL,
  reason varchar(80),
  provider_ref varchar(80),
  latency_ms integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS identity_checks_driver_idx ON identity_checks(driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS identity_checks_kind_idx ON identity_checks(kind, created_at DESC);

INSERT INTO platform_settings(key,value_int) VALUES('require_driver_identity',0) ON CONFLICT(key) DO NOTHING;

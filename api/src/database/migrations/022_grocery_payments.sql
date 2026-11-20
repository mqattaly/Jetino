-- مرحلهٔ ۱٫۵ فاز سوپرمارکت: پیش‌پرداخت کرایهٔ ماموریت، تمدید مهلت‌ها،
-- اعتراض به فاکتور و استرداد به کیف پول.

-- ۱) کرایهٔ ماموریت قبل از شروع خرید پرداخت و توسط کارکنان تأیید می‌شود.
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS fee_payment_method varchar(20);
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS fee_receipt_url text CHECK (fee_receipt_url IS NULL OR char_length(fee_receipt_url) <= 420000);
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS fee_reference varchar(80);
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS fee_declared_at timestamptz;
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS fee_confirmed_at timestamptz;
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS fee_confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS fee_deadline_at timestamptz;
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS fee_reminder_at timestamptz;
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS fee_extensions integer NOT NULL DEFAULT 0 CHECK (fee_extensions >= 0);

-- ۲) یادآوری و تمدید مهلت پرداخت فاکتور کالا.
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS payment_extensions integer NOT NULL DEFAULT 0 CHECK (payment_extensions >= 0);
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS payment_reminder_at timestamptz;

-- ۳) مشتری می‌تواند به فاکتور اعتراض کند تا پیک آن را اصلاح کند.
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS invoice_reject_reason varchar(300);
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS invoice_rejected_at timestamptz;

-- ۴) استرداد کرایه به کیف پول مشتری.
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS refund_rial bigint NOT NULL DEFAULT 0 CHECK (refund_rial >= 0);
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

CREATE INDEX IF NOT EXISTS grocery_lists_fee_pending_idx ON grocery_lists(status, fee_deadline_at) WHERE fee_confirmed_at IS NULL;

-- ۵) دفتر اعتبار کیف پول مستقل از سفارش‌ها؛ سوپرمارکت و ماموریت‌ها هم می‌توانند شارژ ثبت کنند.
CREATE TABLE IF NOT EXISTS wallet_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_rial bigint NOT NULL CHECK (amount_rial > 0),
  kind varchar(16) NOT NULL DEFAULT 'CREDIT' CHECK (kind IN ('CREDIT','ADJUSTMENT')),
  source_type varchar(24) NOT NULL,
  source_id uuid,
  reason varchar(300) NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_type, source_id, kind)
);
CREATE INDEX IF NOT EXISTS wallet_credits_user_created_idx ON wallet_credits(user_id, created_at DESC);

-- ۶) تنظیمات تازهٔ ادمین.
INSERT INTO platform_settings(key,value_int,value_text) VALUES
  ('grocery_payment_mode', 0, 'CARD_TO_CARD'),
  ('grocery_extend_minutes', 15, NULL),
  ('grocery_max_extensions', 2, NULL)
ON CONFLICT (key) DO NOTHING;

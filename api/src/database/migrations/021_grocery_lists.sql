-- فاز خرید از سوپرمارکت، مرحلهٔ ۱: «لیست خرید متنی» با پیشنهاد قیمت پیک.
-- مشتری لیست را می‌نویسد، پیک‌های همان منطقه پیشنهاد می‌دهند، مشتری یکی را قبول می‌کند،
-- پیک خرید می‌کند و فاکتور را با شمارهٔ کارت فروشگاه ثبت می‌کند؛ مشتری کارت‌به‌کارت می‌کند
-- و رسید را می‌فرستد؛ پیک (پس از تأیید فروشنده) رسید را تأیید می‌کند.

DO $$ BEGIN CREATE TYPE grocery_status AS ENUM (
  'OPEN',              -- در حال دریافت پیشنهاد
  'ASSIGNED',          -- پیک انتخاب شده، هنوز خرید شروع نشده
  'SHOPPING',          -- پیک در فروشگاه است
  'INVOICE_SENT',      -- فاکتور ثبت شده، منتظر تأیید مشتری
  'AWAITING_PAYMENT',  -- مشتری فاکتور را تأیید کرده، مهلت کارت‌به‌کارت
  'PAID',              -- رسید آپلود شده، منتظر تأیید پیک
  'PAYMENT_CONFIRMED', -- پول به فروشگاه رسیده
  'DELIVERED',
  'CANCELLED',
  'EXPIRED'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE grocery_bid_status AS ENUM ('PENDING','ACCEPTED','REJECTED','EXPIRED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS grocery_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  store_name varchar(160),
  items_text varchar(2000) NOT NULL,
  note varchar(500),
  address_id uuid REFERENCES addresses(id) ON DELETE SET NULL,
  delivery_address_snapshot varchar(500) NOT NULL,
  delivery_instructions_snapshot varchar(500),
  delivery_latitude_snapshot numeric(9,6),
  delivery_longitude_snapshot numeric(9,6),
  status grocery_status NOT NULL DEFAULT 'OPEN',
  bid_deadline_at timestamptz NOT NULL,
  driver_id uuid REFERENCES drivers(id) ON DELETE SET NULL,
  accepted_bid_id uuid,
  fee_rial bigint CHECK (fee_rial IS NULL OR fee_rial >= 0),
  invoice_amount_rial bigint CHECK (invoice_amount_rial IS NULL OR invoice_amount_rial >= 0),
  invoice_photo_url text CHECK (invoice_photo_url IS NULL OR char_length(invoice_photo_url) <= 420000),
  invoice_store_card varchar(26),
  invoice_store_holder varchar(120),
  invoice_submitted_at timestamptz,
  invoice_approved_at timestamptz,
  payment_method varchar(20),
  payment_receipt_url text CHECK (payment_receipt_url IS NULL OR char_length(payment_receipt_url) <= 420000),
  payment_reference varchar(80),
  payment_declared_at timestamptz,
  payment_deadline_at timestamptz,
  payment_confirmed_at timestamptz,
  payment_confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  platform_fee_rial bigint NOT NULL DEFAULT 0 CHECK (platform_fee_rial >= 0),
  cancel_reason varchar(300),
  idempotency_key varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grocery_lists_status_deadline_idx ON grocery_lists(status, bid_deadline_at);
CREATE INDEX IF NOT EXISTS grocery_lists_customer_created_idx ON grocery_lists(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS grocery_lists_driver_updated_idx ON grocery_lists(driver_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS grocery_lists_region_status_idx ON grocery_lists(region_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS grocery_lists_customer_idempotency_idx ON grocery_lists(customer_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS grocery_bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid NOT NULL REFERENCES grocery_lists(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL REFERENCES drivers(id) ON DELETE RESTRICT,
  amount_rial bigint NOT NULL CHECK (amount_rial > 0),
  note varchar(200),
  status grocery_bid_status NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (list_id, driver_id)
);
CREATE INDEX IF NOT EXISTS grocery_bids_list_status_idx ON grocery_bids(list_id, status);

CREATE TABLE IF NOT EXISTS grocery_invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid NOT NULL REFERENCES grocery_lists(id) ON DELETE CASCADE,
  name varchar(160) NOT NULL,
  quantity numeric(10,2) NOT NULL CHECK (quantity > 0),
  unit varchar(20) NOT NULL DEFAULT 'عدد',
  unit_price_rial bigint NOT NULL CHECK (unit_price_rial >= 0),
  line_total_rial bigint NOT NULL CHECK (line_total_rial >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grocery_invoice_items_list_idx ON grocery_invoice_items(list_id);

-- مدل درآمد از پنل مدیریت انتخاب می‌شود؛ این کلیدها مقدار پیش‌فرض دارند و در مرحلهٔ ادمین
-- به رابط کاربری وصل می‌شوند.
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS value_text text;
INSERT INTO platform_settings(key,value_int,value_text) VALUES
  ('grocery_bid_minutes', 15, NULL),
  ('grocery_payment_minutes', 15, NULL),
  ('grocery_revenue_mode', 0, 'NONE'),
  ('grocery_fee_bps', 1000, NULL),
  ('grocery_goods_bps', 0, NULL),
  ('grocery_fixed_rial', 0, NULL)
ON CONFLICT (key) DO NOTHING;

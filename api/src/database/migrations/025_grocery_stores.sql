-- مرحلهٔ ۵ فاز سوپرمارکت: فروشگاه‌ها و کاتالوگ محصولات.
-- تا اینجا «فروشگاه» فقط یک نام متنی در لیست خرید بود؛ از این پس فروشگاه‌ها ثبت‌نام می‌کنند،
-- مدیر تأییدشان می‌کند و مشتری می‌تواند هنگام نوشتن لیست، فروشگاه مشخصی را انتخاب کند.

CREATE TABLE IF NOT EXISTS grocery_stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  name varchar(160) NOT NULL,
  phone varchar(20),
  address_text varchar(300) NOT NULL,
  note varchar(300),
  status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','SUSPENDED')),
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grocery_stores_region_status_idx ON grocery_stores(region_id, status);

CREATE TABLE IF NOT EXISTS grocery_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES grocery_stores(id) ON DELETE CASCADE,
  name varchar(160) NOT NULL,
  category varchar(40),
  unit varchar(20) NOT NULL DEFAULT 'عدد',
  price_rial bigint NOT NULL CHECK (price_rial >= 0),
  stock numeric(10,2) NOT NULL DEFAULT 0 CHECK (stock >= 0),
  image_url text CHECK (image_url IS NULL OR char_length(image_url) <= 420000),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS grocery_products_store_name_idx ON grocery_products(store_id, lower(name));
CREATE INDEX IF NOT EXISTS grocery_products_store_active_idx ON grocery_products(store_id, is_active);

-- لیست خرید می‌تواند به یک فروشگاه واقعی وصل شود؛ نام متنی برای وقتی است که مشتری فروشگاه را
-- به انتخاب پیک می‌سپارد.
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES grocery_stores(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS grocery_lists_store_idx ON grocery_lists(store_id);

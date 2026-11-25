CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE TYPE user_status AS ENUM ('ACTIVE','SUSPENDED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE business_status AS ENUM ('PENDING','ACTIVE','PAUSED','REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE order_status AS ENUM ('PENDING_BUSINESS','CONFIRMED','PREPARING','READY_FOR_PICKUP','DRIVER_ASSIGNED','OUT_FOR_DELIVERY','DELIVERED','REJECTED','CANCELLED','UNDER_REVIEW'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE payment_method AS ENUM ('CASH','ONLINE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE payment_status AS ENUM ('PENDING','PAID','FAILED','REFUNDED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone varchar(20) NOT NULL UNIQUE,
 display_name varchar(120), status user_status NOT NULL DEFAULT 'ACTIVE',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS regions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(120) NOT NULL,
 slug varchar(120) NOT NULL UNIQUE, is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS businesses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT, name varchar(160) NOT NULL,
 description varchar(1000), status business_status NOT NULL DEFAULT 'PENDING',
 commission_bps integer NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 10000),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS businesses_region_status_idx ON businesses(region_id,status);
CREATE TABLE IF NOT EXISTS menu_categories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 name varchar(100) NOT NULL, sort_order integer NOT NULL DEFAULT 0, UNIQUE(business_id,name)
);
CREATE TABLE IF NOT EXISTS products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), category_id uuid NOT NULL REFERENCES menu_categories(id) ON DELETE CASCADE,
 name varchar(160) NOT NULL, description varchar(1000), price_rial bigint NOT NULL CHECK(price_rial >= 0),
 is_available boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS products_category_available_idx ON products(category_id,is_available);
CREATE TABLE IF NOT EXISTS orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
 status order_status NOT NULL DEFAULT 'PENDING_BUSINESS', payment_method payment_method NOT NULL,
 payment_status payment_status NOT NULL DEFAULT 'PENDING', subtotal_rial bigint NOT NULL CHECK(subtotal_rial >= 0),
 delivery_fee_rial bigint NOT NULL CHECK(delivery_fee_rial >= 0), commission_rial bigint NOT NULL CHECK(commission_rial >= 0),
 commission_bps integer NOT NULL CHECK(commission_bps BETWEEN 0 AND 10000),
 total_rial bigint NOT NULL CHECK(total_rial >= 0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_customer_created_idx ON orders(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS orders_business_status_created_idx ON orders(business_id,status,created_at DESC);
CREATE TABLE IF NOT EXISTS order_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
 product_id uuid, product_name varchar(160) NOT NULL, unit_price_rial bigint NOT NULL CHECK(unit_price_rial >= 0),
 quantity integer NOT NULL CHECK(quantity > 0), line_total_rial bigint NOT NULL CHECK(line_total_rial >= 0)
);
CREATE TABLE IF NOT EXISTS order_status_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
 from_status order_status, to_status order_status NOT NULL, actor_id uuid, reason varchar(500),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_history_order_created_idx ON order_status_history(order_id,created_at);

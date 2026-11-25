-- مرحلهٔ ۴ فاز سوپرمارکت: گزارش‌ها.
-- کارمزدی که هنگام تأیید پرداخت محاسبه می‌شود، باید مدل درآمد همان لحظه را هم ثبت کند؛
-- وگرنه عوض شدن تنظیمات، گزارش‌های قبلی را تحریف می‌کند.
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS platform_fee_mode varchar(24);
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS platform_fee_bps integer;
ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS platform_fee_fixed_rial bigint;

CREATE INDEX IF NOT EXISTS grocery_lists_created_at_idx ON grocery_lists(created_at DESC);
CREATE INDEX IF NOT EXISTS grocery_lists_payment_confirmed_idx ON grocery_lists(payment_confirmed_at) WHERE payment_confirmed_at IS NOT NULL;

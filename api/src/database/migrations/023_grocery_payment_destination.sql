-- مقصد پرداخت کارت‌به‌کارت از پنل مدیریت تنظیم می‌شود تا بدون تغییر کد عوض شود.
-- پرداخت آنلاین تا وقتی درگاه وصل نشده خاموش است، ولی کارت‌به‌کارت همیشه به‌عنوان
-- مسیر جایگزین (مشتری راحت‌تر است یا درگاه قطع شده) در دسترس می‌ماند.
ALTER TABLE platform_settings ALTER COLUMN value_text DROP NOT NULL;

INSERT INTO platform_settings(key,value_int,value_text) VALUES
  ('grocery_platform_card', 0, NULL),
  ('grocery_platform_sheba', 0, NULL),
  ('grocery_platform_holder', 0, NULL),
  ('grocery_platform_bank', 0, NULL),
  ('grocery_gateway_enabled', 0, NULL)
ON CONFLICT (key) DO NOTHING;

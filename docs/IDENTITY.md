# احراز هویت پیک با زحل

هدف: مشتری وقتی پیک را دم در می‌بیند، بداند پشت این حساب یک شخص واقعی با همان نام و همان چهره است. سه لایه با هم کار می‌کنند و هیچ‌کدام جای دیگری را نمی‌گیرد:

| لایه | چه چیزی را ثابت می‌کند | سرویس زحل |
|---|---|---|
| شاهکار | شمارهٔ موبایلی که پیک با آن وارد می‌شود به نام همان کد ملی است | `inquiry/shahkar` |
| ثبت احوال | کد ملی + تاریخ تولد وجود دارد و نامش همین است | `inquiry/national_identity_inquiry` |
| بیومتریک | چهرهٔ ویدئوی تازه، همان چهرهٔ ثبت‌احوال است و ویدئو زنده است | `biometric/media`, `session/liveness`, `session/{id}/result` |

تأیید دستی مدارک (کارت ملی + سلفی + عکس پروفایل) سر جایش مانده و این‌ها به آن اضافه شده‌اند، نه جای آن.

## ۱) جریان پیک

1. پیک در `/driver` کارت «احراز هویت رسمی» را باز می‌کند.
2. کد ملی (۱۰ رقم با رقم کنترل)، تاریخ تولد شمسی (`1377/06/30` یا `13770630` یا با ارقام فارسی) و سریال ۱۰ رقمی پشت کارت ملی را وارد می‌کند و جنسیت را انتخاب می‌کند.
3. `POST /api/v1/drivers/me/identity/verify`:
   - کد ملی و شمارهٔ موبایل حساب به شاهکار می‌رود (`normalizeMobile` هر شکل شماره را به `09xxxxxxxxx` می‌رساند).
   - بعد کد ملی + تاریخ تولد + جنسیت به ثبت احوال می‌رود.
   - نام رسمی، `shahkar_matched`، `identity_matched` و `identity_checked_at` روی ردیف پیک ذخیره می‌شود؛ اگر `full_name` خالی باشد، از نام ثبت‌احوال پر می‌شود.
   - اگر کد ملی/تاریخ تولد عوض شود، پروندهٔ بیومتریک قبلی باطل می‌شود (`biometric_status='NONE'`) چون دیگر به همان هویت تعلق ندارد.
4. ویدئوی سلفی: مرورگر با `capture="user"` دوربین را باز می‌کند و فایل خام (webm یا mp4، حداکثر ۴ مگابایت) با هدر `Content-Type: video/...` به `POST /api/v1/drivers/me/identity/biometric` می‌رود.
   - سرور `media/` را صدا می‌زند، سپس `session/liveness/` را با `media.selfie_video`، کد ملی، تاریخ تولد، سریال کارت و جنسیت؛ `session_id` ذخیره و وضعیت `PENDING` می‌شود.
   - بومرورگر هر ۱۵ ثانیه `GET .../identity/biometric` را می‌زند تا نتیجه برسد.
5. نتیجه: `MATCHED` یا `REJECTED` با کد دلیل (`REJECT_VIDEO_NOT_LIVE`, `REJECT_FACE_NOT_MATCH_ID`, …). هر کد دلیل در `identity.util.ts` یک جملهٔ فارسی قابل‌اقدام دارد و همان به پیک نشان داده می‌شود.

## ۲) جدول‌ها و ستون‌ها (مهاجرت `026_zohal_driver_identity`)

- `drivers`: `national_code` (یکتا، جز ایندکس، فقط ۱۰ رقم)، `birth_date`، `national_card_serial`، `gender` (0 زن / 1 مرد)، `shahkar_matched`، `identity_matched`، `identity_first_name`/`last_name`/`father_name`، `identity_checked_at`، `biometric_status` (`NONE|PENDING|MATCHED|REJECTED|FAILED`)، `biometric_session_id`، `biometric_reason`، `biometric_checked_at`.
- `identity_checks`: هر فراخوانی زحل یک ردیف — `kind` (`SHAHKAR|ID_INQUIRY|BIOMETRIC_UPLOAD|BIOMETRIC_SESSION|BIOMETRIC_RESULT`)، `ok`، `reason`، `provider_ref`، `latency_ms`، `metadata`. کد ملی کامل این‌جا ذخیره نمی‌شود؛ فقط نسخهٔ ماسک‌شده.
- `platform_settings.require_driver_identity` (پیش‌فرض `0`): اگر `1` شود، پیشنهاد دادن در سوپرمارکت و تخصیص سفارش از پنل ادمین فقط برای پیکی مجاز است که `shahkar_matched=true`، `identity_matched=true` و `biometric_status='MATCHED'` باشد.

## ۳) API

| متد | مسیر | چه کسی |
|---|---|---|
| `GET` | `drivers/me/identity` | پیک — وضعیت فعلی (کد ملی ماسک‌شده) |
| `POST` | `drivers/me/identity/verify` | پیک — شاهکار + ثبت احوال |
| `POST` | `drivers/me/identity/biometric` | پیک — ویدئوی خام سلفی (webm/mp4 ≤ ۴MB) |
| `GET` | `drivers/me/identity/biometric` | پیک — نتیجهٔ تازه از سرویس |
| `POST` | `admin/drivers/:id/identity/refresh` | کارکنان — یک استعلام تازه وقتی پیک گیر کرده |

## ۴) قواعد سخت‌گیرانه

- کد ملی با الگوریتم رسمی کنترل می‌شود و کدهای تکراری (`1111111111`) رد می‌شوند.
- سن زیر ۱۸ سال رد می‌شود (تبدیل دقیق شمسی/میلادی با الگوریتم jalaali-js، نه تقریب).
- یک کد ملی فقط برای یک حساب پیک (`drivers_national_code_unique`).
- «عدم تطبیق» یک پاسخ است نه خطا: ذخیره می‌شود تا پشتیبانی ببیند ثبت احوال/شاهکار چه گفته‌اند.
- هر خطای سرویس (`INSUFFICIENT_BALANCE`، `IP_NOT_ALLOWED`، timeout، بدنهٔ ناخوانا) به پیام فارسی قابل‌اقدام تبدیل می‌شود و در `identity_checks` با `ok=false` می‌نشیند.
- هیچ درخواستی retry نمی‌شود (هر استعلام هزینه دارد)؛ poll نتیجه حداکثر هر ۱۰ ثانیه یک سؤال می‌پرسد و ارسال ویدئوی تازه تا ۱۰ دقیقه بعد از جلسهٔ در جریان، بسته است.
- اگر `ZOHAL_TOKEN` خالی باشد، کارت احراز هویت پیام «کلید وصل نشده» می‌دهد و هیچ درخواستی به بیرون نمی‌رود.

## ۵) راه‌اندازی

```bash
# .env یا Vercel → Environment Variables
ZOHAL_TOKEN=...
ZOHAL_BIOMETRIC_TOKEN=...
ZOHAL_BASE_URL=https://service.zohal.io   # پیش‌فرض
ZOHAL_TIMEOUT_MS=12000                    # پیش‌فرض
```

سپس `cd api && npm run db:migrate` (یا اجرای `026_zohal_driver_identity.sql` و ثبت در `schema_migrations`).

**حافظهٔ IP:** زحل فقط از IPهای ثبت‌شده جواب می‌دهد؛ IP خروجی توابع Vercel ثابت نیست. تا ثبت بازهٔ IP یا قرار دادن یک پروکسی با IP ثابت، انتظار `IP_NOT_ALLOWED` داشته باشید.

## ۶) تست

- واحد: `cd api && npx tsx --test src/identity/*.spec.ts` — کنترل کد ملی، تبدیل تاریخ، قرارداد زحل (پاسخ «عدم تطبیق» ≠ خطا)، ذخیرهٔ نتیجه، قواعد ویدئو، نگهبان هزینه.
- دستی: `ZOHAL_TOKEN` را در `.env` بگذارید، API را بالا بیاورید و با یک شمارهٔ واقعی تست کنید. پاسخ‌ها در `identity_checks` قابل ردیابی‌اند.
- کلید واقعی در تست‌ها استفاده نمی‌شود؛ `fetch` تزریق‌شده در `ZohalService` ساختگی است.

# جتینو (Jetino)

پروژهٔ PWA فارسی سفارش غذای محلی برای بندر خمیر. محدودهٔ نسخهٔ اولیه و تصمیم‌های باز در `PRD.md` و `Master_Project_Context.md` ثبت شده‌اند.

## اجرای رابط کاربری

```bash
npm install
npm run dev
```

## نصب وب‌اپ و حالت آفلاین

رابط کاربری manifest و service worker دارد و روی HTTPS (یا localhost) از گزینهٔ نصب مرورگر پشتیبانی می‌کند. shell برنامه و فایل‌های buildشده برای بارگذاری مجدد آفلاین cache می‌شوند؛ درخواست‌های API عمداً cache نمی‌شوند، بنابراین ثبت سفارش، ورود و وضعیت‌های زنده در حالت آفلاین در دسترس نیستند. برای نصب در موبایل از منوی مرورگر «افزودن به صفحهٔ اصلی» را انتخاب کنید.

## اجرای API و پایگاه دادهٔ توسعه

```bash
cp .env.example .env
# مقادیر JWT_SECRET و OTP_HMAC_SECRET را برای توسعه با اسرار تصادفی جایگزین کنید.
docker compose up -d postgres
cd api
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed:demo # اختیاری؛ یک رستوران نمونه برای تست رابط مشتری می‌سازد.
npm run dev
```

سلامت API: `GET http://localhost:3000/api/v1/health`

در صورت اجرای فرانت‌اند و API روی originهای متفاوت، `CORS_ORIGIN` باید origin فرانت‌اند باشد. برای ورود OTP، کلید کاوه‌نگار و نام قالب تأیید باید در محیط API تنظیم شود. هیچ کلید واقعی یا مقدار محرمانه‌ای را در فایل‌های نمونه یا Git ذخیره نکنید.

### مقادیر مالی و دسترسی مدیر کل

مقدار شروع کرایهٔ ثابت بندر خمیر ۵۰۰٬۰۰۰ ریال و کمیسیون پیش‌فرض ۱۰٪ است؛ هر دو موقت و قابل تغییر هستند. برای ارتقای کاربری که قبلاً با OTP وارد شده، در `api/.env` مقدار `ADMIN_PHONE` را تنظیم کنید و اجرا کنید:

```bash
npm run admin:promote
```

پس از اعطای نقش، کاربر باید دوباره وارد شود تا JWT جدید نقش مدیر کل را داشته باشد. پنل گرافیکی تنظیم قیمت و بررسی درخواست‌های کسب‌وکار در `/admin/settings` در دسترس است. APIهای محافظت‌شدهٔ `GET/PATCH /api/v1/admin/settings` و `GET /api/v1/admin/businesses?status=PENDING` و `PATCH /api/v1/admin/businesses/:id/status` فقط با نقش `SUPER_ADMIN` کار می‌کنند. بدنهٔ PATCH نمونه: `{"deliveryFeeRial":600000,"defaultCommissionBps":1200}`. مبالغ ریال و کمیسیون برحسب basis point هستند (۱۰۰۰ = ۱۰٪). تغییرها در audit log ثبت می‌شوند.

### نشانی، پیش‌فاکتور و سفارش نقدی

- `GET/POST /api/v1/addresses` و `PATCH/DELETE /api/v1/addresses/:id` برای نشانی‌های متعلق به کاربر واردشده.
- `POST /api/v1/orders/quote` قیمت جاری محصولات، کرایه و کمیسیون را سمت سرور محاسبه می‌کند؛ پیش‌فاکتور رزرو نیست.
- `POST /api/v1/orders` سفارش نقدی ثبت می‌کند. هدر `Idempotency-Key` الزامی است؛ مبلغ ارسالی از کلاینت پذیرفته نمی‌شود و سرور قیمت‌ها را در تراکنش دوباره محاسبه می‌کند.
- `GET /api/v1/orders/mine`, `GET /api/v1/orders/:id`, `POST /api/v1/orders/:id/cancel` برای سفارش‌های مشتری؛ `GET /api/v1/orders/business/mine` و `PATCH /api/v1/orders/:id/status` برای کسب‌وکار مالک.
- `GET /api/v1/notifications`, `PATCH /api/v1/notifications/:id/read` و `POST /api/v1/notifications/read-all` برای اعلان‌های درون‌برنامه‌ای همان کاربر.
- پیش از تأیید کسب‌وکار، مشتری می‌تواند سفارش را لغو کند. برای مسیر کسب‌وکار وضعیت‌های تأیید/رد، آماده‌سازی و آمادهٔ تحویل به پیک پشتیبانی می‌شود.
- مدیر کل از بخش «ارسال و رانندگان» در `/admin/settings` رانندهٔ فعال را به سفارش آماده تخصیص می‌دهد. کاربر راننده باید ابتدا با OTP وارد شده باشد؛ مدیر کل حساب او را به راننده تبدیل می‌کند.
- مسیر `/driver/deliveries` برای حرکت به «در مسیر» و «تحویل‌شده» است؛ پس از تحویل، راننده دریافت کامل وجه نقد را صریحاً تأیید می‌کند و پرداخت از `PENDING` به `PAID` می‌رود. رویداد وصول در `cash_collections` و audit ثبت می‌شود.
- رابط مشتری از دیتابیس فهرست/منو می‌گیرد؛ مسیر `/orders` پیگیری مشتری، `/notifications` اعلان‌های درون‌برنامه‌ای، `/business/orders` پنل سفارش‌های کسب‌وکار و `/business/menu` مدیریت دسته‌بندی و موجودی محصولات است. مدیریت منو از APIهای `GET /api/v1/businesses/mine/:id/menu`, `POST /api/v1/businesses/:id/categories`, `POST /api/v1/businesses/categories/:categoryId/products` و `PATCH /api/v1/businesses/products/:productId/availability` استفاده می‌کند و همه به مالک کسب‌وکار محدودند. Push و SMS عملیاتی (غیر از OTP) و پرداخت آنلاین هنوز متصل نیستند.

> دادهٔ نمایشی فقط با `npm run db:seed:demo` و فقط در محیط توسعه ساخته می‌شود. کد OTP آزمایشی یا میان‌بر ورود وجود ندارد.

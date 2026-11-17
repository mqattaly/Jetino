# جتینو (Jetino)

پروژهٔ PWA فارسی سفارش غذای محلی برای بندر خمیر. محدودهٔ نسخهٔ اولیه و تصمیم‌های باز در `PRD.md` و `Master_Project_Context.md` ثبت شده‌اند.

## اجرای رابط کاربری

```bash
npm install
npm run dev
```

## اجرای API و پایگاه دادهٔ توسعه

```bash
cp .env.example .env
# مقادیر JWT_SECRET و OTP_HMAC_SECRET را برای توسعه با اسرار تصادفی جایگزین کنید.
docker compose up -d postgres
cd api
cp .env.example .env
npm install
npm run db:migrate
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

### نشانی و پیش‌فاکتور

- `GET/POST /api/v1/addresses` و `PATCH/DELETE /api/v1/addresses/:id` برای نشانی‌های متعلق به کاربر واردشده.
- `POST /api/v1/orders/quote` برای محاسبهٔ سمت‌سرور قیمت جاری محصولات، کرایه و کمیسیون؛ ورودی شامل `businessId`، `addressId` و `items: [{ productId, quantity }]` است.
- پیش‌فاکتور سه دقیقه اعتبارنمایشی دارد، رزرو انجام نمی‌دهد و سفارش/پرداخت قطعی نیست. ایجاد سفارش تا انتخاب روش پرداخت غیرفعال است.

> وضعیت توسعه: فهرست مشتری همچنان از دادهٔ نمونه استفاده می‌کند؛ ساخت سفارش، پرداخت و اتصال checkout به UI هنوز انجام نشده است. کد OTP آزمایشی یا میان‌بر ورود وجود ندارد.

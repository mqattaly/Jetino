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

> وضعیت توسعه: داده‌های صفحهٔ مشتری نمونه‌اند؛ endpoint سفارش، پرداخت و پنل‌های کسب‌وکار/مدیریت هنوز پیاده‌سازی نشده‌اند. کد OTP آزمایشی یا میان‌بر ورود وجود ندارد.

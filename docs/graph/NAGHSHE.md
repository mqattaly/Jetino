# نقشهٔ معماری جتینو

خلاصهٔ فارسیِ گراف دانش پروژه. عددها از `graph.json` گرفته شده‌اند و با هر بازسازی
تازه می‌شوند؛ برای دیدن جزئیات، `graph.html` را باز کنید.

**در یک نگاه:** ۲۰۶۹ گره · ۴۵۲۰ یال · ۱۱۰ جامعه · ۹۶٪ رابطه‌ها استخراج قطعی ·
۱۸ ماژول بک‌اند · ۹ اپ فرانت · ۳۶ جدول و ۴۶ ایندکس دیتابیس.

## شکل کلی

پروژه دو نیمهٔ روشن دارد:

- **بک‌اند (`api/`)** — NestJS با ۱۸ ماژول دامنه: `orders`, `delivery`, `grocery`,
  `businesses`, `drivers`, `identity`, `safety`, `security`, `support`, `wallet`,
  `cancellations`, `notifications`, `addresses`, `partners`, `admin`, `auth`,
  `database`, `health`. هر ماژول الگوی ثابت controller → service → لایهٔ SQL دارد.
- **فرانت (`src/`)** — یک اپ React با ۹ اپ مستقل که با مسیر از هم جدا شده‌اند:
  `App.tsx` (مشتری)، `BusinessMenuApp.tsx`، `DriverApp.tsx`، `GroceryApp.tsx`،
  `GroceryStoreApp.tsx`، `NotificationApp.tsx`، `OperationsApp.tsx`،
  `PartnerJoinApp.tsx`، `AdminApp.tsx`.

و یک لایهٔ داده: ۲۶ مایگریشن که ۳۶ جدول و ۴۶ ایندکس می‌سازند — جدول‌ها در گراف گره
دارند و به کدی که آن‌ها را می‌خواند یا می‌نویسد وصل‌اند.

## گره‌های پرتأثیر (هاب‌های معماری)

هرچه درجهٔ یک گره بالاتر، تغییرش پرخطرتر و فهمیدنش پرارزش‌تر.

| گره | جای تعریف | درجه | یعنی چه |
|---|---|---|---|
| `@nestjs/common` | وابستگی | ۱۰۶ | همهٔ ماژول‌ها، گاردها و دکوراتورها از آن می‌آیند |
| `notify()` | `api/src/notifications/notifications.util.ts:21` | ۵۴ | یک نقطهٔ مشترک برای ساخت اعلان؛ تقریباً همهٔ سرویس‌ها اعلان می‌فرستند |
| `JwtAuthGuard` | `api/src/auth/jwt-auth.guard.ts:8` | ۴۵ | نگهبان توکن روی کنترلرها |
| `GroceryService` | `api/src/grocery/grocery.service.ts:41` | ۴۳ | بزرگ‌ترین سرویس دامنه؛ قلب سوپرمارکت |
| `pg` | وابستگی | ۳۷ | همان لایهٔ اتصال دیتابیس |
| `Roles()` | `api/src/auth/roles.guard.ts:5` | ۳۶ | دکوراتور تعیین نقش مجاز روی مسیرها |
| `react` | وابستگی | ۳۴ | پایهٔ همهٔ کامپوننت‌ها |
| `SkeletonList()` | `src/ui/motion.tsx:75` | ۳۲ | اسکلتون مشترک همهٔ لیست‌های در حال بارگذاری |
| `users` (جدول) | `001_initial.sql:7` | ۳۰ | پرمرجع‌ترین جدول؛ هویت همهٔ نقش‌ها به آن گره خورده |
| `NotificationDeliveryService` | `api/src/notifications/notification-delivery.service.ts:54` | ۲۸ | تحویل واقعی اعلان (درون‌برنامه‌ای/پیامک/پوش) |
| `BusinessesService` | `api/src/businesses/businesses.service.ts` | ۲۷ | منو، نشانی و وضعیت کسب‌وکار |
| `PG_POOL` | `api/src/database/database.module.ts:4` | ۲۷ | استخر اتصال مشترک |
| `RolesGuard` | `api/src/auth/roles.guard.ts` | ۲۴ | اجرای مجوز نقش‌ها |
| `DeliveryService` | `api/src/delivery/delivery.service.ts:30` | ۲۳ | تخصیص پیک، وضعیت و کد تحویل |
| `DriversService` | `api/src/drivers/drivers.service.ts` | ۲۳ | پروفایل و وضعیت پیک |
| `GroceryStoresService` | `api/src/grocery/grocery-stores.service.ts` | ۲۳ | فروشگاه‌های سوپرمارکت |
| `RateLimitService` | `api/src/security/rate-limit.service.ts:18` | ۲۱ | محدودسازی نرخ درخواست‌ها |

سه نکته که همین جدول لو می‌دهد:

1. **امنیت دو دکوراتور جدانشدنی دارد.** `JwtAuthGuard` و `Roles()` تقریباً همیشه با هم
   می‌آیند؛ هر مسیر تازه باید هر دو را داشته باشد، وگرنه یا باز است یا بی‌نقش.
2. **`notify()` نقطهٔ گلوگاه اعلان است.** تغییر امضای آن به‌تنهایی می‌تواند ده‌ها سرویس را
   بشکند — قبل از دست‌زدن به آن، `graphify affected "notify()"` را ببینید.
3. **`GroceryService` از هر سرویس دیگری بزرگ‌تر است.** اگر روزی خواستید سوپرمارکت را
   بازآرایی کنید، این فایل اولین کاندید شکستن به چند سرویس کوچک‌تر است.

## جوامع بزرگ (خوشه‌های مفهومی)

جوامع را الگوریتم خوشه‌بندی ساخته، نه ما؛ پس ممکن است یک مفهوم بین دو جامعه تقسیم شده
باشد (مثلاً «سوپرمارکت» دو جامعه دارد).

| # | نام جامعه | گره | نمونه فایل‌ها |
|---|---|---|---|
| ۱ | سوپرمارکت · بک‌اند | ۹۶ | `grocery.service.ts`, `grocery.controller.ts` |
| ۲ | پشتیبانی · بک‌اند | ۸۱ | `support.controller.ts`, `support.service.ts` |
| ۳ | لغو و بازپرداخت · بک‌اند | ۷۰ | `cancellations.service.ts`, `cancellation-policy.ts` |
| ۴ | مدیریت · بک‌اند | ۵۰ | `roles.guard.ts`, `admin-audit.controller.ts` |
| ۵ | کسب‌وکارها · بک‌اند | ۴۸ | `businesses.service.ts`, `businesses.controller.ts` |
| ۶ | تحویل و پیک · بک‌اند | ۴۷ | `delivery.service.ts`, `delivery.service.spec.ts` |
| ۷ | زیرساخت API · بک‌اند | ۴۵ | `auth.service.spec.ts`, `app-graph.spec.ts` |
| ۸ | پیک‌ها · بک‌اند | ۴۳ | `drivers.controller.ts`, `drivers.service.ts` |
| ۹ | پنل مدیر + حسابرسی عملیات · فرانت | ۴۳ | `AdminAuditLog.tsx`, `AdminApp.tsx`, `AdminBusinessPerformance.tsx` |
| ۱۰ | اعلان‌ها · بک‌اند | ۴۰ | `notification-delivery.util.ts`, `notification-delivery.service.ts`, `notification-delivery.service.spec.ts` |
| ۱۱ | سوپرمارکت · بک‌اند (2) | ۳۹ | `grocery-stores.service.ts`, `grocery-stores.controller.ts` |
| ۱۲ | مدیریت + سوپرمارکت · بک‌اند | ۳۸ | `grocery.service.ts`, `grocery-stores.service.ts`, `notifications.util.ts` |
| ۱۳ | منوی کسب‌وکار + اپ مشتری · فرانت | ۳۸ | `BusinessMenuApp.tsx`, `PartnerJoinApp.tsx`, `controls.tsx` |
| ۱۴ | اپ مشتری + تسویه‌حساب مشتری · فرانت | ۳۷ | `App.tsx`, `CheckoutFlow.tsx`, `catalogImages.ts` |
| ۱۵ | سفارش‌ها · بک‌اند | ۳۶ | `orders.service.ts`, `orders.controller.ts` |
| ۱۶ | ایمنی · بک‌اند | ۳۶ | `safety.service.ts`, `safety.service.spec.ts` |
| ۱۷ | اعلان‌ها · بک‌اند (2) | ۳۳ | `notification-delivery.controller.ts`, `notification-delivery.service.ts` |
| ۱۸ | مدیریت سوپرمارکت · فرانت | ۳۳ | `AdminGroceryReports.tsx`, `AdminGrocery.tsx`, `AdminGroceryStores.tsx` |
| ۱۹ | نشانی‌ها · بک‌اند | ۳۲ | `health.controller.ts`, `addresses.controller.ts` |
| ۲۰ | اعلان‌ها · بک‌اند (3) | ۳۱ | `push-sender.ts`, `notification-delivery.service.ts` |
| ۲۱ | امنیت · بک‌اند | ۳۱ | `security.util.ts`, `orders.service.ts`, `cancellation-writes.ts` |
| ۲۲ | نشانی‌ها · بک‌اند (2) | ۲۷ | `addresses.service.ts`, `addresses.controller.ts` |
| ۲۳ | هویت و زحل · بک‌اند | ۲۷ | `zohal.service.ts`, `zohal.service.spec.ts` |
| ۲۴ | اعلان‌ها · فرانت | ۲۷ | `NotificationApp.tsx`, `motion.tsx` |

۲۶ جامعهٔ کوچک (کمتر از ۲۰ گره) در فهرست بالا نیامده‌اند؛ همهٔ ۱۱۰ جامعه در
`graph.html` با فیلتر جامعه دیده می‌شوند.

## نمونهٔ پیمایش

پرسش: «`GroceryService` به چه چیزی وصل است؟»

```text
$ graphify explain "GroceryService" --graph docs/graph/graph.json
Node: GroceryService  (api/src/grocery/grocery.service.ts:41, 43 یال)
Community: سوپرمارکت · بک‌اند
  <-- grocery.controller.ts        [imports]      کنترلر مشتری آن را صدا می‌زند
  <-- grocery-admin.controller.ts  [imports]      کنترلر مدیر
  <-- grocery.module.ts            [imports]      ثبت در ماژول
  --> .detailFor() .settings() .submitInvoice() … [method] متدهای خودش
```

یعنی برای فهم جریان سوپرمارکت، از این یک گره می‌شود به کنترلر مشتری، کنترلر مدیر و
ماژول رسید — بدون باز کردن دستی پوشه‌ها.

## پرسش‌هایی که این گراف خوب جواب می‌دهد

- «اگر امضای این تابع را عوض کنم، چه چیزهایی می‌شکند؟» → `affected`
- «این مسیر API از کدام سرویس و کدام جدول می‌گذرد؟» → `path` / `explain`
- «کدام فایل‌ها بیشترین وابستگی متقابل را دارند؟» → `god-nodes` و جوامع
- «جدول `users` را چند جا مستقیم صدا می‌زنیم؟» → `affected users`

## نگهداری

بعد از هر تغییر کد، گراف را تازه کنید:

```bash
graphify update .                              # سریع، افزایشی
bash scripts/graph/build-graph.sh              # کامل + نام‌های فارسی
```

راهنمای کامل فایل‌ها و دستورها: `docs/graph/README.md`.

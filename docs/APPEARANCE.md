# ظاهر جتینو: پالت شب روشن، انتخاب‌گر تم و صفحهٔ طراحی

این فایل مرجع ظاهر تازهٔ اپ است: از کدام تصویر الهام گرفته، رنگ‌ها کجا تعریف شده‌اند،
تم چطور ذخیره می‌شود و برای تغییر هر بخش کدام فایل را باید دید.

## ۱) پالت

پالت از تصویر ارسالی گرفته شده: پس‌زمینهٔ سرمه‌ای، سطوح کمی روشن‌تر، متن یخی،
و یک رنگ اصلی (پیش‌فرض زرشکی) که کاربر می‌تواند عوض کند.

| نقش | تیره | روشن |
|---|---|---|
| `--canvas` | `#0a1420` | `#f2f6fb` |
| `--surface` | `#0f1f30` | `#ffffff` |
| `--surface-2` | `#14283b` | `#eef3f9` |
| `--ink` | `#edf5fc` | `#0f1b2a` |
| `--muted` | `#93a9bd` | `#5a6b7d` |
| `--line` | `rgba(255,255,255,.09)` | `rgba(16,32,52,.1)` |

پنج رنگ اصلی روی همین پالت سوار می‌شوند: `crimson` (پیش‌فرض)، `cyan`، `teal`،
`orange`، `magenta`. هر رنگ با `data-accent` روی `<html>` فعال می‌شود و
`--brand/--brand-bright/--brand-soft/--brand-ink` را بازنویسی می‌کند.

همهٔ توکن‌ها در `src/next.css` هستند و این فایل **آخرین** لایهٔ CSS است
(ترتیب در `src/main.tsx`: `tokens.css → style.css → theme.css → next.css`)،
پس هر جا صفحه‌ای قدیمی رنگ ثابت دارد، همین فایل آن را با توکن هم‌خوان می‌کند.

## ۲) تم روشن / تیره / خودکار

- کلیدهای ذخیره: `jetino.theme.v2` و `jetino.accent.v2` در `localStorage`.
- پیش‌فرض: `auto` (پیروی از `prefers-color-scheme`) + زرشکی.
- `src/ui/theme.tsx` صفت‌های `data-theme`، `data-theme-mode` و `data-accent` را روی
  `<html>` می‌گذارد و متای `theme-color` را هم به‌روز می‌کند.
- `index.html` یک اسکریپت کوچک پیش از اولین paint دارد تا فلش تم روشن رخ ندهد.
- کنترل شناور «ظاهر» (`ThemeDock`) در `main.tsx` کنار اپ سوار می‌شود؛ روی موبایل
  بالای نوار پایین می‌نشیند. همان انتخاب‌گر در صفحهٔ `/design` هم هست.

## ۳) اجزای تازه

| فایل | چه چیزی |
|---|---|
| `src/ui/theme.tsx` | `ThemeProvider`, `useTheme`, `ThemePicker`, `ThemeDock` |
| `src/ui/controls.tsx` | `ActionButton` (آیکون + نوشته، سه حالت)، `TileButton`، `StatTile` |
| `src/DesignGallery.tsx` | صفحهٔ `/design`: انتخاب‌گر تم، هیرو، کلیدها، کاشی‌ها، وضعیت‌ها، پالت |
| `public/images/hero-night.jpg` | تصویر هیرو (تولیدشده در همین مخزن؛ هیچ CDN بیرونی) |

آیکون‌ها از `lucide-react` می‌آیند؛ همهٔ تصویرسازی‌ها یا در `public/images` هستند
یا با SVG/گرادیان در CSS ساخته شده‌اند. هیچ asset بیرونی بار نمی‌شود.

## ۴) قواعد حرکت

- `--ease` و `--spring` برای همهٔ ترنزیشن‌ها؛ `--t-fast/base/slow` برای مدت.
- دکمه‌ها: بالا آمدن ۲ پیکسل + سایهٔ رنگی؛ آیکون کمی بزرگ و چرخیده می‌شود.
- کاشی‌های «اکشن سریع» هر کدام آیکون در چیپ رنگی خودشان دارند (زرشکی/فیروزه‌ای/آبی/نارنجی/ارغوانی).
- ورود هیرو/اکشن‌ها/نوار اعتماد با `rise-in`؛ در `prefers-reduced-motion` خاموش می‌شود.

## ۵) عکس‌های مرجع

- `docs/screenshots/storefront-dark.jpg` — فروشگاه، تم تیره
- `docs/screenshots/design-page-dark.jpg` و `design-page-light.jpg` — صفحهٔ `/design`
- `docs/screenshots/storefront-mobile.jpg` — فروشگاه روی موبایل
- `docs/screenshots/driver-login-dark.jpg` — ورود پیک با افق شبانه

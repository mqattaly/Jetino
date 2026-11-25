#!/bin/sh
# ورودی کانتینر جتینو: اول مایگریشن‌ها، بعد سرور.
#
# چرا مایگریشن در زمان اجرا و نه build؟ تصویر نباید به دیتابیس تولیدی وابسته باشد؛ یک
# تصویر باید روی هر دیتابیسی اجرا شود. اجرای دوباره بی‌خطر است چون یک ledger
# (`schema_migrations`) دارد و هر مایگریشن فقط یک‌بار اعمال می‌شود.
set -e

MIGRATIONS_RETRIES="${MIGRATIONS_RETRIES:-10}"
MIGRATIONS_RETRY_DELAY="${MIGRATIONS_RETRY_DELAY:-6}"

cd /app/api

if [ "${SKIP_MIGRATIONS:-0}" = "1" ]; then
  echo "→ SKIP_MIGRATIONS=1: پرش از مایگریشن"
else
  attempt=1
  until node dist/database/migrate.js; do
    if [ "$attempt" -ge "$MIGRATIONS_RETRIES" ]; then
      echo "✖ مایگریشن پس از $attempt تلاش شکست خورد؛ سرور بالا نمی‌آید." >&2
      exit 1
    fi
    echo "… مایگریشن شکست خورد (تلاش $attempt/$MIGRATIONS_RETRIES)؛ ${MIGRATIONS_RETRY_DELAY}s بعد دوباره"
    attempt=$((attempt + 1))
    sleep "$MIGRATIONS_RETRY_DELAY"
  done
fi

# سرویس کرون همین تصویر را با یک دستور دلخواه اجرا می‌کند
# (مثلاً: node dist/notifications/dispatch-cron.js) و نباید سرور HTTP بالا بیاورد
if [ "$#" -gt 0 ]; then
  # پنل‌ها دستور را گاهی یک رشتهٔ کامل می‌فرستند («node dist/...»)، نه آرگومان‌های جدا
  if [ "$#" -eq 1 ] && [ "${1#* }" != "$1" ]; then
    echo "→ اجرای دستور: $1"
    exec sh -c "$1"
  fi
  echo "→ اجرای دستور: $*"
  exec "$@"
fi

echo "→ راه‌اندازی سرور روی پورت ${PORT:-3000}"
exec node dist/main.js

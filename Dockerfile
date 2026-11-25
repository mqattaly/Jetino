# جتینو در یک کانتینر: API + رابط کاربری روی یک دامنه.
#
# چرا تک‌سرویس؟ فرانت‌اند همهٔ درخواست‌ها را نسبت به `/api/v1` می‌فرستد؛ اگر API و سایت
# یک origin باشند، نه CORS لازم است، نه آدرس مطلق در زمان build، و نه کوکی/service worker
# جدا. برای چابکان همین مسیر انتخاب شده است (docs/DEPLOY-CHABOKAN.md).
#
# ساخت:  docker build --build-arg VITE_NESHAN_API_KEY=... -t jetino .
# اجرا:  docker run -p 3000:3000 -e DATABASE_URL=... -e JWT_SECRET=... jetino

# ---------- مرحلهٔ ۱: نصب وابستگی‌ها و build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NODE_ENV=development \
    npm_config_fund=false \
    npm_config_audit=false

# لایه‌های وابستگی جدا می‌مانند تا تغییر کد باعث نصب دوباره نشود
COPY package.json package-lock.json ./
COPY api/package.json api/package-lock.json ./api/
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund && npm --prefix api ci --no-audit --no-fund

COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY vite.config.ts index.html ./
COPY src ./src
COPY public ./public

# کلید عمومی نقشه در زمان build داخل باندل می‌رود (متغیر Vite است، نه runtime)
ARG VITE_NESHAN_API_KEY=""
ENV VITE_NESHAN_API_KEY=${VITE_NESHAN_API_KEY}

RUN npm run build && npm --prefix api run build

# ---------- مرحلهٔ ۲: اجرا ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    STATIC_DIR=/app/public

# فقط وابستگی‌های runtime بک‌اند نصب می‌شوند (typescript/tsx و ابزار تست وارد تصویر نمی‌شوند)
COPY api/package.json api/package-lock.json ./api/
RUN npm --prefix api ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/dist ./public
# مایگریشن‌ها در زمان build اجرا نمی‌شوند؛ اسکریپت ورود، پیش از بالا آمدن سرور اجرایشان می‌کند
COPY api/src/database/migrations ./api/src/database/migrations
COPY scripts/docker-entrypoint.sh /usr/local/bin/jetino-entrypoint

RUN chmod +x /usr/local/bin/jetino-entrypoint
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/jetino-entrypoint"]

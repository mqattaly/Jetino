/**
 * Vercel entry point for the Jetino API.
 *
 * The API is a long-running Nest application; on Vercel it runs inside a single Node function, which
 * boots it once per instance and forwards requests into the same Express instance `npm run start` uses
 * locally. The requires below are literal relative paths on purpose: they are what the bundler follows
 * at build time, and api/dist is built by the install step (scripts/vercel-build.cjs).
 */
require('../api/node_modules/reflect-metadata');

let expressApp = null;
let booting = null;

async function boot() {
  const { NestFactory } = require('../api/node_modules/@nestjs/core');
  const { AppModule } = require('../api/dist/app.module.js');
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api/v1');
  const origins = (process.env.CORS_ORIGIN ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  app.enableCors({ origin: origins.length ? origins : true });
  await app.init();
  return app.getHttpAdapter().getInstance();
}

async function ready() {
  if (!expressApp) {
    booting = boot().then((instance) => {
      expressApp = instance;
      return instance;
    });
  }
  return expressApp ?? booting;
}

module.exports = async function handler(req, res) {
  // a rewrite keeps the original URL, but a route that points straight at the function does not
  if (!/^\/api\/v1(\/|$)/.test(req.url ?? '')) {
    const [pathname, query] = (req.url ?? '/').split('?');
    const tail = pathname.replace(/^\/api/, '').replace(/^\//, '');
    req.url = `/api/v1${tail ? `/${tail}` : ''}${query ? `?${query}` : ''}`;
  }
  try {
    return await (await ready())(req, res);
  } catch (error) {
    console.error('jetino serverless boot failed', error);
    if (!res.headersSent) res.statusCode = 503;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ statusCode: 503, message: 'سرویس در حال آماده‌سازی است؛ لطفاً دوباره تلاش کنید.' }));
  }
};

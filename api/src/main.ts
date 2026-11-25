import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { raw, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppModule } from './app.module';

/**
 * Files that must never be cached: the shell, the manifest and the service worker. A stale
 * service worker or a cached `index.html` keeps pointing at asset names that no longer exist
 * after a deploy, and the app looks broken until the user clears storage.
 */
const NO_STORE = new Set(['index.html', 'sw.js', 'manifest.webmanifest', 'favicon.ico']);

function cacheHeaders(res: Response, filePath: string): void {
  const name = filePath.split('/').pop() ?? '';
  if (NO_STORE.has(name)) {
    res.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
  } else if (filePath.includes('/assets/')) {
    // Vite fingerprints everything under assets/, so a year is safe
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('cache-control', 'public, max-age=3600');
  }
  res.setHeader('x-content-type-options', 'nosniff');
}

async function bootstrap() {
  // route-mapping chatter is useful while developing and pure noise in a platform log viewer
  const logger = process.env.NODE_ENV === 'production' ? (['error', 'warn'] as const) : undefined;
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: logger ? [...logger] : undefined });
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? false });
  // behind the platform's proxy the client address arrives in X-Forwarded-For; without this the
  // app would log and rate limit every request as the proxy itself
  app.set('trust proxy', 1);
  // The biometric selfie video is raw binary on one route only: the platform caps a request at
  // 4.5 MB, and JSON/base64 would waste a third of that budget. Everything else stays JSON.
  app.use('/api/v1/drivers/me/identity/biometric', raw({ type: ['video/webm', 'video/mp4', 'video/quicktime'], limit: '4.2mb' }));

  /**
   * One container serves both halves of the product when STATIC_DIR points at the built
   * frontend (Docker on Chabakan). The frontend calls `/api/v1/...` relatively, so a single
   * origin keeps CORS, cookies and the service worker out of the picture entirely.
   * Locally STATIC_DIR is unset and Vite keeps serving the UI.
   */
  const staticDir = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : '';
  const servesStatic = Boolean(staticDir) && existsSync(join(staticDir, 'index.html'));

  if (servesStatic) {
    app.useStaticAssets(staticDir, { index: false, etag: true, setHeaders: cacheHeaders });
  } else if (staticDir) {
    console.warn(`STATIC_DIR=${staticDir} has no index.html — the API will run without the UI`);
  }

  if (servesStatic) {
    const indexFile = join(staticDir, 'index.html');
    /**
     * Client-side routes (`/admin`, `/driver`, …) have no file behind them, so the shell has to
     * answer them. This runs *before* the Nest router on purpose: whatever Nest registers for
     * unmatched paths ends the response with a JSON 404, so a handler added afterwards never runs.
     * `/api/*` and anything that looks like a file (has an extension) are left alone — a missing
     * asset must stay a 404, not turn into an HTML page with a 200.
     */
    app.use((req: { method: string; path: string }, res: Response, next: () => void) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path === '/api' || req.path.startsWith('/api/')) return next();
      if (/\.[a-z0-9]+$/i.test(req.path)) return next();
      res.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
      res.sendFile(indexFile, (error?: Error) => {
        if (error) next();
      });
    });
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`Jetino API listening on :${port}/api/v1${servesStatic ? ' (+ UI)' : ''}`);
}
void bootstrap();

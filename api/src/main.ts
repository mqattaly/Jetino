import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { raw } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? false });
  // The biometric selfie video is raw binary on one route only: the platform caps a request at
  // 4.5 MB, and JSON/base64 would waste a third of that budget. Everything else stays JSON.
  app.use('/api/v1/drivers/me/identity/biometric', raw({ type: ['video/webm', 'video/mp4', 'video/quicktime'], limit: '4.2mb' }));
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`Jetino API listening on :${port}/api/v1`);
}
void bootstrap();

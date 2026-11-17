import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { BusinessesModule } from './businesses/businesses.module';

@Module({ imports: [DatabaseModule, AuthModule, BusinessesModule], controllers: [HealthController] })
export class AppModule {}

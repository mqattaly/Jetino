import { Module } from '@nestjs/common';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminSettingsService } from './admin-settings.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';

@Module({ controllers: [AdminSettingsController], providers: [AdminSettingsService, JwtAuthGuard, RolesGuard] })
export class AdminModule {}

import { Module } from '@nestjs/common';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminSettingsService } from './admin-settings.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { AdminBusinessesController } from './admin-businesses.controller';
import { AdminBusinessesService } from './admin-businesses.service';

@Module({ controllers: [AdminSettingsController, AdminBusinessesController], providers: [AdminSettingsService, AdminBusinessesService, JwtAuthGuard, RolesGuard] })
export class AdminModule {}

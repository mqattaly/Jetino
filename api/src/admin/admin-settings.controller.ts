import { Body, Controller, Get, Inject, Patch, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AdminSettingsService } from './admin-settings.service';

type AdminRequest = Request & { user: { sub: string; roles: string[] } };

@Controller('admin/settings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class AdminSettingsController {
  constructor(@Inject(AdminSettingsService) private readonly settings: AdminSettingsService) {}

  @Get()
  get() { return this.settings.get(); }

  @Patch()
  update(@Req() request: AdminRequest, @Body() body: { deliveryFeeRial?: unknown; defaultCommissionBps?: unknown }) {
    return this.settings.update(request.user, body);
  }
}

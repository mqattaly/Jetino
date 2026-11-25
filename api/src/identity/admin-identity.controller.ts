import { Controller, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { DriverIdentityService } from './driver-identity.service';

type AdminRequest = Request & { user: { sub: string; roles: string[] } };

/** When a courier phones in stuck on «در حال بررسی», support can ask the provider once more. */
@Controller('admin/drivers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminIdentityController {
  constructor(@Inject(DriverIdentityService) private readonly identity: DriverIdentityService) {}

  @Post(':id/identity/refresh')
  @HttpCode(200)
  @Roles('SUPER_ADMIN', 'OPERATIONS_MANAGER', 'SUPPORT')
  refresh(@Req() req: AdminRequest, @Param('id') id: string) {
    return this.identity.adminRefresh(id);
  }
}

import { Controller, Get, Inject, Patch, Param, Query, Req, Body, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AdminBusinessesService } from './admin-businesses.service';

type AdminRequest = Request & { user: { sub: string; roles: string[] } };
@Controller('admin/businesses')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class AdminBusinessesController {
  constructor(@Inject(AdminBusinessesService) private readonly businesses: AdminBusinessesService) {}
  @Get() list(@Query('status') status?: string) { return this.businesses.list(status); }
  @Patch(':id/status') status(@Req() req: AdminRequest, @Param('id') id: string, @Body() body: { status?: unknown }) {
    return this.businesses.setStatus(req.user,id,body?.status);
  }
}

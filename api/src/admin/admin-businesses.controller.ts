import { Controller, Get, Inject, Patch, Post, Param, Query, Req, Body, UseGuards } from '@nestjs/common';
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
  @Post() create(@Req() req: AdminRequest,@Body() body: {phone?:unknown;name?:unknown;description?:unknown;regionSlug?:unknown;addressText?:unknown;contactPhone?:unknown;workingHours?:unknown;applicationKey?:unknown}) { return this.businesses.create(req.user,body ?? {}); }
  @Get() list(@Query('status') status?: string) { return this.businesses.list(status); }
  @Patch(':id/status') status(@Req() req: AdminRequest, @Param('id') id: string, @Body() body: { status?: unknown; note?: unknown }) {
    return this.businesses.setStatus(req.user,id,body?.status,body?.note);
  }
}

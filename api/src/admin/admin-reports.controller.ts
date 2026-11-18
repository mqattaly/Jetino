import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AdminReportsService } from './admin-reports.service';

type AdminRequest = Request & { user: { sub: string; roles: string[] } };

@Controller('admin/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class AdminReportsController {
  constructor(@Inject(AdminReportsService) private readonly reports: AdminReportsService) {}

  @Get('summary') summary(@Query('period') period?: string) { return this.reports.summary(period); }
  @Get('cash-outstanding') cashOutstanding() { return this.reports.cashOutstanding(); }
  @Post('settlements') settle(@Req() req: AdminRequest, @Body() body: { driverId?: unknown; expectedAmountRial?: unknown; note?: unknown }) {
    return this.reports.settle({ sub: req.user.sub }, body?.driverId, body?.expectedAmountRial, body?.note);
  }
}

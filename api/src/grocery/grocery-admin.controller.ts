import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { GroceryService } from './grocery.service';

type AdminRequest = Request & { user: { sub: string; roles: string[] } };

/** The staff side of the grocery phase: prepaid-fee queue, settings, and the receipt check. */
@Controller('admin/grocery')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'OPERATIONS_MANAGER')
export class GroceryAdminController {
  constructor(@Inject(GroceryService) private readonly grocery: GroceryService) {}

  @Get('receipts') receipts(@Req() req: AdminRequest) { return this.grocery.staffReceipts(req.user); }
  @Post('lists/:id/fee/confirm') confirmFee(@Req() req: AdminRequest, @Param('id') id: string) {
    return this.grocery.confirmFeePayment(req.user, id);
  }
  @Get('reports') reports(@Req() req: AdminRequest, @Query('from') from?: string, @Query('to') to?: string) {
    return this.grocery.reports(req.user, from, to);
  }
  @Get('reports.csv') async reportsCsv(@Req() req: AdminRequest, @Res() res: Response, @Query('from') from?: string, @Query('to') to?: string) {
    const file = await this.grocery.reportsCsv(req.user, from, to);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(file.body);
  }
  @Get('settings') settings(@Req() req: AdminRequest) { return this.grocery.adminSettings(req.user); }
  @Patch('settings') updateSettings(@Req() req: AdminRequest, @Body() body: Record<string, unknown>) {
    return this.grocery.updateAdminSettings(req.user, body ?? {});
  }
}

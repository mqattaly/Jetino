import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
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
  @Get('settings') settings(@Req() req: AdminRequest) { return this.grocery.adminSettings(req.user); }
  @Patch('settings') updateSettings(@Req() req: AdminRequest, @Body() body: Record<string, unknown>) {
    return this.grocery.updateAdminSettings(req.user, body ?? {});
  }
}

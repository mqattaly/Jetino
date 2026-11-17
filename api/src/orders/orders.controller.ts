import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OrdersService } from './orders.service';

type AuthRequest = Request & { user: { sub: string; roles: string[] } };
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}
  @Post('quote') quote(@Req() req: AuthRequest, @Body() body: { businessId?: unknown; addressId?: unknown; items?: unknown }) { return this.orders.quote(req.user,body); }
  @Post() create(@Req() req: AuthRequest, @Body() body: { businessId?: unknown; addressId?: unknown; items?: unknown; paymentMethod?: unknown }, @Headers('idempotency-key') key?: string) { return this.orders.create(req.user,body,key); }
  @Get('business/mine') businessMine(@Req() req: AuthRequest) { return this.orders.businessOrders(req.user); }
  @Get('mine') mine(@Req() req: AuthRequest) { return this.orders.mine(req.user); }
  @Post(':id/cancel') cancel(@Req() req: AuthRequest, @Param('id') id: string) { return this.orders.cancel(req.user,id); }
  @Patch(':id/status') status(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: { status?: unknown }) { return this.orders.businessTransition(req.user,id,body?.status); }
  @Get(':id') detail(@Req() req: AuthRequest, @Param('id') id: string) { return this.orders.detail(req.user,id); }
}

import { Body, Controller, Inject, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OrdersService } from './orders.service';

type AuthRequest = Request & { user: { sub: string; roles: string[] } };
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}
  @Post('quote') quote(@Req() req: AuthRequest, @Body() body: { businessId?: unknown; addressId?: unknown; items?: unknown }) { return this.orders.quote(req.user,body); }
}

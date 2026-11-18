import { Controller, Get, Inject, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DeliveryService } from './delivery.service';

type DeliveryRequest = Request & { user: { sub: string; roles: string[] } };

@Controller('delivery')
@UseGuards(JwtAuthGuard)
export class DeliveryController {
  constructor(@Inject(DeliveryService) private readonly delivery: DeliveryService) {}

  @Get('orders/:orderId/estimate')
  estimate(@Req() request: DeliveryRequest, @Param('orderId') orderId: string) {
    return this.delivery.estimateForOrder(request.user, orderId);
  }
}

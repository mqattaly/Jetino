import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { CancellationsService } from './cancellations.service';

type AuthedRequest = Request & { user: { sub: string; roles: string[] } };
const principal = (req: AuthedRequest) => ({ sub: req.user.sub, roles: req.user.roles ?? [] });

/**
 * §7.11 surfaces. The request itself is filed on the order (`POST /orders/:id/cancel`); what lives
 * here is everything around it: the rules, the queue a human works through, and the refund ledger.
 */
@Controller('cancellations')
@UseGuards(JwtAuthGuard)
export class CancellationsController {
  constructor(@Inject(CancellationsService) private readonly cancellations: CancellationsService) {}

  @Get('policy') policy() { return this.cancellations.policy(); }

  /** The customer, the shop and the courier all read the same shape: is anything still open? */
  @Get('orders/:orderId') forOrder(@Req() req: AuthedRequest, @Param('orderId') orderId: string) { return this.cancellations.forOrder(principal(req), orderId); }
  @Get('orders/:orderId/refunds') refunds(@Req() req: AuthedRequest, @Param('orderId') orderId: string) { return this.cancellations.refunds(principal(req), orderId); }

  @Patch('policy')
  @UseGuards(RolesGuard)
  @Roles('SUPER_ADMIN')
  setPolicy(@Req() req: AuthedRequest, @Body() body: { autoCancelStatuses?: unknown; windowMinutes?: unknown }) { return this.cancellations.setPolicy(principal(req), body ?? {}); }

  @Get('queue')
  @UseGuards(RolesGuard)
  @Roles('SUPER_ADMIN', 'OPERATIONS_MANAGER')
  queue(@Req() req: AuthedRequest, @Query('outcome') outcome?: string, @Query('search') search?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.cancellations.queue({ outcome, search, limit, offset });
  }

  /** The shop that owns the order answers its own queue; anything else needs operations. */
  @Patch('requests/:id') decide(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { decision?: unknown; note?: unknown }) {
    return this.cancellations.decideRequest(principal(req), id, body ?? {});
  }

  @Post('orders/:orderId/refunds')
  @UseGuards(RolesGuard)
  @Roles('SUPER_ADMIN', 'OPERATIONS_MANAGER')
  recordRefund(@Req() req: AuthedRequest, @Param('orderId') orderId: string, @Body() body: { amountRial?: unknown; reason?: unknown; fundedBy?: unknown }) {
    return this.cancellations.recordRefund(principal(req), orderId, body ?? {});
  }
}

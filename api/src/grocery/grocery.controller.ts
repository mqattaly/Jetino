import { Body, Controller, Get, Headers, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { GroceryService } from './grocery.service';

type AuthRequest = Request & { user: { sub: string; roles: string[] } };

/**
 * The text-shopping missions. `/board` is the courier's side, everything under `/lists` is shared
 * by the customer who wrote the list, the courier who took it, and staff.
 */
@Controller('grocery')
@UseGuards(JwtAuthGuard)
export class GroceryController {
  constructor(@Inject(GroceryService) private readonly grocery: GroceryService) {}

  @Post('lists') create(@Req() req: AuthRequest, @Body() body: { itemsText?: unknown; storeName?: unknown; storeId?: unknown; note?: unknown; addressId?: unknown }, @Headers('idempotency-key') key?: string) {
    return this.grocery.create(req.user, body ?? {}, key);
  }
  @Get('lists/mine') mine(@Req() req: AuthRequest) { return this.grocery.mine(req.user); }
  @Get('lists/:id') detail(@Req() req: AuthRequest, @Param('id') id: string) { return this.grocery.detail(req.user, id); }
  @Post('lists/:id/bids') bid(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: { amountRial?: unknown; note?: unknown }) {
    return this.grocery.bid(req.user, id, body ?? {});
  }
  @Post('lists/:id/bids/:bidId/accept') accept(@Req() req: AuthRequest, @Param('id') id: string, @Param('bidId') bidId: string) {
    return this.grocery.acceptBid(req.user, id, bidId);
  }
  @Post('lists/:id/invoice') invoice(@Req() req: AuthRequest, @Param('id') id: string,
    @Body() body: { amountRial?: unknown; storeCard?: unknown; storeHolder?: unknown; photoUrl?: unknown; items?: unknown }) {
    return this.grocery.submitInvoice(req.user, id, body ?? {});
  }
  @Post('lists/:id/invoice/approve') approve(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.grocery.approveInvoice(req.user, id);
  }
  @Post('lists/:id/payment') pay(@Req() req: AuthRequest, @Param('id') id: string,
    @Body() body: { method?: unknown; receiptUrl?: unknown; reference?: unknown }) {
    return this.grocery.declarePayment(req.user, id, body ?? {});
  }
  @Post('lists/:id/payment/confirm') confirm(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.grocery.confirmPayment(req.user, id);
  }
  @Post('lists/:id/status') status(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: { status?: unknown; reason?: unknown }) {
    return this.grocery.transition(req.user, id, body?.status, body?.reason);
  }
  @Post('lists/:id/cancel') cancel(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: { reason?: unknown }) {
    return this.grocery.cancel(req.user, id, body?.reason);
  }
  @Post('lists/:id/fee-payment') feePayment(@Req() req: AuthRequest, @Param('id') id: string,
    @Body() body: { method?: unknown; receiptUrl?: unknown; reference?: unknown }) {
    return this.grocery.declareFeePayment(req.user, id, body ?? {});
  }
  @Post('lists/:id/invoice/reject') rejectInvoice(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: { reason?: unknown }) {
    return this.grocery.rejectInvoice(req.user, id, body?.reason);
  }
  @Post('lists/:id/deadline/extend') extend(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: { kind?: unknown }) {
    return this.grocery.extendDeadline(req.user, id, body?.kind);
  }
  @Get('payment-destination') destination(@Req() req: AuthRequest) { return this.grocery.paymentDestination(req.user); }
  @Get('board') board(@Req() req: AuthRequest) { return this.grocery.courierBoard(req.user); }
}

import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { FeedbackService } from './feedback.service';
import { SupportService } from './support.service';

type AuthedRequest = Request & { user: { sub: string; roles: string[] } };
const principal = (req: AuthedRequest) => ({ sub: req.user.sub, roles: req.user.roles ?? [] });

/** Ratings and complaints are read through the order they belong to, never by id guessing. */
@Controller('orders/:orderId/feedback')
@UseGuards(JwtAuthGuard)
export class OrderFeedbackController {
  constructor(@Inject(FeedbackService) private readonly feedback: FeedbackService) {}

  @Get() read(@Req() req: AuthedRequest, @Param('orderId') orderId: string) { return this.feedback.forOrder(principal(req), orderId); }
  @Put() save(@Req() req: AuthedRequest, @Param('orderId') orderId: string, @Body() body: { businessRating?: unknown; driverRating?: unknown; comment?: unknown }) {
    return this.feedback.save(principal(req), orderId, body ?? {});
  }
}

@Controller('feedback')
@UseGuards(JwtAuthGuard)
export class FeedbackQueryController {
  constructor(@Inject(FeedbackService) private readonly feedback: FeedbackService) {}

  /** A shop owner reads their own score; the service itself proves ownership. */
  @Get('businesses/:businessId') forBusiness(@Req() req: AuthedRequest, @Param('businessId') businessId: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.feedback.forBusiness(principal(req), businessId, limit, offset);
  }

  @Get('drivers/me') forDriver(@Req() req: AuthedRequest, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.feedback.forDriver(principal(req), limit, offset);
  }
}

/** Moderation is staff-only: reading the whole corpus and deleting an entry from it. */
@Controller('feedback/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'OPERATIONS_MANAGER')
export class FeedbackAdminController {
  constructor(@Inject(FeedbackService) private readonly feedback: FeedbackService) {}

  @Get() queue(@Req() req: AuthedRequest, @Query('maxStars') maxStars?: string, @Query('businessId') businessId?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.feedback.listForStaff({ maxStars, businessId, limit, offset });
  }

  @Delete(':id') remove(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { reason?: unknown }) {
    return this.feedback.remove(principal(req), id, body?.reason);
  }
}

@Controller('support/tickets')
@UseGuards(JwtAuthGuard)
export class SupportTicketController {
  constructor(@Inject(SupportService) private readonly support: SupportService) {}

  @Get('mine') mine(@Req() req: AuthedRequest, @Query('status') status?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.support.mine(principal(req), { status, limit, offset });
  }

  @Get('admin/queue')
  @UseGuards(RolesGuard)
  @Roles('SUPER_ADMIN', 'OPERATIONS_MANAGER')
  queue(@Req() req: AuthedRequest, @Query('status') status?: string, @Query('search') search?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.support.queue({ status, search, limit, offset });
  }

  @Get(':id') detail(@Req() req: AuthedRequest, @Param('id') id: string) { return this.support.detail(principal(req), id); }
  @Post() open(@Req() req: AuthedRequest, @Body() body: { orderId?: unknown; message?: unknown }) { return this.support.open(principal(req), body ?? {}); }
  @Post(':id/messages') reply(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { message?: unknown }) { return this.support.reply(principal(req), id, body ?? {}); }
  @Patch(':id/status') status(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { status?: unknown; note?: unknown }) { return this.support.setStatus(principal(req), id, body ?? {}); }
}

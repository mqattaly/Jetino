import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { NotificationDeliveryService } from './notification-delivery.service';
import { PUSH_CRON_HEADER } from './notification-delivery.util';

type AuthRequest = Request & { user: { sub: string; roles: string[] } };

const REVIEW_ROLES = ['OPERATIONS_MANAGER', 'SUPER_ADMIN'];

/**
 * §7.12 surfaces. A customer may only read the delivery state of their own inbox row and register
 * their own browser; the queue, the counters and the manual retry are staff-only. The scheduler
 * route carries no session at all, so it authenticates with CRON_SECRET instead.
 */
@Controller('notifications')
export class NotificationDeliveryController {
  constructor(private readonly deliveries: NotificationDeliveryService) {}

  @Get('push/config')
  @UseGuards(JwtAuthGuard)
  config() {
    return this.deliveries.pushConfig();
  }

  @Post('push/subscription')
  @UseGuards(JwtAuthGuard)
  subscribe(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.deliveries.upsertSubscription(req.user.sub, body);
  }

  @Delete('push/subscription')
  @UseGuards(JwtAuthGuard)
  unsubscribe(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.deliveries.unsubscribe(req.user.sub, body);
  }

  @Get('push/subscriptions')
  @UseGuards(JwtAuthGuard)
  subscriptions(@Req() req: AuthRequest) {
    return this.deliveries.listMySubscriptions(req.user.sub);
  }

  @Get('push/preferences')
  @UseGuards(JwtAuthGuard)
  preferences(@Req() req: AuthRequest) {
    return this.deliveries.getPreferences(req.user.sub);
  }

  /** PUT semantics: the body carries the groups the user *wants*; every other group is muted. */
  @Put('push/preferences')
  @UseGuards(JwtAuthGuard)
  setPreferences(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.deliveries.setPreferences(req.user.sub, body);
  }

  @Get(':id/delivery')
  @UseGuards(JwtAuthGuard)
  deliveryFor(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.deliveries.deliveryForNotification(req.user.sub, id);
  }

  @Get('delivery/stats')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...REVIEW_ROLES)
  stats() {
    return this.deliveries.stats();
  }

  @Get('delivery/queue')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...REVIEW_ROLES)
  queue(@Query('state') state?: string) {
    return this.deliveries.recentDeliveries(state);
  }

  @Post('delivery/:id/retry')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...REVIEW_ROLES)
  retry(@Param('id') id: string) {
    return this.deliveries.retryDelivery(id);
  }

  @Post('dispatch')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...REVIEW_ROLES)
  dispatchStaff(@Body() body: unknown) {
    return this.deliveries.dispatch(readLimit(body));
  }

  /** Vercel cron (and any other scheduler): GET with `Authorization: Bearer ${CRON_SECRET}`. */
  @Get('dispatch')
  @HttpCode(200)
  dispatchCron(@Req() req: Request, @Query('limit') limit?: string) {
    if (!cronAuthorized(req)) throw new ForbiddenException('کلید زمان‌بندی اعلان‌ها معتبر نیست.');
    return this.deliveries.dispatch(readLimit({ limit }));
  }
}

function readLimit(body: unknown): number {
  const value = (body as { limit?: unknown } | null)?.limit;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 50;
}

/**
 * Without CRON_SECRET the route stays closed rather than public: an unauthenticated dispatch
 * trigger would let anyone flush the delivery queue.
 */
export function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers[PUSH_CRON_HEADER];
  const provided = Array.isArray(header) ? header[0] : header;
  if (typeof provided !== 'string') return false;
  const expected = `Bearer ${secret}`;
  if (provided.length !== expected.length) return false;
  // compare digests so a wrong byte costs the same as a right one
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return digest(provided).equals(digest(expected));
}

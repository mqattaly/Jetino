import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AdminAuditService } from './admin-audit.service';

type AdminRequest = Request & { user: { sub: string; roles: string[] } };

/**
 * The audit trail is the one place where the platform's whole history of money
 * and address changes is readable, so it stays with the super admin: operations
 * staff work from the order and report views, and every browse is recorded.
 */
@Controller('admin/audit-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class AdminAuditController {
  constructor(@Inject(AdminAuditService) private readonly audit: AdminAuditService) {}

  @Get() list(
    @Req() req: AdminRequest,
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
    @Query('entityId') entityId?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.audit.list({ sub: req.user.sub }, { action, actorId, entityId, since, until, limit, offset });
  }

  @Get('actions') actions() { return this.audit.actions(); }
}

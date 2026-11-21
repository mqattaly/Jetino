import { Body, Controller, Get, Inject, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SafetyService } from '../safety/safety.service';

type AdminRequest = Request & { user: { sub: string; roles: string[] } };

@Controller('admin/safety/events')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'OPERATIONS_MANAGER', 'SUPPORT')
export class AdminSafetyController {
  constructor(@Inject(SafetyService) private readonly safety: SafetyService) {}

  @Get() queue(@Query('status') status?: string) { return this.safety.queue(status); }

  @Patch(':id') handle(@Req() request: AdminRequest, @Param('id') id: string, @Body() body: { status?: unknown; resolution?: unknown }) {
    return this.safety.handle(request.user.sub, id, body ?? {});
  }
}

import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { PartnersService } from './partners.service';
type AuthRequest = Request & { user: {sub: string; roles: string[]} };
@Controller('partner-applications')
@UseGuards(JwtAuthGuard)
export class PartnersController {
 constructor(@Inject(PartnersService) private readonly partners: PartnersService) {}
 @Get('drivers/mine') mine(@Req() req: AuthRequest) { return this.partners.myDriverApplications(req.user.sub); }
 @Post('drivers') apply(@Req() req: AuthRequest, @Body() body: {fullName?:unknown;vehicleType?:unknown;note?:unknown;regionSlug?:unknown}) { return this.partners.applyDriver(req.user.sub, body ?? {}); }
 @Get('drivers') @UseGuards(RolesGuard) @Roles('SUPER_ADMIN') queue(@Query('status') status?: string) { return this.partners.driverQueue(status); }
 @Patch('drivers/:id') @UseGuards(RolesGuard) @Roles('SUPER_ADMIN') decide(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: {decision?:unknown;note?:unknown}) { return this.partners.decideDriver(req.user.sub,id,body ?? {}); }
}

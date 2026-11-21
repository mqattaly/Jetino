import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AddressesService } from './addresses.service';

type AuthRequest = Request & { user: { sub: string; roles: string[] } };
@Controller('addresses')
@UseGuards(JwtAuthGuard)
export class AddressesController {
  constructor(@Inject(AddressesService) private readonly addresses: AddressesService) {}
  @Get() list(@Req() req: AuthRequest) { return this.addresses.list(req.user); }
  @Post() create(@Req() req: AuthRequest, @Body() body: { label?: unknown; addressText?: unknown; instructions?: unknown; latitude?: unknown; longitude?: unknown; regionSlug?: unknown; isDefault?: unknown }) { return this.addresses.create(req.user,body); }
  @Patch(':id') update(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: { label?: unknown; addressText?: unknown; instructions?: unknown; latitude?: unknown; longitude?: unknown; isDefault?: unknown }) { return this.addresses.update(req.user,id,body); }
  @Delete(':id') delete(@Req() req: AuthRequest, @Param('id') id: string) { return this.addresses.delete(req.user,id); }
}

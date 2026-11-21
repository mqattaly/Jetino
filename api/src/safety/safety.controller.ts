import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SafetyService } from './safety.service';

type SafetyRequest = Request & { user: { sub: string; roles: string[] } };

@Controller('safety')
@UseGuards(JwtAuthGuard)
export class SafetyController {
  constructor(@Inject(SafetyService) private readonly safety: SafetyService) {}

  @Post('sos') raise(@Req() request: SafetyRequest, @Body() body: { orderId?: unknown; category?: unknown; note?: unknown }) {
    return this.safety.raise(request.user, body ?? {});
  }

  @Get('events/:id') detail(@Req() request: SafetyRequest, @Param('id') id: string) {
    return this.safety.detail(request.user, id);
  }
}

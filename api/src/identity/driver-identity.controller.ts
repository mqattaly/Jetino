import { BadRequestException, Body, Controller, Get, Headers, Inject, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DriverIdentityService } from './driver-identity.service';

type DriverRequest = Request & { user: { sub: string; roles: string[] }; body: unknown };

/**
 * The courier's own identity card: check the national code with the phone number and the registry,
 * then prove the face with a fresh selfie video. Everything is answered from the courier's row.
 */
@Controller('drivers/me/identity')
@UseGuards(JwtAuthGuard)
export class DriverIdentityController {
  constructor(@Inject(DriverIdentityService) private readonly identity: DriverIdentityService) {}

  @Get() status(@Req() req: DriverRequest) { return this.identity.status(req.user); }

  @Post('verify') verify(@Req() req: DriverRequest, @Body() body: Record<string, unknown>) {
    return this.identity.verify(req.user, body ?? {});
  }

  /** Raw video body: `application/octet-stream` style binary, parsed before Nest's JSON parser. */
  @Post('biometric') biometric(@Req() req: DriverRequest, @Headers('content-type') contentType?: string) {
    const body = req.body;
    if (!Buffer.isBuffer(body)) throw new BadRequestException('ویدئو باید به‌صورت فایل خام فرستاده شود.');
    return this.identity.submitBiometric(req.user, body, contentType ?? '');
  }

  @Get('biometric') poll(@Req() req: DriverRequest) { return this.identity.poll(req.user); }
}

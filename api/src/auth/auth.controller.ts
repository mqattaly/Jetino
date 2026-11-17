import { Body, Controller, Inject, Post } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth/otp')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('request')
  request(@Body() body: { phone?: unknown }) {
    return this.auth.requestOtp(body?.phone);
  }

  @Post('verify')
  verify(@Body() body: { phone?: unknown; code?: unknown }) {
    return this.auth.verifyOtp(body?.phone, body?.code);
  }
}

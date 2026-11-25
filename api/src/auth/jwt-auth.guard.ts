import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

type Principal = { sub: string; roles: string[]; phone: string };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly jwt = new JwtService();
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: Principal }>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token || !process.env.JWT_SECRET) throw new UnauthorizedException();
    try {
      request.user = await this.jwt.verifyAsync<Principal>(token, {
        secret: process.env.JWT_SECRET, issuer: 'jetino-api', audience: 'jetino-client',
      });
      return true;
    } catch { throw new UnauthorizedException(); }
  }
}

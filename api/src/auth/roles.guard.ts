import { CanActivate, ExecutionContext, Injectable, SetMetadata, ForbiddenException, Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const REQUIRED_ROLES = 'jetino:required_roles';
export const Roles = (...roles: string[]) => SetMetadata(REQUIRED_ROLES, roles);

type RequestWithUser = { user?: { roles?: string[] } };

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_ROLES, [context.getHandler(), context.getClass()]);
    if (!required?.length) return true;
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    // every screen is Persian, so the guard's own refusal must be too — 'Forbidden resource' landed verbatim in panels
    if (!request.user?.roles?.some((role) => required.includes(role))) throw new ForbiddenException('این کار با نقش فعلی شما مجاز نیست.');
    return true;
  }
}

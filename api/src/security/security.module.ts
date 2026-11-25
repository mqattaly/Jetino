import { Global, Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';

/** Global so any feature module can inject the shared abuse brake without re-importing it. */
@Global()
@Module({ providers: [RateLimitService], exports: [RateLimitService] })
export class SecurityModule {}

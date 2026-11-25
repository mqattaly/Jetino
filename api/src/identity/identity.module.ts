import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SecurityModule } from '../security/security.module';
import { DriverIdentityController } from './driver-identity.controller';
import { DriverIdentityService } from './driver-identity.service';
import { ZohalService } from './zohal.service';
import { AdminIdentityController } from './admin-identity.controller';

@Module({
  imports: [SecurityModule],
  controllers: [DriverIdentityController, AdminIdentityController],
  providers: [ZohalService, DriverIdentityService, JwtAuthGuard],
  exports: [ZohalService, DriverIdentityService],
})
export class IdentityModule {}

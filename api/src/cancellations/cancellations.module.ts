import { Module } from '@nestjs/common';
import { CancellationsController } from './cancellations.controller';
import { CancellationsService } from './cancellations.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';

@Module({
  controllers: [CancellationsController],
  providers: [CancellationsService, JwtAuthGuard, RolesGuard],
})
export class CancellationsModule {}

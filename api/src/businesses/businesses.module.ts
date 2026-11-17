import { Module } from '@nestjs/common';
import { BusinessesController } from './businesses.controller';
import { BusinessesService } from './businesses.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Module({ controllers: [BusinessesController], providers: [BusinessesService, JwtAuthGuard] })
export class BusinessesModule {}

import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SafetyController } from './safety.controller';
import { SafetyService } from './safety.service';

@Module({ controllers: [SafetyController], providers: [SafetyService, JwtAuthGuard] })
export class SafetyModule {}

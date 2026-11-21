import { Module } from '@nestjs/common';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Module({ controllers: [DeliveryController], providers: [DeliveryService, JwtAuthGuard] })
export class DeliveryModule {}

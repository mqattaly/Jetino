import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Module({ controllers: [OrdersController], providers: [OrdersService, JwtAuthGuard] })
export class OrdersModule {}

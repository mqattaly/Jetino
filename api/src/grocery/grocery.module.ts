import { Module } from '@nestjs/common';
import { GroceryController } from './grocery.controller';
import { GroceryAdminController } from './grocery-admin.controller';
import { GroceryService } from './grocery.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
@Module({ controllers: [GroceryController, GroceryAdminController], providers: [GroceryService, JwtAuthGuard], exports: [GroceryService] })
export class GroceryModule {}

import { Module } from '@nestjs/common';
import { GroceryController } from './grocery.controller';
import { GroceryAdminController } from './grocery-admin.controller';
import { GroceryService } from './grocery.service';
import { GroceryStoresController } from './grocery-stores.controller';
import { GroceryStoresService } from './grocery-stores.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
@Module({
  controllers: [GroceryController, GroceryStoresController, GroceryAdminController],
  providers: [GroceryService, GroceryStoresService, JwtAuthGuard],
  exports: [GroceryService, GroceryStoresService],
})
export class GroceryModule {}

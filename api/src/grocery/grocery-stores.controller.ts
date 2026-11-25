import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { GroceryStoresService } from './grocery-stores.service';

type AuthRequest = Request & { user: { sub: string; roles: string[] } };

/**
 * The shop side of the grocery phase: customers read the approved catalogue, an owner writes it.
 * Admin approval lives in the grocery admin controller.
 */
@Controller('grocery')
@UseGuards(JwtAuthGuard)
export class GroceryStoresController {
  constructor(@Inject(GroceryStoresService) private readonly stores: GroceryStoresService) {}

  @Get('stores') list(@Req() req: AuthRequest) { return this.stores.listStores(req.user); }
  @Get('stores/:id/products') products(@Param('id') id: string) { return this.stores.products(id); }

  @Get('store/mine') mine(@Req() req: AuthRequest) { return this.stores.mine(req.user); }
  @Post('store/mine') save(@Req() req: AuthRequest, @Body() body: { name?: unknown; phone?: unknown; addressText?: unknown; note?: unknown }) {
    return this.stores.save(req.user, body ?? {});
  }
  @Post('store/mine/products') addProduct(@Req() req: AuthRequest, @Body() body: Record<string, unknown>) {
    return this.stores.addProduct(req.user, body ?? {});
  }
  @Patch('store/mine/products/:id') updateProduct(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.stores.updateProduct(req.user, id, body ?? {});
  }
  @Delete('store/mine/products/:id') archiveProduct(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.stores.archiveProduct(req.user, id);
  }
}

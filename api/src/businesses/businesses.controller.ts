import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BusinessesService } from './businesses.service';

type AuthRequest = Request & { user: { sub: string; roles: string[] } };

@Controller('businesses')
export class BusinessesController {
  constructor(@Inject(BusinessesService) private readonly businesses: BusinessesService) {}

  @Get()
  list(@Query('region') region?: string, @Query('q') q?: string) { return this.businesses.list(region, q); }

  @Get('mine')
  @UseGuards(JwtAuthGuard)
  mine(@Req() request: AuthRequest) { return this.businesses.mine(request.user); }

  @Patch('mine/:id/orderability')
  @UseGuards(JwtAuthGuard)
  orderability(@Req() request: AuthRequest, @Param('id') id: string, @Body() body: { acceptingOrders?: unknown }) { return this.businesses.setOrderability(request.user, id, body?.acceptingOrders); }

  @Patch('mine/:id/location')
  @UseGuards(JwtAuthGuard)
  location(@Req() request: AuthRequest, @Param('id') id: string, @Body() body: { latitude?: unknown; longitude?: unknown }) {
    return this.businesses.setLocation(request.user, id, body);
  }

  @Get('mine/:id/menu')
  @UseGuards(JwtAuthGuard)
  mineMenu(@Req() request: AuthRequest, @Param('id') id: string) { return this.businesses.mineMenu(request.user, id); }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Req() request: AuthRequest, @Body() body: { name?: unknown; description?: unknown; regionSlug?: unknown; addressText?: unknown; contactPhone?: unknown; workingHours?: unknown; applicationKey?: unknown }) {
    return this.businesses.create(request.user, body);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  update(@Req() request: AuthRequest, @Param('id') id: string, @Body() body: { name?: unknown; description?: unknown }) {
    return this.businesses.update(request.user, id, body);
  }

  @Get(':id')
  detail(@Param('id') id: string) { return this.businesses.detail(id); }

  @Post(':id/categories')
  @UseGuards(JwtAuthGuard)
  category(@Req() request: AuthRequest, @Param('id') id: string, @Body() body: { name?: unknown; sortOrder?: unknown }) {
    return this.businesses.createCategory(request.user, id, body);
  }

  @Post('categories/:categoryId/products')
  @UseGuards(JwtAuthGuard)
  product(@Req() request: AuthRequest, @Param('categoryId') id: string, @Body() body: { name?: unknown; description?: unknown; priceRial?: unknown }) {
    return this.businesses.createProduct(request.user, id, body);
  }

  @Patch('products/:productId')
  @UseGuards(JwtAuthGuard)
  updateProduct(@Req() request: AuthRequest, @Param('productId') id: string, @Body() body: { name?: unknown; description?: unknown; priceRial?: unknown }) {
    return this.businesses.updateProduct(request.user, id, body);
  }

  @Patch('products/:productId/availability')
  @UseGuards(JwtAuthGuard)
  availability(@Req() request: AuthRequest, @Param('productId') id: string, @Body() body: { isAvailable?: unknown }) {
    return this.businesses.setProductAvailability(request.user, id, body?.isAvailable);
  }
}

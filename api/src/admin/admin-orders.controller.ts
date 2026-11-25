import { Body, Controller, Get, Inject, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AdminOrdersService } from './admin-orders.service';
type AdminRequest=Request&{user:{sub:string;roles:string[]}};
@Controller('admin/orders')
@UseGuards(JwtAuthGuard,RolesGuard)
@Roles('SUPER_ADMIN','OPERATIONS_MANAGER')
export class AdminOrdersController{
 constructor(@Inject(AdminOrdersService)private readonly orders:AdminOrdersService){}
 @Get() list(@Query('status')status?:string,@Query('search')search?:string,@Query('limit')limit?:string,@Query('offset')offset?:string){return this.orders.list(status,search,limit,offset);}
 @Patch(':id/assign-driver') assign(@Req()req:AdminRequest,@Param('id')id:string,@Body()body:{driverId?:unknown}){return this.orders.assign(req.user.sub,id,body?.driverId);}
}

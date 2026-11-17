import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AdminDriversService } from './admin-drivers.service';
type AdminRequest=Request&{user:{sub:string;roles:string[]}};
@Controller('admin/drivers')
@UseGuards(JwtAuthGuard,RolesGuard)
@Roles('SUPER_ADMIN')
export class AdminDriversController{
 constructor(@Inject(AdminDriversService)private readonly drivers:AdminDriversService){}
 @Get() @Roles('SUPER_ADMIN','OPERATIONS_MANAGER') list(){return this.drivers.list();}
 @Post() create(@Req()req:AdminRequest,@Body()body:{phone?:unknown;regionSlug?:unknown}){return this.drivers.create(req.user.sub,body);}
 @Patch(':id/status') status(@Req()req:AdminRequest,@Param('id')id:string,@Body()body:{status?:unknown}){return this.drivers.setStatus(req.user.sub,id,body?.status);}
}

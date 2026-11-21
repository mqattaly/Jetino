import { Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type {Request} from 'express';
import {JwtAuthGuard} from '../auth/jwt-auth.guard';
import {NotificationsService} from './notifications.service';
type AuthRequest=Request&{user:{sub:string;roles:string[]}};
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController{
 constructor(@Inject(NotificationsService)private readonly notifications:NotificationsService){}
 @Get() list(@Req()req:AuthRequest){return this.notifications.list(req.user);}
 @Post('read-all') readAll(@Req()req:AuthRequest){return this.notifications.readAll(req.user);}
 @Patch(':id/read') markRead(@Req()req:AuthRequest,@Param('id')id:string){return this.notifications.markRead(req.user,id);}
}

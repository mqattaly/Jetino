import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DriversService } from './drivers.service';
type DriverRequest=Request&{user:{sub:string;roles:string[]}};
@Controller('drivers/me')
@UseGuards(JwtAuthGuard)
export class DriversController{
 constructor(@Inject(DriversService)private readonly drivers:DriversService){}
 @Get('deliveries') list(@Req()req:DriverRequest){return this.drivers.deliveries(req.user);}
 @Get('wallet/cash-summary') cashSummary(@Req()req:DriverRequest){return this.drivers.cashSummary(req.user);}
 @Patch('deliveries/:orderId/status') status(@Req()req:DriverRequest,@Param('orderId')id:string,@Body()body:{status?:unknown}){return this.drivers.transition(req.user,id,body?.status);}
 @Post('deliveries/:orderId/cash-collected') cash(@Req()req:DriverRequest,@Param('orderId')id:string,@Body()body:{confirmReceived?:unknown}){return this.drivers.collectCash(req.user,id,body?.confirmReceived);}
}

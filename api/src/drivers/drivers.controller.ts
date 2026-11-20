import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DriversService } from './drivers.service';
type DriverRequest=Request&{user:{sub:string;roles:string[]}};
@Controller('drivers/me')
@UseGuards(JwtAuthGuard)
export class DriversController{
 constructor(@Inject(DriversService)private readonly drivers:DriversService){}
 @Get() profile(@Req()req:DriverRequest){return this.drivers.profile(req.user);}
 @Patch() saveProfile(@Req()req:DriverRequest,@Body()body:{fullName?:unknown;vehicleType?:unknown;plateNumber?:unknown;photoUrl?:unknown}){return this.drivers.saveProfile(req.user,body??{});}
 @Get('deliveries') list(@Req()req:DriverRequest){return this.drivers.deliveries(req.user);}
 @Get('wallet/cash-summary') cashSummary(@Req()req:DriverRequest){return this.drivers.cashSummary(req.user);}
 @Patch('deliveries/:orderId/status') status(@Req()req:DriverRequest,@Param('orderId')id:string,@Body()body:{status?:unknown;code?:unknown}){return this.drivers.transition(req.user,id,body?.status,body?.code);}
 @Post('deliveries/:orderId/cash-collected') cash(@Req()req:DriverRequest,@Param('orderId')id:string,@Body()body:{confirmReceived?:unknown}){return this.drivers.collectCash(req.user,id,body?.confirmReceived);}
}

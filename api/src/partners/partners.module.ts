import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { PartnersController } from './partners.controller';
import { PartnersService } from './partners.service';
@Module({controllers:[PartnersController],providers:[PartnersService,JwtAuthGuard,RolesGuard]})
export class PartnersModule {}

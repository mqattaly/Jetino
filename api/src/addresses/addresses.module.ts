import { Module } from '@nestjs/common';
import { AddressesController } from './addresses.controller';
import { AddressesService } from './addresses.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Module({ controllers: [AddressesController], providers: [AddressesService, JwtAuthGuard] })
export class AddressesModule {}

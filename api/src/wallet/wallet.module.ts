import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
@Module({ controllers: [WalletController], providers: [WalletService, JwtAuthGuard] })
export class WalletModule {}

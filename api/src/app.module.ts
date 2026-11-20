import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { BusinessesModule } from './businesses/businesses.module';
import { AdminModule } from './admin/admin.module';
import { AddressesModule } from './addresses/addresses.module';
import { OrdersModule } from './orders/orders.module';
import { DriversModule } from './drivers/drivers.module';
import { DeliveryModule } from './delivery/delivery.module';
import { SupportModule } from './support/support.module';
import { CancellationsModule } from './cancellations/cancellations.module';
import { PartnersModule } from './partners/partners.module';
import { WalletModule } from './wallet/wallet.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({ imports: [DatabaseModule, AuthModule, BusinessesModule, AdminModule, AddressesModule, OrdersModule, DriversModule, DeliveryModule, SupportModule, CancellationsModule, NotificationsModule, WalletModule, PartnersModule], controllers: [HealthController] })
export class AppModule {}

import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationDeliveryController } from './notification-delivery.controller';
import { NotificationDeliveryService } from './notification-delivery.service';
import { PushSenderFactory } from './push-sender';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
@Module({controllers:[NotificationsController,NotificationDeliveryController],providers:[NotificationsService,NotificationDeliveryService,PushSenderFactory,JwtAuthGuard],exports:[NotificationDeliveryService]})
export class NotificationsModule{}

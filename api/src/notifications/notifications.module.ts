import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
@Module({controllers:[NotificationsController],providers:[NotificationsService,JwtAuthGuard]})
export class NotificationsModule{}

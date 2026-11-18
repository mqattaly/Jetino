import { Module } from '@nestjs/common';
import { FeedbackService } from './feedback.service';
import { SupportService } from './support.service';
import { FeedbackAdminController, FeedbackQueryController, OrderFeedbackController, SupportTicketController } from './support.controller';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';

@Module({
  controllers: [OrderFeedbackController, FeedbackQueryController, FeedbackAdminController, SupportTicketController],
  providers: [FeedbackService, SupportService, JwtAuthGuard, RolesGuard],
})
export class SupportModule {}

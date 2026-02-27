import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { Plan } from './entities/plan.entity';
import { PaymentRequest } from './entities/payment-request.entity';
import { Subscription } from './entities/subscription.entity';
import { PlansService } from './plans.service';
import { PaymentsService } from './payments.service';
import { PlansController } from './plans.controller';
import { PaymentsController } from './payments.controller';
import { SubscriptionsController } from './subscriptions.controller';
import { PaymentMonitorService } from './payments.cron';
import { UsersModule } from '../users/users.module';
import { BlockchainModule } from '../blockchain/blockchain.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Plan, PaymentRequest, Subscription]),
    ScheduleModule.forRoot(),
    UsersModule,
    BlockchainModule,
  ],
  controllers: [PlansController, PaymentsController, SubscriptionsController],
  providers: [PlansService, PaymentsService, PaymentMonitorService],
  exports: [PlansService, PaymentsService],
})
export class SubscriptionsModule {}

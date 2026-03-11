import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { UsersModule } from '../users/users.module';
import { BotController } from './bot.controller';
import { BotService } from './bot.service';
import { BotGuard } from './bot.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Subscription]),
    UsersModule,
  ],
  controllers: [BotController],
  providers: [BotService, BotGuard],
})
export class BotModule {}

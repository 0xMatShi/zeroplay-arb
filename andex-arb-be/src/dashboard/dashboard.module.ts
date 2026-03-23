import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DashboardProfile } from './entities/dashboard-profile.entity';
import { DashboardTrade } from './entities/dashboard-trade.entity';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { UsersModule } from '../users/users.module';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';

@Module({
  imports: [TypeOrmModule.forFeature([DashboardProfile, DashboardTrade]), UsersModule],
  controllers: [DashboardController],
  providers: [DashboardService, ApiKeyGuard],
})
export class DashboardModule {}

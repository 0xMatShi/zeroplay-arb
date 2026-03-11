import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VersionModule } from './version/version.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
// import { ArbitrageModule } from './arbitrage/pm-pm-arb/arbitrage.module';
import { SportsArbModule } from './arbitrage/pm-bm-arb/sports-arb.module';
import { BlockchainModule } from './blockchain/blockchain.module';
import { DatabaseConfig } from './config/database.config';
import { BotModule } from './bot/bot.module';

@Module({
  imports: [
    // Configuration module
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // Database module
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useClass: DatabaseConfig,
      inject: [ConfigService],
    }),

    // Feature modules
    VersionModule,
    UsersModule,
    AuthModule,
    BlockchainModule,
    SubscriptionsModule,
    BotModule,

    // ArbitrageModule,
    SportsArbModule,
  ],
})
export class AppModule {}

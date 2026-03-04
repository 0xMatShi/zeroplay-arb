import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

// Entities
import { Platform } from './entities/platform.entity';
import { PlatformEvent } from './entities/platform-event.entity';
import { Outcome } from './entities/outcome.entity';
import { EventMatch } from './entities/event-match.entity';
import { ArbitrageOpportunity } from './entities/arbitrage-opportunity.entity';
import { VerifiedMatch } from './entities/verified-match.entity';

// Adapters
import { AdapterRegistry } from './adapters/adapter.registry';
import { PolymarketAdapter } from './adapters/polymarket/polymarket.adapter';
import { KalshiAdapter } from './adapters/kalshi/kalshi.adapter';
// import { OpinionAdapter } from './adapters/opinion/opinion.adapter';
import { PredictFunAdapter } from './adapters/predict-fun/predict-fun.adapter';
import { ProbableAdapter } from './adapters/probable/probable.adapter';

// Services
import { EventFetcherService } from './services/event-fetcher.service';
import { MatchingService } from './services/matching.service';
import { ScannerService } from './services/scanner.service';
import { OpportunityService } from './services/opportunity.service';
import { OrderBookService } from './services/orderbook.service';
import { AiVerificationService } from './services/ai-verification.service';
import { PriceStreamService } from './services/price-stream.service';

// Schedulers
import { PollScheduler } from './scheduler/poll.scheduler';
import { RevalidationScheduler } from './scheduler/revalidation.scheduler';

// Controllers & Gateways
import { ArbitrageController } from './controllers/arbitrage.controller';
import { ArbitrageGateway } from './gateways/arbitrage.gateway';

// Auth & Subscriptions
import { UsersModule } from '../users/users.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

/**
 * Core arbitrage engine module.
 *
 * To add a new source adapter:
 * 1. Create adapter class implementing ISourceAdapter
 * 2. Add it to `providers` below
 * 3. That's it — the adapter self-registers via onModuleInit
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Platform, PlatformEvent, Outcome, EventMatch, ArbitrageOpportunity, VerifiedMatch]),
    ScheduleModule.forRoot(),
    UsersModule,
    SubscriptionsModule,
  ],
  providers: [
    // Adapter infrastructure
    AdapterRegistry,

    // Source adapters — add new adapters here
    PolymarketAdapter,
    KalshiAdapter,
    // OpinionAdapter,
    PredictFunAdapter,
    ProbableAdapter,
    // ManifoldAdapter,

    // Core services
    EventFetcherService,
    MatchingService,
    ScannerService,
    OpportunityService,
    OrderBookService,
    AiVerificationService,
    PriceStreamService,

    // Schedulers
    PollScheduler,
    RevalidationScheduler,

    // WebSocket
    ArbitrageGateway,
  ],
  controllers: [ArbitrageController],
  exports: [
    AdapterRegistry,
    EventFetcherService,
    MatchingService,
    ScannerService,
    OpportunityService,
    OrderBookService,
    AiVerificationService,
  ],
})
export class ArbitrageModule {}

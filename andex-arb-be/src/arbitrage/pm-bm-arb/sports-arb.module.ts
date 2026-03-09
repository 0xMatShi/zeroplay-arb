import { Module } from '@nestjs/common';

// Adapters
import { PolymarketSportsAdapter } from './adapters/polymarket-sports/polymarket-sports.adapter';
import { DexsportAdapter } from './adapters/dexsport/dexsport.adapter';

// Services
import { SportsMatcher } from './services/sports-matcher.service';
import { SportsArbScanner } from './services/sports-arb-scanner.service';

// Scheduler
import { SportsScheduler } from './scheduler/sports-scheduler';

// Controller
import { SportsArbController } from './controllers/sports-arb.controller';

// Gateway
import { SportsArbGateway } from './gateways/sports-arb.gateway';

// Auth & Subscriptions (needed by SubscriptionGuard)
import { UsersModule } from '../../users/users.module';
import { SubscriptionsModule } from '../../subscriptions/subscriptions.module';

/**
 * Sports Arbitrage module — Prediction Markets ↔ Bookmakers pipeline.
 *
 * Separate from ArbitrageModule (which handles PM vs PM).
 * No database — all state kept in memory.
 *
 * Pipeline:
 *   PolymarketSportsAdapter  — fetches all sports events/markets, updates prices via CLOB WS
 *   DexsportAdapter          — maintains live WS feed from DexSport (all markets per event)
 *   SportsMatcher (Cron 3)   — matches events by text similarity + markets by type/value
 *   SportsArbScanner (Cron 4)— detects arbitrage on each matched market pair
 */
@Module({
  imports: [UsersModule, SubscriptionsModule],
  controllers: [SportsArbController],
  providers: [
    // Data sources
    PolymarketSportsAdapter,
    DexsportAdapter,

    // Pipeline services
    SportsMatcher,
    SportsArbScanner,

    // Schedulers
    SportsScheduler,

    // WebSocket gateway
    SportsArbGateway,
  ],
  exports: [SportsScheduler],
})
export class SportsArbModule {}

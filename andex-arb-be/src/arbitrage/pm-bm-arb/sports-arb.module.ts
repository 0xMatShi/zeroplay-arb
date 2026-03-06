import { Module } from '@nestjs/common';

// Adapters
import { PolymarketSportsAdapter } from './adapters/polymarket-sports/polymarket-sports.adapter';
import { DexsportAdapter } from './adapters/dexsport/dexsport.adapter';

// Services
import { SportsMatcher } from './services/sports-matcher.service';
import { SportsArbScanner } from './services/sports-arb-scanner.service';

// Scheduler
import { SportsScheduler } from './scheduler/sports-scheduler';

/**
 * Sports Arbitrage module — Prediction Markets ↔ Bookmakers pipeline.
 *
 * Separate from ArbitrageModule (which handles PM vs PM).
 * No database — all state kept in memory.
 *
 * Pipeline:
 *   PolymarketSportsAdapter  — fetches sports moneyline markets, updates prices via CLOB WS
 *   DexsportAdapter          — maintains live WS feed from DexSport
 *   SportsMatcher (Cron 3)   — matches equivalent events by sport + team names
 *   SportsArbScanner (Cron 4)— detects arbitrage on matched pairs
 */
@Module({
  imports: [],
  providers: [
    // Data sources
    PolymarketSportsAdapter,
    DexsportAdapter,

    // Pipeline services
    SportsMatcher,
    SportsArbScanner,

    // Schedulers
    SportsScheduler,
  ],
  exports: [SportsScheduler],
})
export class SportsArbModule {}

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SportsMatcher } from '../services/sports-matcher.service';
import { SportsArbScanner } from '../services/sports-arb-scanner.service';
import { SportsMatch, SportsArbitrageOpportunity } from '../interfaces/sports-arb.types';

/**
 * Sports Arbitrage pipeline — two independent crons:
 *
 *  Cron 3 (every 5 min):  Re-match Polymarket sports events with DexSport events.
 *  Cron 4 (every 30s):    Scan current matches for arbitrage opportunities.
 */
@Injectable()
export class SportsScheduler implements OnModuleInit {
  private readonly logger = new Logger(SportsScheduler.name);

  /** Current matched pairs — updated by Cron 3, read by Cron 4 */
  private currentMatches: SportsMatch[] = [];

  /** Latest detected opportunities */
  private currentOpportunities: SportsArbitrageOpportunity[] = [];

  constructor(
    private readonly matcher: SportsMatcher,
    private readonly scanner: SportsArbScanner,
  ) {}

  async onModuleInit(): Promise<void> {
    // Wait a bit for WS adapters to receive initial data, then run first cycle
    setTimeout(() => this.runMatchCycle(), 15_000);
  }

  // ── Cron 3: Match ──────────────────────────────────────────────

  /** Re-run event matching every 5 minutes */
  @Cron('0 */5 * * * *')
  async handleMatchCron(): Promise<void> {
    await this.runMatchCycle();
  }

  async runMatchCycle(): Promise<void> {
    try {
      this.currentMatches = await this.matcher.findMatches();
      this.logger.log(`Sports match cycle: ${this.currentMatches.length} matched pairs`);

      // Immediately scan after fresh match
      this.runScanCycle();
    } catch (err: any) {
      this.logger.error(`Sports match cycle failed: ${err.message}`);
    }
  }

  // ── Cron 4: Scan ───────────────────────────────────────────────

  /** Scan for arbitrage every 30 seconds */
  @Cron(CronExpression.EVERY_30_SECONDS)
  handleScanCron(): void {
    this.runScanCycle();
  }

  runScanCycle(): void {
    if (this.currentMatches.length === 0) return;

    try {
      this.currentOpportunities = this.scanner.scan(this.currentMatches);
    } catch (err: any) {
      this.logger.error(`Sports scan cycle failed: ${err.message}`);
    }
  }

  // ── Public API (for controller/gateway) ────────────────────────

  getMatches(): SportsMatch[] {
    return this.currentMatches;
  }

  getOpportunities(): SportsArbitrageOpportunity[] {
    return this.currentOpportunities;
  }
}

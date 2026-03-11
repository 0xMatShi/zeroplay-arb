import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventFetcherService } from '../services/event-fetcher.service';
import { MatchingService } from '../services/matching.service';

/**
 * Match pipeline scheduler — runs every hour.
 *
 * Responsible for data ingestion and matching:
 * 1. Fetch events from all platforms
 * 2. Match new events across platforms (text similarity → CONFIRMED)
 *
 * Arbitrage scanning is handled independently by ScanScheduler (every 30s).
 */
@Injectable()
export class PollScheduler implements OnModuleInit {
  private readonly logger = new Logger(PollScheduler.name);
  private isRunning = false;

  constructor(
    private readonly eventFetcher: EventFetcherService,
    private readonly matchingService: MatchingService,
  ) {}

  /**
   * On startup: seed platforms and run first poll.
   */
  async onModuleInit() {
    this.logger.log('Initializing arbitrage engine...');

    try {
      await this.eventFetcher.seedPlatforms();
      this.logger.log('Platforms seeded');

      await this.matchingService.seedVerifiedMatches();

      // Run first poll after a short delay (let other modules init)
      setTimeout(
        () =>
          this.runMatchCycle().then(() => {
            this.logger.log('First match cycle complete');
          }),
        5_000,
      );
    } catch (error) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  /**
   * Match pipeline cron: every hour.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleCron() {
    await this.runMatchCycle();
  }

  /**
   * Match pipeline: fetch → match → AI verify.
   * Mutex-protected to prevent overlapping runs.
   * Arbitrage scanning is NOT done here — see ScanScheduler.
   */
  async runMatchCycle(): Promise<void> {
    if (this.isRunning) {
      this.logger.debug('Match cycle already running, skipping');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      // Step 1: Fetch events from all platforms
      this.logger.log('Step 1/3: Fetching events from all platforms...');
      const fetchResults = await this.eventFetcher.fetchAll();

      let totalFetched = 0;
      for (const [slug, ids] of fetchResults) {
        totalFetched += ids.length;
        this.logger.debug(`  ${slug}: ${ids.length} events`);
      }

      // Step 2: Match events across platforms (text similarity → CONFIRMED)
      this.logger.log('Step 2/2: Matching events...');
      const newMatches = await this.matchingService.matchNewEvents();

      const elapsed = Date.now() - startTime;
      this.logger.log(
        `Match cycle complete in ${elapsed}ms: ${totalFetched} events fetched, ${newMatches} new matches`,
      );
    } catch (error) {
      this.logger.error(`Match cycle failed: ${error.message}`, error.stack);
    } finally {
      this.isRunning = false;
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OpportunityService } from '../services/opportunity.service';
import { MatchingService } from '../services/matching.service';
import { EventFetcherService } from '../services/event-fetcher.service';
import { OrderBookService } from '../services/orderbook.service';
import { ArbitrageGateway } from '../gateways/arbitrage.gateway';

/**
 * Arbitrage scan scheduler — runs every 30 seconds.
 *
 * Each tick:
 * 1. Get ALL verified matches
 * 2. Refresh prices for every event/outcome via fetchOrderBook
 *    (not just events with active opportunities)
 * 3. Scan all verified matches for arbitrage with fresh prices
 * 4. Notify clients via WebSocket
 */
@Injectable()
export class RevalidationScheduler {
  private readonly logger = new Logger(RevalidationScheduler.name);
  private isRunning = false;

  constructor(
    private readonly opportunityService: OpportunityService,
    private readonly matchingService: MatchingService,
    private readonly eventFetcher: EventFetcherService,
    private readonly orderBookService: OrderBookService,
    private readonly gateway: ArbitrageGateway,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async handleScanCycle() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      // Step 1: Get all verified matches with events + outcomes
      const matches = await this.matchingService.getScannableMatches();

      if (matches.length === 0) return;

      // Step 2: Refresh prices for ALL verified match events via orderbook
      await this.eventFetcher.refreshPricesViaOrderBooks(matches);

      // Step 3: Scan all verified matches for new/updated/expired opportunities
      const newIds = await this.opportunityService.runScanCycle();

      for (const id of newIds) {
        // Сначала анализируем order book — метрики сохраняются в БД
        await this.orderBookService.getOrderBookAnalysis(id);
        // Загружаем свежий объект с уже заполненными метриками
        const opp = await this.opportunityService.getById(id);
        if (opp) {
          this.gateway.emitNewOpportunity(opp);
        }
      }

      // Step 4: Revalidate existing active opportunities (expire stale ones)
      const expiredIds = await this.opportunityService.revalidateActive();

      for (const id of expiredIds) {
        this.gateway.emitOpportunityExpired(id);
      }

      if (newIds.length > 0 || expiredIds.length > 0) {
        this.logger.log(
          `Scan cycle: ${newIds.length} new opportunities, ${expiredIds.length} expired`,
        );
      }
    } catch (error) {
      this.logger.error(`Scan cycle failed: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}

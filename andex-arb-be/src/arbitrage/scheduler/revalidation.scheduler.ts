import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OpportunityService } from '../services/opportunity.service';
import { OrderBookService } from '../services/orderbook.service';
import { ArbitrageGateway } from '../gateways/arbitrage.gateway';
import { PriceStreamService } from '../services/price-stream.service';

/**
 * Arbitrage scan scheduler.
 *
 * Prices are now updated in real-time by PriceStreamService (WebSocket).
 * This scheduler only runs the scan cycle — no HTTP order-book polling.
 *
 * Two triggers for a scan cycle:
 * 1. WebSocket price update → PriceStreamService calls the registered callback
 *    (debounced at 1s to avoid excessive DB load)
 * 2. 30-second fallback cron — ensures stale opportunities are expired even
 *    when price stream is quiet
 */
@Injectable()
export class RevalidationScheduler implements OnModuleInit {
  private readonly logger = new Logger(RevalidationScheduler.name);
  private isRunning = false;

  constructor(
    private readonly opportunityService: OpportunityService,
    private readonly orderBookService: OrderBookService,
    private readonly gateway: ArbitrageGateway,
    private readonly priceStream: PriceStreamService,
  ) {}

  onModuleInit(): void {
    // Register ourselves as the scan target for WebSocket price updates
    this.priceStream.setScanCallback(() => this.handleScanCycle());
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async handleScanCycle(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      // Check for new verified matches and subscribe their tokens
      await this.priceStream.refreshSubscriptions();

      // Refresh Kalshi prices via HTTP (WS requires auth, so we poll every 30s)
      await this.priceStream.refreshKalshiPrices();

      // Scan all verified matches for new/updated/expired opportunities
      const newIds = await this.opportunityService.runScanCycle();

      for (const id of newIds) {
        // Analyse order book depth — metrics saved to DB
        await this.orderBookService.getOrderBookAnalysis(id);
        // Load fresh object with metrics
        const opp = await this.opportunityService.getById(id);
        if (opp) {
          this.gateway.emitNewOpportunity(opp);
        }
      }

      // Expire opportunities whose prices are no longer profitable
      const expiredIds = await this.opportunityService.revalidateActive();

      for (const id of expiredIds) {
        this.gateway.emitOpportunityExpired(id);
      }

      if (newIds.length > 0 || expiredIds.length > 0) {
        this.logger.log(`Scan cycle: ${newIds.length} new, ${expiredIds.length} expired`);
      }
    } catch (error) {
      this.logger.error(`Scan cycle failed: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}

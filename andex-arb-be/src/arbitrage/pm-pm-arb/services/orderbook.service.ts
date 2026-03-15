import { Injectable, Logger } from '@nestjs/common';
import { AdapterRegistry } from '../adapters/adapter.registry';
import {
  ArbitrageLeg,
  ArbitrageTier,
  ArbitrageTiersSummary,
  LegOrderBook,
  OrderBook,
  OrderBookEntry,
} from '../interfaces/types';
import { OpportunityService } from './opportunity.service';

/**
 * Service for order-book-based arbitrage analysis.
 *
 * Instead of showing a single "best price" arb, this service walks through
 * the actual order books of each leg to compute executable tiers:
 *
 *   Tier 1: 200 contracts → 7.5% profit → $186 investment
 *   Tier 2: 500 contracts → 5.3% profit → $475 investment
 *   Tier 3: 1000 contracts → 2.0% profit → $980 investment
 *   (stops when total cost per contract >= 1.0 = no profit)
 *
 * This gives the user a realistic view of how much they can actually trade.
 */
@Injectable()
export class OrderBookService {
  private readonly logger = new Logger(OrderBookService.name);

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly opportunityService: OpportunityService,
  ) {}

  /**
   * Fetch order books and compute executable arb tiers for an opportunity.
   */
  async getOrderBookAnalysis(opportunityId: string): Promise<{
    opportunityId: string;
    matchTitle?: string;
    /** Per-leg order book data */
    legs: LegOrderBook[];
    /** Executable arb tiers (walked through the order books) */
    tiers: ArbitrageTiersSummary;
    /** Timestamp of the analysis */
    analyzedAt: string;
  } | null> {
    const opportunity = await this.opportunityService.getById(opportunityId);
    if (!opportunity) return null;

    // Fetch order books for all legs in parallel
    const legOrderBooks = await this.fetchAllLegOrderBooks(opportunity.legs);

    // Walk through order books to find executable arb tiers
    const tiers = this.computeArbitrageTiers(opportunity.legs, legOrderBooks);

    // Cache orderbook-derived metrics on the opportunity for sorting/filtering
    await this.opportunityService.updateOrderBookMetrics(
      opportunityId,
      tiers.weightedAvgProfit,
      tiers.totalGrossProfit,
      tiers.totalInvestment,
      tiers.totalQuantity,
    );

    return {
      opportunityId,
      matchTitle: opportunity.eventMatch?.title,
      legs: legOrderBooks,
      tiers,
      analyzedAt: new Date().toISOString(),
    };
  }

  // ═══════════════════════ Order Book Fetching ═══════════════════════

  /**
   * Fetch order books for all legs in parallel.
   */
  private async fetchAllLegOrderBooks(legs: ArbitrageLeg[]): Promise<LegOrderBook[]> {
    return Promise.all(legs.map((leg) => this.fetchLegOrderBook(leg)));
  }

  /**
   * Fetch order book for a single leg via its platform adapter.
   */
  private async fetchLegOrderBook(leg: ArbitrageLeg): Promise<LegOrderBook> {
    const adapter = this.registry.getAdapter(leg.platformSlug);
    let orderBook: OrderBook | null = null;

    if (adapter?.fetchOrderBook) {
      try {
        orderBook = await adapter.fetchOrderBook(leg);
      } catch (error) {
        this.logger.warn(
          `Failed to fetch order book for ${leg.platformSlug}/${leg.outcomeName}: ${error.message}`,
        );
      }
    }

    if (!orderBook) {
      return {
        platformSlug: leg.platformSlug,
        platformName: leg.platformName,
        outcomeName: leg.outcomeName,
        orderBook: { bids: [], asks: [], timestamp: Date.now() },
        availableQuantity: 0,
        effectivePrice: leg.price,
      };
    }

    // Total quantity available in asks
    const availableQuantity = orderBook.asks.reduce((sum, a) => sum + a.quantity, 0);
    const bestAsk = orderBook.asks[0]?.price ?? leg.price;

    return {
      platformSlug: leg.platformSlug,
      platformName: leg.platformName,
      outcomeName: leg.outcomeName,
      orderBook,
      availableQuantity: Math.round(availableQuantity * 100) / 100,
      effectivePrice: bestAsk,
    };
  }

  // ═══════════════════════ Tier Computation ═══════════════════════

  /**
   * Walk through the order books of all legs simultaneously to find
   * executable arb tiers.
   *
   * Algorithm (for N legs):
   * 1. Start with the best (cheapest) ask on each leg
   * 2. Sum prices across all legs → totalCostPerContract
   * 3. If totalCost >= 1.0 → no profit, stop
   * 4. The fillable quantity = min(remaining qty across all legs)
   * 5. Record this as a tier
   * 6. Subtract filled qty from each leg; advance to next price level
   *    for any exhausted leg
   * 7. Repeat until no more profit or any leg is exhausted
   */
  private computeArbitrageTiers(
    legs: ArbitrageLeg[],
    legOrderBooks: LegOrderBook[],
  ): ArbitrageTiersSummary {
    const emptyResult: ArbitrageTiersSummary = {
      tiers: [],
      totalQuantity: 0,
      totalInvestment: 0,
      totalGrossProfit: 0,
      weightedAvgProfit: 0,
      bestProfitPercentage: 0,
      worstProfitPercentage: 0,
    };

    // Check all legs have asks
    if (legOrderBooks.some((l) => l.orderBook.asks.length === 0)) {
      return emptyResult;
    }

    // Create cursors for each leg's ask side
    const cursors = legOrderBooks.map((l) => ({
      asks: l.orderBook.asks, // sorted ASC by price
      index: 0,
      remaining: l.orderBook.asks[0]?.quantity ?? 0,
      platformSlug: l.platformSlug,
      platformName: l.platformName,
      outcomeName: l.outcomeName,
      url: legs.find((leg) => leg.platformSlug === l.platformSlug)?.url,
    }));

    const tiers: ArbitrageTier[] = [];
    const GUARANTEED_PAYOUT = 1.0;
    const MAX_TIERS = 50; // safety limit

    while (tiers.length < MAX_TIERS) {
      // Check all cursors are valid
      if (cursors.some((c) => c.index >= c.asks.length)) break;

      // Current price for each leg
      const currentPrices = cursors.map((c) => c.asks[c.index].price);
      const totalCostPerContract = currentPrices.reduce((sum, p) => sum + p, 0);

      // No more profit
      if (totalCostPerContract >= GUARANTEED_PAYOUT) break;

      // Fillable quantity = min remaining across all legs
      const fillable = Math.min(...cursors.map((c) => c.remaining));
      if (fillable <= 0) break;

      const profitPercentage =
        ((GUARANTEED_PAYOUT - totalCostPerContract) / totalCostPerContract) * 100;
      const investmentAmount = fillable * totalCostPerContract;
      const grossProfit = fillable * (GUARANTEED_PAYOUT - totalCostPerContract);

      tiers.push({
        quantity: Math.round(fillable * 100) / 100,
        legPrices: cursors.map((c, i) => ({
          platformSlug: c.platformSlug,
          platformName: c.platformName,
          outcomeName: c.outcomeName,
          price: currentPrices[i],
          url: c.url,
        })),
        totalCostPerContract: Math.round(totalCostPerContract * 1_000_000) / 1_000_000,
        profitPercentage: Math.round(profitPercentage * 100) / 100,
        investmentAmount: Math.round(investmentAmount * 100) / 100,
        grossProfit: Math.round(grossProfit * 100) / 100,
      });

      // Advance cursors
      for (const cursor of cursors) {
        cursor.remaining -= fillable;
        if (cursor.remaining <= 0.001) {
          // Move to next ask level
          cursor.index++;
          if (cursor.index < cursor.asks.length) {
            cursor.remaining = cursor.asks[cursor.index].quantity;
          }
        }
      }
    }

    if (tiers.length === 0) return emptyResult;

    // Compute summary
    const totalQuantity = tiers.reduce((sum, t) => sum + t.quantity, 0);
    const totalInvestment = tiers.reduce((sum, t) => sum + t.investmentAmount, 0);
    const totalGrossProfit = tiers.reduce((sum, t) => sum + t.grossProfit, 0);
    const weightedAvgProfit = totalInvestment > 0 ? (totalGrossProfit / totalInvestment) * 100 : 0;

    return {
      tiers,
      totalQuantity: Math.round(totalQuantity * 100) / 100,
      totalInvestment: Math.round(totalInvestment * 100) / 100,
      totalGrossProfit: Math.round(totalGrossProfit * 100) / 100,
      weightedAvgProfit: Math.round(weightedAvgProfit * 100) / 100,
      bestProfitPercentage: tiers[0].profitPercentage,
      worstProfitPercentage: tiers[tiers.length - 1].profitPercentage,
    };
  }
}

import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseAdapter } from '../base.adapter';
import { AdapterRegistry } from '../adapter.registry';
import {
  NormalizedEvent,
  NormalizedOutcome,
  EventStatus,
  OutcomeType,
  PlatformInfo,
  ArbitrageLeg,
  OrderBook,
  OrderBookEntry,
} from '../../interfaces/types';
import {
  PredictMarket,
  PredictOrderBook,
  PredictListResponse,
  PredictApiResponse,
} from './predict-fun.types';

/**
 * Predict.fun adapter.
 *
 * API: https://api.predict.fun/v1  (mainnet, API key required)
 *      https://api-testnet.predict.fun/v1  (testnet, no key)
 *
 * Key features:
 * - Markets have polymarketConditionIds & kalshiMarketTicker cross-refs
 * - Orderbook is per-market (for "Yes" outcome), No = inverse
 * - Cursor-based pagination (first/after)
 * - Rate limit: 240 req/min
 *
 * URL pattern: https://predict.fun/market/<categorySlug>
 */

const PREDICT_FUN_BASE_URL = 'https://predict.fun';
const PAGE_SIZE = 100;
const MAX_PAGES = 60;

/** Active market statuses */
const ACTIVE_STATUSES = new Set(['REGISTERED', 'UNPAUSED']);

@Injectable()
export class PredictFunAdapter extends BaseAdapter implements OnModuleInit {
  readonly platformSlug = 'predict-fun';
  readonly platformName = 'Predict.fun';

  constructor(
    private readonly configService: ConfigService,
    private readonly registry: AdapterRegistry,
  ) {
    const apiKey = configService?.get<string>('PREDICT_FUN_API_KEY');
    const apiBase = apiKey ? 'https://api.predict.fun/v1' : 'https://api-testnet.predict.fun/v1';

    super(apiBase, {
      headers: apiKey
        ? { 'x-api-key': apiKey, Accept: 'application/json' }
        : { Accept: 'application/json' },
    });

    if (!apiKey) {
      this.logger.warn('No PREDICT_FUN_API_KEY set — using testnet (limited data)');
    }
  }

  onModuleInit() {
    this.registry.register(this);
  }

  getPlatformInfo(): PlatformInfo {
    return {
      slug: this.platformSlug,
      name: this.platformName,
      baseUrl: PREDICT_FUN_BASE_URL,
      defaultPollIntervalMs: 120_000,
    };
  }

  // ───────────────────────── fetchEvents ─────────────────────────

  /**
   * Fetch all active markets from Predict.fun.
   *
   * Prices are NOT fetched here — they are populated during the
   * 30-second revalidation cycle via fetchOrderBook() for verified matches only.
   */
  async fetchEvents(): Promise<NormalizedEvent[]> {
    const markets = await this.fetchAllMarkets();

    this.logger.log(`Fetched ${markets.length} active markets from Predict.fun`);

    return markets
      .map((market) => this.normalizeMarket(market))
      .filter((e): e is NormalizedEvent => e !== null);
  }

  /**
   * Paginate through all active markets.
   */
  private async fetchAllMarkets(): Promise<PredictMarket[]> {
    const allMarkets: PredictMarket[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      try {
        const params: Record<string, any> = {
          first: String(PAGE_SIZE),
          status: 'OPEN',
        };
        if (cursor) params.after = cursor;

        const { data } = await this.http.get<PredictListResponse<PredictMarket>>('/markets', {
          params,
        });

        if (!data?.success || !data?.data?.length) break;

        // Only include active markets (not paused, disputed, etc.)
        const active = data.data.filter((m) => ACTIVE_STATUSES.has(m.status));
        allMarkets.push(...active);

        cursor = data.cursor;
        if (!cursor) break;

        await this.sleep(300); // ~200 req/min to be safe
      } catch (error) {
        this.logger.error(`Failed to fetch Predict.fun markets page ${page}: ${error.message}`);
        break;
      }
    }

    return allMarkets;
  }

  /**
   * Fetch orderbook for a single market and extract Yes/No prices.
   *
   * The orderbook is for the "Yes" outcome:
   * - Best ask = cheapest price to BUY Yes
   * - Best bid = highest price someone will PAY for Yes
   * - No price = 1 - best bid (buying No = selling Yes)
   */
  private async fetchMarketPrices(
    marketId: number,
  ): Promise<{ yesPrice: number; noPrice: number } | null> {
    try {
      const { data } = await this.http.get<PredictApiResponse<PredictOrderBook>>(
        `/markets/${marketId}/orderbook`,
        { timeout: 10_000 },
      );

      if (!data?.success || !data?.data) return null;

      const ob = data.data;
      const bestAsk = ob.asks?.[0]?.[0]; // cheapest ask price
      const bestBid = ob.bids?.[0]?.[0]; // highest bid price

      if (bestAsk == null && bestBid == null) return null;

      // Yes price = best ask (what you'd pay to buy Yes)
      // No price = 1 - best bid (what you'd pay to buy No)
      const yesPrice = bestAsk ?? (bestBid ? bestBid + 0.01 : 0.5);
      const noPrice = bestBid != null ? 1 - bestBid : bestAsk ? 1 - bestAsk + 0.01 : 0.5;

      return { yesPrice, noPrice };
    } catch {
      return null;
    }
  }

  // ───────────────────────── fetchOrderBook ─────────────────────────

  /**
   * Fetch the order book for an arbitrage leg.
   *
   * The Predict.fun orderbook is for the "Yes" side.
   * For "No" legs, we invert: bids become asks (at 1 - price) and vice versa.
   */
  async fetchOrderBook(leg: ArbitrageLeg): Promise<OrderBook | null> {
    const marketId = leg.metadata?.marketId;
    if (!marketId) {
      this.logger.warn(`Cannot fetch orderbook: missing marketId in leg metadata`);
      return null;
    }

    try {
      const { data } = await this.http.get<PredictApiResponse<PredictOrderBook>>(
        `/markets/${marketId}/orderbook`,
        { timeout: 10_000 },
      );

      if (!data?.success || !data?.data) return null;

      const ob = data.data;
      const isNo = (leg.outcomeName || '').toLowerCase() === 'no';

      if (isNo) {
        // For "No" outcome: invert the orderbook
        // Buying No = selling Yes, so:
        // - "No" asks (sell offers for No) = inverted Yes bids
        // - "No" bids (buy offers for No) = inverted Yes asks
        const asks: OrderBookEntry[] = (ob.bids || [])
          .map(([price, qty]) => ({ price: 1 - price, quantity: qty }))
          .filter((e) => e.price > 0 && e.price < 1)
          .sort((a, b) => a.price - b.price);

        const bids: OrderBookEntry[] = (ob.asks || [])
          .map(([price, qty]) => ({ price: 1 - price, quantity: qty }))
          .filter((e) => e.price > 0 && e.price < 1)
          .sort((a, b) => b.price - a.price);

        return { bids, asks, timestamp: ob.updateTimestampMs };
      }

      // For "Yes" outcome: use orderbook directly
      const asks: OrderBookEntry[] = (ob.asks || [])
        .map(([price, qty]) => ({ price, quantity: qty }))
        .sort((a, b) => a.price - b.price);

      const bids: OrderBookEntry[] = (ob.bids || [])
        .map(([price, qty]) => ({ price, quantity: qty }))
        .sort((a, b) => b.price - a.price);

      return { bids, asks, timestamp: ob.updateTimestampMs };
    } catch (error) {
      this.logger.error(
        `Failed to fetch Predict.fun orderbook for market ${marketId}: ${error.message}`,
      );
      return null;
    }
  }

  // ───────────────────────── Normalization ─────────────────────────

  /**
   * Normalize a Predict.fun market to our format.
   * Prices default to 0 and are populated during revalidation.
   */
  private normalizeMarket(market: PredictMarket): NormalizedEvent | null {
    try {
      const outcomes = this.normalizeOutcomes(market);
      if (outcomes.length === 0) return null;

      const outcomeType = outcomes.length === 2 ? OutcomeType.BINARY : OutcomeType.MULTI;

      return {
        externalId: `pf-${market.id}`,
        title: market.question || market.title,
        description: market.description || undefined,
        category: market.categorySlug || undefined,
        endDate: undefined, // predict.fun doesn't expose end date directly in market
        status: EventStatus.ACTIVE,
        outcomeType,
        outcomes,
        url: `${PREDICT_FUN_BASE_URL}/market/${market.categorySlug}`,
        metadata: {
          marketId: market.id,
          conditionId: market.conditionId,
          categorySlug: market.categorySlug,
          marketVariant: market.marketVariant,
          isNegRisk: market.isNegRisk,
          decimalPrecision: market.decimalPrecision,
          // Cross-platform references — useful for matching!
          polymarketConditionIds: market.polymarketConditionIds,
          kalshiMarketTicker: market.kalshiMarketTicker,
        },
      };
    } catch (error) {
      this.logger.warn(`Failed to normalize Predict.fun market ${market.id}: ${error.message}`);
      return null;
    }
  }

  /**
   * Create normalized outcomes from market data.
   * Prices default to 0 and will be populated during revalidation.
   */
  private normalizeOutcomes(market: PredictMarket): NormalizedOutcome[] {
    const outcomes: NormalizedOutcome[] = [];

    for (const outcome of market.outcomes) {
      const isYes = outcome.name.toLowerCase() === 'yes' || outcome.name.toLowerCase() === 'up';
      const isNo = outcome.name.toLowerCase() === 'no' || outcome.name.toLowerCase() === 'down';

      if (!isYes && !isNo) {
        // For multi-outcome markets, we'd need individual prices
        // For now, skip non-binary outcomes
        continue;
      }

      outcomes.push({
        externalId: `${market.id}-${outcome.name.toLowerCase()}`,
        name: outcome.name,
        price: 0,
        metadata: {
          marketId: market.id,
          onChainId: outcome.onChainId,
          indexSet: outcome.indexSet,
          conditionId: market.conditionId,
          side: isYes ? 'yes' : 'no',
        },
      });
    }

    return outcomes;
  }

  // ───────────────────────── Helpers ─────────────────────────

  private clampPrice(price: number): number {
    if (!price || price < 0) return 0;
    if (price > 1) return 1;
    return Math.round(price * 10000) / 10000;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const { data } = await this.http.get<PredictListResponse<any>>('/markets', {
        params: { first: '1', status: 'OPEN' },
        timeout: 5_000,
      });
      return data?.success === true;
    } catch {
      return false;
    }
  }
}

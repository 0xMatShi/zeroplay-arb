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
import { PolymarketMarket, PolymarketOrderBookResponse } from './polymarket.types';

const POLYMARKET_GAMMA_API = 'https://gamma-api.polymarket.com';
const POLYMARKET_CLOB_API = 'https://clob.polymarket.com';
const POLYMARKET_BASE_URL = 'https://polymarket.com';
const MAX_PAGES = 20;
const PAGE_LIMIT = 500;

@Injectable()
export class PolymarketAdapter extends BaseAdapter implements OnModuleInit {
  readonly platformSlug = 'polymarket';
  readonly platformName = 'Polymarket';

  constructor(
    private readonly configService: ConfigService,
    private readonly registry: AdapterRegistry,
  ) {
    super(POLYMARKET_GAMMA_API);
  }

  onModuleInit() {
    this.registry.register(this);
  }

  getPlatformInfo(): PlatformInfo {
    return {
      slug: this.platformSlug,
      name: this.platformName,
      baseUrl: POLYMARKET_BASE_URL,
      defaultPollIntervalMs: 120_000, // 2 minutes
    };
  }

  /**
   * Fetch all active binary markets from Polymarket.
   * Uses the Gamma API /markets endpoint with offset-based pagination.
   */
  async fetchEvents(): Promise<NormalizedEvent[]> {
    const allMarkets: PolymarketMarket[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      try {
        const { data } = await this.http.get<PolymarketMarket[]>('/markets', {
          params: {
            active: true,
            closed: false,
            limit: PAGE_LIMIT,
            offset: page * PAGE_LIMIT,
          },
        });

        if (!data || !Array.isArray(data) || data.length === 0) {
          break;
        }

        allMarkets.push(...data);

        // Less than a full page = no more data
        if (data.length < PAGE_LIMIT) {
          break;
        }

        // Rate limiting: be nice to the API
        await this.sleep(200);
      } catch (error) {
        this.logger.error(`Failed to fetch Polymarket markets page ${page}: ${error.message}`);
        break;
      }
    }

    this.logger.log(`Fetched ${allMarkets.length} markets from Polymarket`);

    return allMarkets
      .map((market) => this.normalizeMarket(market))
      .filter((event): event is NormalizedEvent => event !== null);
  }

  /**
   * Fetch prices for specific markets by their condition IDs.
   */
  async fetchPrices(externalEventIds: string[]): Promise<Map<string, NormalizedOutcome[]>> {
    const result = new Map<string, NormalizedOutcome[]>();

    // Batch fetch in chunks to avoid URL length limits
    const chunkSize = 20;
    for (let i = 0; i < externalEventIds.length; i += chunkSize) {
      const chunk = externalEventIds.slice(i, i + chunkSize);

      try {
        const promises = chunk.map(async (conditionId) => {
          try {
            const { data } = await this.http.get<PolymarketMarket[]>('/markets', {
              params: { condition_id: conditionId },
            });

            if (data && data.length > 0) {
              const market = data[0];
              const outcomes = this.parseOutcomes(market);
              result.set(conditionId, outcomes);
            }
          } catch (error) {
            this.logger.warn(`Failed to fetch price for market ${conditionId}: ${error.message}`);
          }
        });

        await Promise.all(promises);
        await this.sleep(100);
      } catch (error) {
        this.logger.error(`Failed to fetch prices batch: ${error.message}`);
      }
    }

    return result;
  }

  // ───────────────────────── Order Book ─────────────────────────

  /**
   * Fetch the order book for a specific arbitrage leg from the Polymarket CLOB API.
   *
   * Uses leg.metadata.tokenId (= the CLOB token ID for this outcome).
   * API: GET https://clob.polymarket.com/book?token_id=<tokenId>
   */
  async fetchOrderBook(leg: ArbitrageLeg): Promise<OrderBook | null> {
    const tokenId = leg.metadata?.tokenId || leg.outcomeExternalId;

    if (!tokenId) {
      this.logger.warn(
        `Cannot fetch order book for Polymarket leg "${leg.outcomeName}": missing tokenId`,
      );
      return null;
    }

    try {
      const { data } = await this.http.get<PolymarketOrderBookResponse>(
        `${POLYMARKET_CLOB_API}/book`,
        {
          params: { token_id: tokenId },
          timeout: 10_000,
        },
      );

      if (!data || (!data.bids?.length && !data.asks?.length)) {
        return null;
      }

      const bids: OrderBookEntry[] = (data.bids || [])
        .map((level) => ({
          price: parseFloat(level.price),
          quantity: parseFloat(level.size),
        }))
        .filter((e) => !isNaN(e.price) && !isNaN(e.quantity))
        .sort((a, b) => b.price - a.price); // best bid first

      const asks: OrderBookEntry[] = (data.asks || [])
        .map((level) => ({
          price: parseFloat(level.price),
          quantity: parseFloat(level.size),
        }))
        .filter((e) => !isNaN(e.price) && !isNaN(e.quantity))
        .sort((a, b) => a.price - b.price); // best ask first

      return {
        bids,
        asks,
        timestamp: data.timestamp ? parseInt(data.timestamp, 10) : Date.now(),
      };
    } catch (error) {
      this.logger.error(
        `Failed to fetch Polymarket order book for "${leg.outcomeName}": ${error.message}`,
      );
      return null;
    }
  }

  // ───────────────────────── Normalization ─────────────────────────

  /**
   * Convert a Polymarket market to our normalized format.
   */
  private normalizeMarket(market: PolymarketMarket): NormalizedEvent | null {
    try {
      const outcomes = this.parseOutcomes(market);

      if (outcomes.length === 0) {
        return null;
      }

      const outcomeType = outcomes.length === 2 ? OutcomeType.BINARY : OutcomeType.MULTI;

      // Build URL: /event/<event-slug>/<market-slug> or fallback to /event/<market-slug>
      const eventSlug = market.events?.[0]?.slug;
      const url = eventSlug
        ? `${POLYMARKET_BASE_URL}/event/${eventSlug}/${market.slug}`
        : `${POLYMARKET_BASE_URL}/event/${market.slug}`;

      return {
        externalId: market.conditionId,
        title: market.question,
        description: market.description || undefined,
        endDate: market.endDate ? new Date(market.endDate) : undefined,
        status: EventStatus.ACTIVE,
        outcomeType,
        outcomes,
        url,
        metadata: {
          slug: market.slug,
          eventSlug,
          marketId: market.id,
          liquidity: market.liquidity,
          volume: market.volume,
          volume24h: market.volume24hr,
        },
      };
    } catch (error) {
      this.logger.warn(`Failed to normalize Polymarket market ${market.id}: ${error.message}`);
      return null;
    }
  }

  /**
   * Parse outcomes and prices from Polymarket market data.
   */
  private parseOutcomes(market: PolymarketMarket): NormalizedOutcome[] {
    const outcomeNames = this.safeJsonParse<string[]>(market.outcomes, []);
    const outcomePrices = this.safeJsonParse<string[]>(market.outcomePrices, []);
    const tokenIds = this.safeJsonParse<string[]>(market.clobTokenIds, []);

    if (outcomeNames.length === 0 || outcomePrices.length === 0) {
      return [];
    }

    return outcomeNames.map((name, index) => ({
      externalId: tokenIds[index] || `${market.conditionId}-${index}`,
      name,
      price: parseFloat(outcomePrices[index]) || 0,
      volume24h: market.volume24hr ? parseFloat(market.volume24hr) : undefined,
      metadata: {
        tokenId: tokenIds[index],
      },
    }));
  }
}

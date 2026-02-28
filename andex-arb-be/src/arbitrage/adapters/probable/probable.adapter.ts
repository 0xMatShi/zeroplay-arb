import { Injectable, OnModuleInit } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
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
  ProbableEvent,
  ProbableMarket,
  ProbableOrderBookResponse,
  ProbableEventTag,
} from './probable.types';

/**
 * Probable Markets adapter.
 *
 * Market Public API: https://market-api.probable.markets/public/api/v1  (no auth)
 * Orderbook CLOB API: https://api.probable.markets/public/api/v1       (no auth for reads)
 *
 * BNB Chain-based prediction market (incubated by PancakeSwap).
 * Uses CTF (Conditional Token Framework) tokens — each market outcome has a token_id.
 * Order book structure identical to Polymarket CLOB.
 *
 * URL pattern: https://probable.markets/event/{eventSlug}
 */

const PROBABLE_PUBLIC_API = 'https://market-api.probable.markets/public/api/v1';
const PROBABLE_CLOB_API = 'https://api.probable.markets/public/api/v1';
const PROBABLE_BASE_URL = 'https://probable.markets';
const MAX_PAGES = 60;
const PAGE_LIMIT = 100;

const isEventActive = (e: ProbableEvent) =>
  (e.active || e.live) && !e.closed && !e.archived && !e.ended;

@Injectable()
export class ProbableAdapter extends BaseAdapter implements OnModuleInit {
  readonly platformSlug = 'probable';
  readonly platformName = 'Probable Markets';

  private readonly clob: AxiosInstance;

  constructor(private readonly registry: AdapterRegistry) {
    super(PROBABLE_PUBLIC_API, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'andex-arb-engine/1.0',
        Origin: 'https://probable.markets',
        Referer: 'https://probable.markets/',
      },
    });

    this.clob = axios.create({
      baseURL: PROBABLE_CLOB_API,
      timeout: 15_000,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'andex-arb-engine/1.0',
      },
    });
  }

  onModuleInit() {
    this.registry.register(this);
  }

  getPlatformInfo(): PlatformInfo {
    return {
      slug: this.platformSlug,
      name: this.platformName,
      baseUrl: PROBABLE_BASE_URL,
      defaultPollIntervalMs: 120_000,
    };
  }

  // ───────────────────────── fetchEvents ─────────────────────────

  /**
   * Fetch all active events from Probable Markets.
   *
   * Uses the Market Public API GET /events endpoint with offset-based pagination.
   * Each event contains embedded markets with outcomes and token IDs.
   * We then batch-fetch current prices via the CLOB /prices endpoint.
   */
  async fetchEvents(): Promise<NormalizedEvent[]> {
    const allEvents: ProbableEvent[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      try {
        const { data } = await this.http.get<ProbableEvent[]>('/events', {
          params: {
            limit: PAGE_LIMIT,
            offset: page * PAGE_LIMIT,
            status: 'active',
            closed: false,
          },
        });

        if (!data || !Array.isArray(data) || data.length === 0) break;

        const active = data.filter(isEventActive);
        allEvents.push(...active);

        if (data.length < PAGE_LIMIT) break;
        await this.sleep(250);
      } catch (error) {
        this.logger.error(`Failed to fetch Probable events page ${page}: ${error.message}`);
        break;
      }
    }

    this.logger.log(`Fetched ${allEvents.length} active events from Probable Markets`);

    // Prices are NOT fetched here — they are populated during the
    // 30-second revalidation cycle via fetchOrderBook() for verified matches only.
    const emptyPriceMap = new Map<string, number>();
    const normalized: NormalizedEvent[] = [];

    for (const event of allEvents) {
      for (const market of event.markets || []) {
        const norm = this.normalizeMarket(event, market, emptyPriceMap);
        if (norm) normalized.push(norm);
      }
    }

    return normalized;
  }

  // ───────────────────────── fetchOrderBook ─────────────────────────

  /**
   * Fetch the order book for an arbitrage leg from the Probable CLOB API.
   *
   * Uses leg.metadata.tokenId (CTF token ID for this outcome).
   * API: GET https://api.probable.markets/public/api/v1/book?token_id=<tokenId>
   */
  async fetchOrderBook(leg: ArbitrageLeg): Promise<OrderBook | null> {
    const tokenId = leg.metadata?.tokenId || leg.outcomeExternalId;

    if (!tokenId) {
      this.logger.warn(
        `Cannot fetch order book for Probable leg "${leg.outcomeName}": missing tokenId`,
      );
      return null;
    }

    try {
      const { data } = await this.clob.get<ProbableOrderBookResponse>('/book', {
        params: { token_id: tokenId },
        timeout: 10_000,
      });

      if (!data || (!data.bids?.length && !data.asks?.length)) {
        return null;
      }

      const bids: OrderBookEntry[] = (data.bids || [])
        .map((level) => ({
          price: parseFloat(level.price),
          quantity: parseFloat(level.size),
        }))
        .filter((e) => !isNaN(e.price) && !isNaN(e.quantity))
        .sort((a, b) => b.price - a.price);

      const asks: OrderBookEntry[] = (data.asks || [])
        .map((level) => ({
          price: parseFloat(level.price),
          quantity: parseFloat(level.size),
        }))
        .filter((e) => !isNaN(e.price) && !isNaN(e.quantity))
        .sort((a, b) => a.price - b.price);

      return {
        bids,
        asks,
        timestamp: data.timestamp ? parseInt(data.timestamp, 10) : Date.now(),
      };
    } catch (error) {
      this.logger.error(
        `Failed to fetch Probable order book for "${leg.outcomeName}": ${error.message}`,
      );
      return null;
    }
  }

  // ───────────────────────── Normalization ─────────────────────────

  /**
   * Normalize a Probable market (within an event) to our format.
   */
  private normalizeMarket(
    event: ProbableEvent,
    market: ProbableMarket,
    priceMap: Map<string, number>,
  ): NormalizedEvent | null {
    try {
      if (!market.active || market.closed || market.archived || market.resolved) return null;

      const outcomes = this.parseOutcomes(market, priceMap);
      if (outcomes.length === 0) return null;

      const outcomeType = outcomes.length === 2 ? OutcomeType.BINARY : OutcomeType.MULTI;
      const firstTag = event.tags?.[0] as ProbableEventTag | undefined;

      return {
        externalId: market.condition_id,
        title: market.question || event.title,
        description: market.description || undefined,
        category: market.category || firstTag?.label || undefined,
        endDate: market.endDate ? new Date(market.endDate) : undefined,
        status: EventStatus.ACTIVE,
        outcomeType,
        outcomes,
        url: `${PROBABLE_BASE_URL}/event/${event.slug}`,
        metadata: {
          eventId: event.id,
          eventSlug: event.slug,
          marketId: market.id,
          marketSlug: market.market_slug || market.slug,
          conditionId: market.condition_id,
          questionId: market.question_id,
          volume: market.volume,
          volume24h: market.volume24hr,
          liquidity: market.liquidity,
          groupItemTitle: market.groupItemTitle,
        },
      };
    } catch (error) {
      this.logger.warn(`Failed to normalize Probable market ${market.id}: ${error.message}`);
      return null;
    }
  }

  /**
   * Parse outcomes from a market's tokens + outcomes, enriched with CLOB prices.
   */
  private parseOutcomes(
    market: ProbableMarket,
    priceMap: Map<string, number>,
  ): NormalizedOutcome[] {
    if (!market.tokens?.length) return [];

    const vol =
      typeof market.volume24hr === 'string'
        ? parseFloat(market.volume24hr) || undefined
        : (market.volume24hr ?? undefined);

    return market.tokens
      .map((token) => {
        const price = priceMap.get(token.token_id) ?? token.price ?? 0;

        return {
          externalId: token.token_id,
          name: token.outcome,
          price: this.clampPrice(price),
          volume24h: vol,
          metadata: {
            tokenId: token.token_id,
            conditionId: market.condition_id,
            side: token.outcome.toLowerCase(),
          },
        };
      })
      .filter((o) => o.name);
  }

  // ───────────────────────── Price Fetching ─────────────────────────

  /**
   * Batch-fetch mid prices for multiple token IDs via the CLOB API.
   *
   * Uses POST /prices with token_id + side pairs.
   * Falls back to individual /midpoint calls if bulk fails.
   */
  private async batchFetchPricesByTokenId(tokenIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (tokenIds.length === 0) return result;

    const batchSize = 50;

    for (let i = 0; i < tokenIds.length; i += batchSize) {
      const batch = tokenIds.slice(i, i + batchSize);

      try {
        const requestBody = batch.map((tokenId) => ({
          token_id: tokenId,
          side: 'BUY',
        }));

        const { data } = await this.clob.post<Record<string, { BUY?: string; SELL?: string }>>(
          '/prices',
          requestBody,
        );

        if (data) {
          for (const [tokenId, prices] of Object.entries(data)) {
            const buyPrice = prices.BUY ? parseFloat(prices.BUY) : NaN;
            const sellPrice = prices.SELL ? parseFloat(prices.SELL) : NaN;

            // Use midpoint if both available, otherwise whichever we have
            if (!isNaN(buyPrice) && !isNaN(sellPrice)) {
              result.set(tokenId, (buyPrice + sellPrice) / 2);
            } else if (!isNaN(buyPrice)) {
              result.set(tokenId, buyPrice);
            } else if (!isNaN(sellPrice)) {
              result.set(tokenId, sellPrice);
            }
          }
        }
      } catch {
        // Fallback: fetch midpoints individually
        for (const tokenId of batch) {
          try {
            const { data } = await this.clob.get<{ mid: string }>('/midpoint', {
              params: { token_id: tokenId },
              timeout: 5_000,
            });
            if (data?.mid) {
              const mid = parseFloat(data.mid);
              if (!isNaN(mid)) result.set(tokenId, mid);
            }
          } catch {
            // Skip tokens with no price data
          }
        }
      }

      if (i + batchSize < tokenIds.length) {
        await this.sleep(300);
      }
    }

    return result;
  }

  // ───────────────────────── Helpers ─────────────────────────

  private clampPrice(price: number): number {
    if (!price || price < 0) return 0;
    if (price > 1) return 1;
    return Math.round(price * 10000) / 10000;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.clob.get<{ price: string }>('/price', {
        params: { token_id: 'health-check', side: 'BUY' },
        timeout: 5_000,
      });
      // Even an error response from a valid endpoint means the API is reachable
      return true;
    } catch (error) {
      // 4xx means the API is up (just invalid token), 5xx or network error means down
      if (error.response?.status && error.response.status < 500) {
        return true;
      }
      return false;
    }
  }
}

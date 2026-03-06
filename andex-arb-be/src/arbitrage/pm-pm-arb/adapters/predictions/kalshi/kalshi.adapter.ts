import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseAdapter } from '../../base.adapter';
import { AdapterRegistry } from '../../adapter.registry';
import {
  NormalizedEvent,
  NormalizedOutcome,
  EventStatus,
  OutcomeType,
  PlatformInfo,
  ArbitrageLeg,
  OrderBook,
  OrderBookEntry,
} from '../../../interfaces/types';
import { KalshiMarket, KalshiMarketsResponse, KalshiEventsResponse, KalshiOrderBookResponse } from './kalshi.types';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_BASE_URL = 'https://kalshi.com';
const MAX_PAGES = 50;

@Injectable()
export class KalshiAdapter extends BaseAdapter implements OnModuleInit {
  readonly platformSlug = 'kalshi';
  readonly platformName = 'Kalshi';

  constructor(
    private readonly configService: ConfigService,
    private readonly registry: AdapterRegistry,
  ) {
    super(KALSHI_API_BASE);
  }

  onModuleInit() {
    this.registry.register(this);
  }

  getPlatformInfo(): PlatformInfo {
    return {
      slug: this.platformSlug,
      name: this.platformName,
      baseUrl: KALSHI_BASE_URL,
      defaultPollIntervalMs: 120_000, // 2 minutes
    };
  }

  /**
   * Fetch all open markets from Kalshi.
   *
   * Strategy: use GET /events?status=open&with_nested_markets=true
   * This gives us events grouped with their markets, so we get
   * both the event context (category, title) and market-level prices.
   *
   * Each binary market becomes one NormalizedEvent with Yes/No outcomes.
   */
  async fetchEvents(): Promise<NormalizedEvent[]> {
    const allMarkets: { market: KalshiMarket; category?: string; eventTitle?: string }[] = [];
    let cursor = '';

    for (let page = 0; page < MAX_PAGES; page++) {
      try {
        const params: Record<string, any> = {
          status: 'open',
          with_nested_markets: true,
          limit: 200, // Kalshi max for events endpoint
        };

        if (cursor) {
          params.cursor = cursor;
        }

        const { data } = await this.http.get<KalshiEventsResponse>('/events', { params });

        if (!data?.events || data.events.length === 0) {
          break;
        }

        // Flatten: each market within each event becomes a NormalizedEvent
        for (const event of data.events) {
          if (event.markets) {
            for (const market of event.markets) {
              // Include active/open binary markets (Kalshi uses "active" not "open" for market status)
              const isOpen = market.status === 'active' || market.status === 'open';
              if (isOpen && market.market_type === 'binary') {
                allMarkets.push({
                  market,
                  category: event.category,
                  eventTitle: event.title,
                });
              }
            }
          }
        }

        cursor = data.cursor;
        if (!cursor) break;

        // Rate limiting
        await this.sleep(200);
      } catch (error) {
        this.logger.error(`Failed to fetch Kalshi events page ${page}: ${error.message}`);
        break;
      }
    }

    this.logger.log(`Fetched ${allMarkets.length} open markets from Kalshi`);

    return allMarkets
      .map(({ market, category, eventTitle }) => this.normalizeMarket(market, category, eventTitle))
      .filter((e): e is NormalizedEvent => e !== null);
  }

  /**
   * Convert a Kalshi market to our normalized format.
   */
  private normalizeMarket(
    market: KalshiMarket,
    category?: string,
    eventTitle?: string,
  ): NormalizedEvent | null {
    try {
      const outcomes = this.parseOutcomes(market);
      if (outcomes.length === 0) return null;

      // Determine end date from close_time or expiration_time
      const endDate = market.close_time
        ? new Date(market.close_time)
        : market.expiration_time
          ? new Date(market.expiration_time)
          : undefined;

      // Build URL: /markets/<event_ticker>/<title-slug>/<market_ticker>
      const eventTickerSlug = market.event_ticker.toLowerCase();
      const titleSlug = this.toKebabCase(eventTitle || market.title);
      const marketTickerSlug = market.ticker.toLowerCase();
      const url = `${KALSHI_BASE_URL}/markets/${eventTickerSlug}/${titleSlug}/${marketTickerSlug}`;

      return {
        externalId: market.ticker,
        title: market.title,
        description: market.subtitle || undefined,
        category: category || undefined,
        endDate,
        status: EventStatus.ACTIVE,
        outcomeType: OutcomeType.BINARY,
        outcomes,
        url,
        metadata: {
          eventTicker: market.event_ticker,
          marketType: market.market_type,
          volume: market.volume,
          volume24h: market.volume_24h,
          openInterest: market.open_interest,
          liquidity: market.liquidity,
          lastPriceCents: market.last_price,
          yesBidCents: market.yes_bid,
          yesAskCents: market.yes_ask,
          noBidCents: market.no_bid,
          noAskCents: market.no_ask,
        },
      };
    } catch (error) {
      this.logger.warn(`Failed to normalize Kalshi market ${market.ticker}: ${error.message}`);
      return null;
    }
  }

  /**
   * Convert a title to a kebab-case slug for Kalshi URLs.
   * "Serie A Relegation" → "serie-a-relegation"
   */
  private toKebabCase(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '') // remove special chars
      .replace(/\s+/g, '-') // spaces → hyphens
      .replace(/-+/g, '-') // collapse multiple hyphens
      .replace(/^-|-$/g, ''); // trim hyphens
  }

  /**
   * Parse Yes/No outcomes from a Kalshi market.
   *
   * Kalshi prices are in cents (0-99). We normalize to 0.0 - 1.0.
   * We use last_price for the primary indicator, with ask prices as metadata.
   */
  private parseOutcomes(market: KalshiMarket): NormalizedOutcome[] {
    // Primary: use last_price (cents) / 100 for Yes probability
    // No probability = 1 - Yes probability
    const yesPrice = this.centsToDecimal(market.last_price);
    const noPrice = 1 - yesPrice;

    // Skip markets with no price data
    if (yesPrice === 0 && market.yes_ask === 0) {
      return [];
    }

    const volume24h = market.volume_24h || 0;

    return [
      {
        externalId: `${market.ticker}-yes`,
        name: 'Yes',
        price: yesPrice,
        volume24h,
        metadata: {
          bidCents: market.yes_bid,
          askCents: market.yes_ask,
          bidDollars: market.yes_bid_dollars,
          askDollars: market.yes_ask_dollars,
        },
      },
      {
        externalId: `${market.ticker}-no`,
        name: 'No',
        price: noPrice,
        volume24h,
        metadata: {
          bidCents: market.no_bid,
          askCents: market.no_ask,
          bidDollars: market.no_bid_dollars,
          askDollars: market.no_ask_dollars,
        },
      },
    ];
  }

  /**
   * Convert Kalshi cents (0-99) to decimal probability (0.0 - 1.0).
   */
  private centsToDecimal(cents: number): number {
    if (!cents || cents < 0) return 0;
    if (cents > 100) return 1;
    return cents / 100;
  }

  /**
   * Fetch the order book for a specific arbitrage leg.
   *
   * Kalshi orderbook endpoint: GET /markets/{ticker}/orderbook
   * Returns yes/no arrays of [price_in_cents, quantity] pairs.
   *
   * Kalshi's model: the "yes" array = bids for Yes contracts.
   * To BUY Yes  → take from the no-bids  (sellers of No = buyers of Yes inverse)
   * Actually Kalshi returns the book as:
   *   yes[i] = [cents, qty]  meaning someone will BUY Yes at that price
   *   no[i]  = [cents, qty]  meaning someone will BUY No  at that price
   *
   * For us (buying), the ask price for Yes = 100 - best_no_bid (cents).
   * For us (buying), the ask price for No  = 100 - best_yes_bid (cents).
   */
  async fetchOrderBook(leg: ArbitrageLeg): Promise<OrderBook | null> {
    const ticker = leg.eventExternalId;

    if (!ticker) {
      this.logger.warn(`Cannot fetch Kalshi orderbook: missing ticker in leg`);
      return null;
    }

    try {
      const { data } = await this.http.get<KalshiOrderBookResponse>(
        `/markets/${ticker}/orderbook`,
        { timeout: 10_000 },
      );

      if (!data?.orderbook) return null;

      const { yes: yesBids, no: noBids } = data.orderbook;
      const isNo = leg.outcomeName.toLowerCase() === 'no';

      if (isNo) {
        // Buying No: ask price for No = 100 - yes_bid (in cents)
        // Sorted by yes_bid DESC → ask price ASC
        const asks: OrderBookEntry[] = (yesBids || [])
          .map(([priceCents, qty]) => ({
            price: (100 - priceCents) / 100,
            quantity: qty,
          }))
          .filter((e) => e.price > 0 && e.price < 1)
          .sort((a, b) => a.price - b.price);

        const bids: OrderBookEntry[] = (noBids || [])
          .map(([priceCents, qty]) => ({
            price: priceCents / 100,
            quantity: qty,
          }))
          .filter((e) => e.price > 0 && e.price < 1)
          .sort((a, b) => b.price - a.price);

        return { bids, asks, timestamp: Date.now() };
      }

      // Buying Yes: ask price for Yes = 100 - no_bid (in cents)
      const asks: OrderBookEntry[] = (noBids || [])
        .map(([priceCents, qty]) => ({
          price: (100 - priceCents) / 100,
          quantity: qty,
        }))
        .filter((e) => e.price > 0 && e.price < 1)
        .sort((a, b) => a.price - b.price);

      const bids: OrderBookEntry[] = (yesBids || [])
        .map(([priceCents, qty]) => ({
          price: priceCents / 100,
          quantity: qty,
        }))
        .filter((e) => e.price > 0 && e.price < 1)
        .sort((a, b) => b.price - a.price);

      return { bids, asks, timestamp: Date.now() };
    } catch (error) {
      this.logger.error(
        `Failed to fetch Kalshi orderbook for ${ticker}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Health check — try to reach the exchange status endpoint.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const { data } = await this.http.get('/exchange/status', {
        timeout: 5_000,
      });
      return !!data;
    } catch {
      return false;
    }
  }
}

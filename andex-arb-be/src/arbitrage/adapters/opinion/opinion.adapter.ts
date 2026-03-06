import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Ws from 'ws';
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
  OpinionApiResponse,
  OpinionMarket,
  OpinionMarketListResult,
  OpinionChildMarket,
  OpinionDepthDiffMessage,
  OpinionOrderbookEntry,
  OpinionHttpOrderbookResult,
} from './opinion.types';

const OPINION_API_BASE = 'https://openapi.opinion.trade/openapi';
const OPINION_WS_URL = 'wss://ws.opinion.trade';
const OPINION_BASE_URL = 'https://app.opinion.trade';

const MAX_PAGES = 100;
const PAGE_LIMIT = 20; // API max
const HEARTBEAT_INTERVAL_MS = 30_000;
const WS_RECONNECT_DELAY_MS = 5_000;

@Injectable()
export class OpinionAdapter extends BaseAdapter implements OnModuleInit, OnModuleDestroy {
  readonly platformSlug = 'opinion';
  readonly platformName = 'Opinion';

  private readonly apiKey: string;

  // tokenId -> orderbook entry (bids/asks maps)
  private readonly orderbookCache = new Map<string, OpinionOrderbookEntry>();

  // marketIds subscribed via WebSocket (used for resubscription on reconnect)
  private readonly subscribedMarkets = new Set<number>();

  private ws: Ws.WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  /** Called by PriceStreamService to receive live best-ask updates from WS */
  private priceUpdateCallback?: (tokenId: string, bestAsk: number) => void;

  setPriceUpdateCallback(fn: (tokenId: string, bestAsk: number) => void): void {
    this.priceUpdateCallback = fn;
  }

  constructor(
    private readonly configService: ConfigService,
    private readonly registry: AdapterRegistry,
  ) {
    const apiKey = configService.get<string>('OPINION_API_KEY') || '';
    super(OPINION_API_BASE, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'andex-arb-engine/1.0',
        apikey: apiKey,
      },
    });
    this.apiKey = apiKey;
  }

  onModuleInit() {
    this.registry.register(this);
    // WS is started by PriceStreamService after HTTP orderbook init
  }

  onModuleDestroy() {
    this.destroyed = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
  }

  getPlatformInfo(): PlatformInfo {
    return {
      slug: this.platformSlug,
      name: this.platformName,
      baseUrl: OPINION_BASE_URL,
      defaultPollIntervalMs: 120_000, // 2 minutes
    };
  }

  // ───────────────────────── WebSocket ─────────────────────────

  private connectWebSocket(): void {
    if (this.destroyed) return;

    const url = `${OPINION_WS_URL}?apikey=${this.apiKey}`;
    this.logger.log('Connecting to Opinion WebSocket...');

    const ws = new Ws.WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.logger.log('Opinion WebSocket connected');
      this.startHeartbeat();
      // Resubscribe all known markets after reconnect
      for (const marketId of this.subscribedMarkets) {
        this.sendSubscribe(marketId);
      }
    });

    ws.on('message', (raw: Ws.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.msgType === 'market.depth.diff') {
          this.handleDepthDiff(msg as OpinionDepthDiffMessage);
        }
      } catch {
        // ignore malformed frames
      }
    });

    ws.on('error', (err: Error) => {
      this.logger.warn(`Opinion WebSocket error: ${err.message}`);
    });

    ws.on('close', (code: number) => {
      this.logger.warn(`Opinion WebSocket closed (code=${code}), reconnecting in ${WS_RECONNECT_DELAY_MS}ms`);
      this.clearTimers();
      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.connectWebSocket(), WS_RECONNECT_DELAY_MS);
      }
    });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === Ws.WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ action: 'HEARTBEAT' }));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private sendSubscribe(marketId: number): void {
    if (this.ws?.readyState === Ws.WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({ action: 'SUBSCRIBE', channel: 'market.depth.diff', marketId }),
      );
    }
  }

  /**
   * Called by PriceStreamService after HTTP orderbook init.
   * Connects WS and subscribes to the given marketIds only.
   */
  startWebSocket(marketIds: number[]): void {
    for (const id of marketIds) {
      this.subscribedMarkets.add(id);
    }
    this.connectWebSocket();
  }

  /**
   * Subscribe to additional markets when new verified matches are found.
   */
  addSubscriptions(marketIds: number[]): void {
    for (const id of marketIds) {
      if (!this.subscribedMarkets.has(id)) {
        this.subscribedMarkets.add(id);
        this.sendSubscribe(id);
      }
    }
  }

  private handleDepthDiff(msg: OpinionDepthDiffMessage): void {
    const { tokenId, side, price, size } = msg;
    if (!tokenId || !price) return;

    if (!this.orderbookCache.has(tokenId)) {
      this.orderbookCache.set(tokenId, { bids: new Map(), asks: new Map() });
    }

    const entry = this.orderbookCache.get(tokenId)!;
    const book = side === 'bids' ? entry.bids : entry.asks;
    const sizeNum = parseFloat(size);

    if (isNaN(sizeNum) || sizeNum === 0) {
      book.delete(price);
    } else {
      book.set(price, sizeNum);
    }

    // Notify PriceStreamService so it can update DB price and trigger scan
    if (this.priceUpdateCallback && side === 'asks') {
      const bestAsk = this.bestAskPrice(tokenId);
      if (bestAsk !== null) this.priceUpdateCallback(tokenId, bestAsk);
    }
  }

  // ───────────────────────── fetchEvents ─────────────────────────

  async fetchEvents(): Promise<NormalizedEvent[]> {
    const allMarkets: OpinionMarket[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      try {
        const { data } = await this.http.get<OpinionApiResponse<OpinionMarketListResult>>(
          '/market',
          {
            params: {
              page,
              limit: PAGE_LIMIT,
              status: 'activated',
              marketType: 2, // all types
              sortBy: 5, // volume24h desc
            },
          },
        );

        if (data?.errno !== 0 || !data?.result?.list) {
          this.logger.warn(
            `Opinion API error (page ${page}): errno=${data?.errno}, msg=${data?.errmsg}`,
          );
          break;
        }

        const markets = data.result.list;
        if (markets.length === 0) break;

        allMarkets.push(...markets);

        if (allMarkets.length >= data.result.total || markets.length < PAGE_LIMIT) break;

        // 15 req/s limit → ~70ms minimum between requests; use 100ms to be safe
        await this.sleep(100);
      } catch (error) {
        this.logger.error(`Failed to fetch Opinion markets page ${page}: ${error.message}`);
        break;
      }
    }

    this.logger.log(`Fetched ${allMarkets.length} active markets from Opinion`);

    return allMarkets
      .map((market) => this.normalizeMarket(market))
      .filter((e): e is NormalizedEvent => e !== null);
  }

  // ───────────────────────── fetchOrderBook ─────────────────────────

  async fetchOrderBook(leg: ArbitrageLeg): Promise<OrderBook | null> {
    const tokenId = leg.metadata?.tokenId;
    if (!tokenId) {
      this.logger.warn(
        `Cannot fetch order book for Opinion leg "${leg.outcomeName}": missing tokenId in metadata`,
      );
      return null;
    }

    // If cache is empty for this token, fetch the full snapshot via HTTP first
    const cached = this.orderbookCache.get(tokenId);
    if (!cached || (cached.bids.size === 0 && cached.asks.size === 0)) {
      await this.fetchInitialOrderbook(tokenId);
    }

    const entry = this.orderbookCache.get(tokenId);
    if (!entry || (entry.bids.size === 0 && entry.asks.size === 0)) {
      return null;
    }

    const bids: OrderBookEntry[] = Array.from(entry.bids.entries())
      .map(([price, quantity]) => ({ price: parseFloat(price), quantity }))
      .filter((e) => !isNaN(e.price))
      .sort((a, b) => b.price - a.price); // best bid first

    const asks: OrderBookEntry[] = Array.from(entry.asks.entries())
      .map(([price, quantity]) => ({ price: parseFloat(price), quantity }))
      .filter((e) => !isNaN(e.price))
      .sort((a, b) => a.price - b.price); // best ask first

    return { bids, asks, timestamp: Date.now() };
  }

  /**
   * Fetch a full orderbook snapshot from HTTP and seed the cache.
   * Called lazily when fetchOrderBook() encounters an empty cache entry.
   * Endpoint: GET /token/orderbook?token_id={tokenId}
   */
  private async fetchInitialOrderbook(tokenId: string): Promise<void> {
    try {
      const { data } = await this.http.get<OpinionApiResponse<OpinionHttpOrderbookResult>>(
        '/token/orderbook',
        { params: { token_id: tokenId }, timeout: 10_000 },
      );

      if (data?.errno !== 0 || !data?.result) return;

      const { bids, asks } = data.result;

      if (!this.orderbookCache.has(tokenId)) {
        this.orderbookCache.set(tokenId, { bids: new Map(), asks: new Map() });
      }

      const entry = this.orderbookCache.get(tokenId)!;

      for (const level of bids || []) {
        const size = parseFloat(level.size);
        if (!isNaN(size) && size > 0) entry.bids.set(level.price, size);
      }
      for (const level of asks || []) {
        const size = parseFloat(level.size);
        if (!isNaN(size) && size > 0) entry.asks.set(level.price, size);
      }
    } catch (error) {
      this.logger.warn(`Failed to fetch initial orderbook for token ${tokenId.slice(0, 16)}...: ${error.message}`);
    }
  }

  // ───────────────────────── Normalization ─────────────────────────

  private normalizeMarket(market: OpinionMarket): NormalizedEvent | null {
    try {
      if (!market.marketId || !market.marketTitle) return null;

      if (market.marketType === 1 && market.childMarkets?.length) {
        return this.normalizeCategoricalMarket(market);
      }

      return this.normalizeBinaryMarket(market);
    } catch (error) {
      this.logger.warn(`Failed to normalize Opinion market ${market.marketId}: ${error.message}`);
      return null;
    }
  }

  private normalizeCategoricalMarket(market: OpinionMarket): NormalizedEvent | null {
    const outcomes = this.parseCategoricalOutcomes(market.childMarkets!);
    if (outcomes.length === 0) return null;

    return {
      externalId: `cat-${market.marketId}`,
      title: market.marketTitle,
      description: market.rules || undefined,
      endDate: market.cutoffAt ? new Date(market.cutoffAt * 1000) : undefined,
      status: EventStatus.ACTIVE,
      outcomeType: OutcomeType.MULTI,
      outcomes,
      url: `${OPINION_BASE_URL}/detail?topicId=${market.marketId}`,
      metadata: {
        topicId: market.marketId,
        type: 'categorical',
        chainId: market.chainId,
        volume: market.volume,
        volume24h: market.volume24h,
        volume7d: market.volume7d,
        childCount: market.childMarkets!.length,
      },
    };
  }

  private normalizeBinaryMarket(market: OpinionMarket): NormalizedEvent | null {
    const outcomes = this.parseBinaryOutcomes(market);
    if (outcomes.length === 0) return null;

    return {
      externalId: `bin-${market.marketId}`,
      title: market.marketTitle,
      description: market.rules || undefined,
      endDate: market.cutoffAt ? new Date(market.cutoffAt * 1000) : undefined,
      status: EventStatus.ACTIVE,
      outcomeType: OutcomeType.BINARY,
      outcomes,
      url: `${OPINION_BASE_URL}/detail?topicId=${market.marketId}`,
      metadata: {
        topicId: market.marketId,
        type: 'binary',
        chainId: market.chainId,
        questionId: market.questionId,
        volume: market.volume,
        volume24h: market.volume24h,
        volume7d: market.volume7d,
      },
    };
  }

  // ───────────────────────── Outcome Parsing ─────────────────────────

  private parseCategoricalOutcomes(children: OpinionChildMarket[]): NormalizedOutcome[] {
    return children
      .filter((child) => child.status === 2)
      .map((child) => {
        const price = this.bestAskPrice(child.yesTokenId) ?? 0;

        return {
          externalId: child.questionId || `${child.marketId}-yes`,
          name: child.marketTitle.trim(),
          price: this.clampPrice(price),
          volume24h: child.volume24h ? parseFloat(child.volume24h) : undefined,
          metadata: {
            tokenId: child.yesTokenId,
            noTokenId: child.noTokenId,
            side: 'yes',
            questionId: child.questionId,
            chainId: child.chainId,
            topicId: child.marketId,
          },
        };
      })
      .filter((o) => o.name);
  }

  private parseBinaryOutcomes(market: OpinionMarket): NormalizedOutcome[] {
    const { yesTokenId, noTokenId } = market;
    if (!yesTokenId || !noTokenId) return [];

    const yesPrice = this.bestAskPrice(yesTokenId) ?? 0;
    const noPrice = this.bestAskPrice(noTokenId) ?? 0;

    const volume24h = market.volume24h ? parseFloat(market.volume24h) : undefined;

    return [
      {
        externalId: market.questionId || `${market.marketId}-yes`,
        name: market.yesLabel || 'Yes',
        price: this.clampPrice(yesPrice),
        volume24h,
        metadata: {
          tokenId: yesTokenId,
          noTokenId,
          side: 'yes',
          questionId: market.questionId,
          chainId: market.chainId,
          topicId: market.marketId,
        },
      },
      {
        externalId: noTokenId || `${market.marketId}-no`,
        name: market.noLabel || 'No',
        price: this.clampPrice(noPrice),
        volume24h,
        metadata: {
          tokenId: noTokenId,
          noTokenId: yesTokenId,
          side: 'no',
          questionId: market.questionId,
          chainId: market.chainId,
          topicId: market.marketId,
        },
      },
    ];
  }

  // ───────────────────────── Helpers ─────────────────────────

  /**
   * Returns the best ask price (lowest ask) from the orderbook cache for a given token.
   * This represents the current "buy" price.
   */
  private bestAskPrice(tokenId: string): number | null {
    const entry = this.orderbookCache.get(tokenId);
    if (!entry || entry.asks.size === 0) return null;

    let best = Infinity;
    for (const price of entry.asks.keys()) {
      const p = parseFloat(price);
      if (!isNaN(p) && p < best) best = p;
    }
    return best === Infinity ? null : best;
  }

  private clampPrice(price: number): number {
    if (!price || price < 0) return 0;
    if (price > 1) return 1;
    return price;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const { data } = await this.http.get<OpinionApiResponse<any>>('/market', {
        params: { page: 1, limit: 1, status: 'activated' },
        timeout: 5_000,
      });
      return data?.errno === 0;
    } catch {
      return false;
    }
  }
}

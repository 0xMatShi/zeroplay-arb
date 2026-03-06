import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as Ws from 'ws';
import { ConfigService } from '@nestjs/config';
import { Outcome } from '../entities/outcome.entity';
import { MatchingService } from './matching.service';
import { EventFetcherService } from './event-fetcher.service';
import { EventMatch } from '../entities/event-match.entity';

const POLY_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PROB_WS_URL = 'wss://ws.probable.markets/public/api/v1/ws?chainId=56';
const PF_WS_URL = 'wss://ws.predict.fun/ws';

const PING_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 5_000;
const INIT_DELAY_MS = 3_000;
const SCAN_DEBOUNCE_MS = 1_000;
const PROB_CHUNK_SIZE = 50;
const PF_CHUNK_SIZE = 20;
const PF_CHUNK_DELAY_MS = 300;

/**
 * Real-time price stream service.
 *
 * Subscribes to Polymarket, Probable, and Predict.fun WebSocket streams for all
 * verified match tokens. Updates Outcome prices in DB on every tick and triggers
 * a debounced scan cycle via the registered callback.
 *
 * On startup, HTTP order books are fetched first to initialize prices (especially
 * important for Probable/Predict.fun which only push on market activity).
 *
 * Polymarket protocol: wss://ws-subscriptions-clob.polymarket.com/ws/market
 *   subscribe: { assets_ids: [...], type: "market" }
 *   events:    book { asset_id, asks[0].price } | price_change { price_changes[].best_ask }
 *
 * Probable protocol: wss://ws.probable.markets/public/api/v1/ws?chainId=56
 *   subscribe: { id, method: "SUBSCRIBE", params: ["book:tokenId", ...] } (chunks of 50)
 *   events:    { stream: "book:tokenId", data: { asks: [{price}] } }  asks sorted DESC
 *
 * Predict.fun protocol: wss://ws.predict.fun/ws
 *   subscribe: { method: "subscribe", requestId: N, params: ["predictOrderbook/{marketId}"] }
 *   heartbeat: server { type:"M", topic:"heartbeat", data: ts } → client { method:"heartbeat", data: ts }
 *   events:    { type:"M", topic:"predictOrderbook/{id}", data: { asks:[[p,q]], bids:[[p,q]] } }
 *   Yes price = asks[0][0], No price = 1 - bids[0][0]
 */
@Injectable()
export class PriceStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PriceStreamService.name);

  // ── Polymarket & Probable: token_id → Outcome ──
  private readonly tokenOutcomes = new Map<string, Outcome>();
  private readonly polyTokens = new Set<string>();
  private readonly probTokens = new Set<string>();

  // ── Predict.fun: marketId → { yes?, no? } outcomes ──
  /** marketId (as string) → Yes/No outcome entities for that market */
  private readonly pfMarketOutcomes = new Map<string, { yes?: Outcome; no?: Outcome }>();
  private readonly pfMarketIds = new Set<string>();

  // ── Polymarket WS ──
  private polyWs: Ws.WebSocket | null = null;
  private polyPingTimer: NodeJS.Timeout | null = null;
  private polyReconnTimer: NodeJS.Timeout | null = null;

  // ── Probable WS ──
  private probWs: Ws.WebSocket | null = null;
  private probReconnTimer: NodeJS.Timeout | null = null;
  private probRequestId = 0;

  // ── Predict.fun WS ──
  private pfWs: Ws.WebSocket | null = null;
  private pfReconnTimer: NodeJS.Timeout | null = null;
  private pfRequestId = 0;

  // ── Kalshi: HTTP polling cache ──
  /** All scannable matches that include at least one Kalshi event */
  private kalshiMatches: EventMatch[] = [];

  // ── Scan trigger ──
  private scanCallback: (() => Promise<void>) | null = null;
  private scanDebounce: NodeJS.Timeout | null = null;

  private destroyed = false;

  private readonly pfApiKey: string | undefined;

  constructor(
    @InjectRepository(Outcome)
    private readonly outcomeRepo: Repository<Outcome>,
    private readonly matchingService: MatchingService,
    private readonly eventFetcherService: EventFetcherService,
    private readonly configService: ConfigService,
  ) {
    this.pfApiKey = configService.get<string>('PREDICT_FUN_API_KEY');
  }

  onModuleInit(): void {
    setTimeout(() => this.loadAndConnect(), INIT_DELAY_MS);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.cleanup();
  }

  setScanCallback(fn: () => Promise<void>): void {
    this.scanCallback = fn;
  }

  async refreshSubscriptions(): Promise<void> {
    const matches = await this.matchingService.getScannableMatches();

    // Keep kalshiMatches in sync
    this.kalshiMatches = matches.filter((m) =>
      (m.events || []).some((e) => e.platform?.slug === 'kalshi'),
    );

    const newPolyTokens: string[] = [];
    const newProbTokens: string[] = [];
    const newPfMarketIds: string[] = [];

    for (const match of matches) {
      this.extractTokens(match, newPolyTokens, newProbTokens, newPfMarketIds);
    }

    const hasNew = newPolyTokens.length > 0 || newProbTokens.length > 0 || newPfMarketIds.length > 0;

    if (hasNew) {
      // Initialize prices for new matches via HTTP before WS subscription
      const newMatches = matches.filter((m) =>
        (m.events || []).some((e) =>
          (e.outcomes || []).some((o) => {
            const tid: string = o.metadata?.tokenId || o.externalId;
            const mid = String(o.metadata?.marketId ?? '');
            return newPolyTokens.includes(tid) || newProbTokens.includes(tid) || newPfMarketIds.includes(mid);
          }),
        ),
      );
      if (newMatches.length > 0) {
        this.logger.log(`Initializing prices for ${newMatches.length} new matches via HTTP...`);
        await this.eventFetcherService.refreshPricesViaOrderBooks(newMatches);
      }
    }

    if (newPolyTokens.length > 0) {
      this.logger.log(`New Polymarket tokens: ${newPolyTokens.length}`);
      this.subscribePolymarketTokens(newPolyTokens);
    }
    if (newProbTokens.length > 0) {
      this.logger.log(`New Probable tokens: ${newProbTokens.length}`);
      this.connectProbable();
    }
    if (newPfMarketIds.length > 0) {
      this.logger.log(`New Predict.fun markets: ${newPfMarketIds.length}`);
      this.connectPredictFun();
    }
  }

  // ─────────────────────── Init ───────────────────────

  private async loadAndConnect(): Promise<void> {
    try {
      const matches = await this.matchingService.getScannableMatches();

      for (const match of matches) {
        this.extractTokens(match, null, null, null);
      }
      this.kalshiMatches = matches.filter((m) =>
        (m.events || []).some((e) => e.platform?.slug === 'kalshi'),
      );

      this.logger.log(
        `Price stream: ${this.polyTokens.size} Polymarket tokens, ` +
        `${this.probTokens.size} Probable tokens, ` +
        `${this.pfMarketIds.size} Predict.fun markets`,
      );

      // Initialize prices via HTTP before WS.
      // Probable and Predict.fun only push updates on market activity —
      // without this, quiet markets would have price=0 until someone trades.
      if (matches.length > 0) {
        this.logger.log(`Initializing prices via HTTP order books for ${matches.length} matches...`);
        await this.eventFetcherService.refreshPricesViaOrderBooks(matches);
        this.logger.log('HTTP price init complete — connecting WebSockets');
      }

      this.connectPolymarket();
      this.connectProbable();
      this.connectPredictFun();
    } catch (error) {
      this.logger.error(`PriceStreamService init failed: ${error.message}`);
    }
  }

  private extractTokens(
    match: EventMatch,
    newPolyTokens: string[] | null,
    newProbTokens: string[] | null,
    newPfMarketIds: string[] | null,
  ): void {
    for (const event of match.events || []) {
      const slug = event.platform?.slug;
      if (!slug || !['polymarket', 'probable', 'predict-fun'].includes(slug)) continue;

      for (const outcome of event.outcomes || []) {
        if (slug === 'predict-fun') {
          const marketId = String(outcome.metadata?.marketId ?? '');
          const side = outcome.metadata?.side as 'yes' | 'no' | undefined;
          if (!marketId || !side) continue;

          if (!this.pfMarketOutcomes.has(marketId)) {
            this.pfMarketOutcomes.set(marketId, {});
          }
          this.pfMarketOutcomes.get(marketId)![side] = outcome;

          if (!this.pfMarketIds.has(marketId)) {
            this.pfMarketIds.add(marketId);
            newPfMarketIds?.push(marketId);
          }
          continue;
        }

        const tokenId: string = outcome.metadata?.tokenId || outcome.externalId;
        if (!tokenId) continue;

        this.tokenOutcomes.set(tokenId, outcome);

        if (slug === 'polymarket') {
          if (!this.polyTokens.has(tokenId)) {
            this.polyTokens.add(tokenId);
            newPolyTokens?.push(tokenId);
          }
        } else {
          if (!this.probTokens.has(tokenId)) {
            this.probTokens.add(tokenId);
            newProbTokens?.push(tokenId);
          }
        }
      }
    }
  }

  // ─────────────────────── Polymarket WS ───────────────────────

  private connectPolymarket(): void {
    if (this.polyTokens.size === 0) return;

    if (this.polyReconnTimer) { clearTimeout(this.polyReconnTimer); this.polyReconnTimer = null; }
    if (this.polyPingTimer) { clearInterval(this.polyPingTimer); this.polyPingTimer = null; }
    if (this.polyWs) { this.polyWs.removeAllListeners(); this.polyWs.terminate(); this.polyWs = null; }

    const ws = new Ws.WebSocket(POLY_WS_URL);
    this.polyWs = ws;

    ws.on('open', () => {
      this.logger.log(`Polymarket WS connected (${this.polyTokens.size} tokens)`);
      ws.send(JSON.stringify({
        assets_ids: Array.from(this.polyTokens),
        type: 'market',
        custom_feature_enabled: true,
      }));
      this.polyPingTimer = setInterval(() => {
        if (ws.readyState === Ws.WebSocket.OPEN) ws.send('PING');
      }, PING_INTERVAL_MS);
    });

    ws.on('message', (raw: Ws.RawData) => {
      const text = raw.toString();
      if (text === 'PONG') return;
      try { this.handlePolymarketMessage(JSON.parse(text)); } catch { /* ignore */ }
    });

    ws.on('close', (code, reason) => {
      if (this.polyPingTimer) { clearInterval(this.polyPingTimer); this.polyPingTimer = null; }
      if (!this.destroyed) {
        this.logger.warn(`Polymarket WS disconnected (code=${code} reason=${reason}), reconnecting...`);
        this.polyReconnTimer = setTimeout(() => this.connectPolymarket(), RECONNECT_DELAY_MS);
      }
    });

    ws.on('error', (err) => this.logger.error(`Polymarket WS error: ${err.message}`));
  }

  private subscribePolymarketTokens(tokens: string[]): void {
    if (tokens.length === 0) return;
    if (this.polyWs?.readyState === Ws.WebSocket.OPEN) {
      this.polyWs.send(JSON.stringify({ operation: 'subscribe', assets_ids: tokens }));
    } else {
      this.connectPolymarket();
    }
  }

  private handlePolymarketMessage(msg: Record<string, unknown>): void {
    if (!msg?.event_type) return;

    if (msg.event_type === 'book') {
      const tokenId = msg.asset_id as string;
      const asks = msg.asks as Array<{ price: string }> | undefined;
      const bestAsk = asks?.[0]?.price;
      if (tokenId && bestAsk != null) this.applyPriceUpdate(tokenId, parseFloat(bestAsk));
    } else if (msg.event_type === 'price_change') {
      const changes = msg.price_changes as Array<{ asset_id: string; best_ask?: string }>;
      if (Array.isArray(changes)) {
        for (const c of changes) {
          if (c.best_ask != null) this.applyPriceUpdate(c.asset_id, parseFloat(c.best_ask));
        }
      }
    }
  }

  // ─────────────────────── Probable WS ───────────────────────

  private connectProbable(): void {
    if (this.probTokens.size === 0) return;

    if (this.probReconnTimer) { clearTimeout(this.probReconnTimer); this.probReconnTimer = null; }
    if (this.probWs) { this.probWs.removeAllListeners(); this.probWs.terminate(); this.probWs = null; }

    const ws = new Ws.WebSocket(PROB_WS_URL);
    this.probWs = ws;

    ws.on('open', () => {
      this.logger.log(`Probable WS connected (${this.probTokens.size} tokens)`);
      this.sendProbableSubscribe(ws, Array.from(this.probTokens));
    });

    ws.on('message', (raw: Ws.RawData) => {
      const text = raw.toString();
      if (text === 'PONG') return;
      try { this.handleProbableMessage(JSON.parse(text)); } catch { /* ignore */ }
    });

    ws.on('close', (code, reason) => {
      if (!this.destroyed) {
        this.logger.warn(`Probable WS disconnected (code=${code} reason=${reason}), reconnecting...`);
        this.probReconnTimer = setTimeout(() => this.connectProbable(), RECONNECT_DELAY_MS);
      }
    });

    ws.on('error', (err) => this.logger.error(`Probable WS error: ${err.message}`));
  }

  private sendProbableSubscribe(ws: Ws.WebSocket, tokenIds: string[]): void {
    // Split into chunks — Probable server rejects messages with too many topics
    for (let i = 0; i < tokenIds.length; i += PROB_CHUNK_SIZE) {
      const chunk = tokenIds.slice(i, i + PROB_CHUNK_SIZE);
      const topics = chunk.map((id) => `book:${id}`);
      ws.send(JSON.stringify({ id: ++this.probRequestId, method: 'SUBSCRIBE', params: topics }));
    }
  }

  private handleProbableMessage(msg: Record<string, unknown>): void {
    if ('id' in msg && 'status' in msg) return;

    if (msg.stream && msg.data) {
      const stream = msg.stream as string;
      const tokenId = stream.startsWith('book:') ? stream.slice(5) : undefined;

      const data = msg.data as Record<string, unknown>;
      const asks = data.asks as Array<{ price: string }> | undefined;

      // Probable asks are sorted DESCENDING — best ask is the last element
      const bestAsk = asks && asks.length > 0 ? asks[asks.length - 1].price : undefined;

      if (tokenId && bestAsk != null) this.applyPriceUpdate(tokenId, parseFloat(bestAsk));
    }
  }

  // ─────────────────────── Predict.fun WS ───────────────────────

  private connectPredictFun(): void {
    if (this.pfMarketIds.size === 0) return;

    if (this.pfReconnTimer) { clearTimeout(this.pfReconnTimer); this.pfReconnTimer = null; }
    if (this.pfWs) { this.pfWs.removeAllListeners(); this.pfWs.terminate(); this.pfWs = null; }

    const wsOptions = this.pfApiKey ? { headers: { 'x-api-key': this.pfApiKey } } : undefined;
    const ws = new Ws.WebSocket(PF_WS_URL, wsOptions);
    this.pfWs = ws;

    ws.on('open', () => {
      this.logger.log(`Predict.fun WS connected (${this.pfMarketIds.size} markets)`);
      this.sendPredictFunSubscribe(ws, Array.from(this.pfMarketIds));
    });

    ws.on('message', (raw: Ws.RawData) => {
      try { this.handlePredictFunMessage(JSON.parse(raw.toString())); } catch { /* ignore */ }
    });

    ws.on('close', (code, reason) => {
      if (!this.destroyed) {
        this.logger.warn(`Predict.fun WS disconnected (code=${code} reason=${reason}), reconnecting...`);
        this.pfReconnTimer = setTimeout(() => this.connectPredictFun(), RECONNECT_DELAY_MS);
      }
    });

    ws.on('error', (err) => this.logger.error(`Predict.fun WS error: ${err.message}`));
  }

  private sendPredictFunSubscribe(ws: Ws.WebSocket, marketIds: string[]): void {
    let chunkIndex = 0;
    const sendNextChunk = () => {
      if (chunkIndex >= marketIds.length || ws.readyState !== Ws.WebSocket.OPEN) return;
      const chunk = marketIds.slice(chunkIndex, chunkIndex + PF_CHUNK_SIZE);
      ws.send(JSON.stringify({
        method: 'subscribe',
        requestId: ++this.pfRequestId,
        params: chunk.map((id) => `predictOrderbook/${id}`),
      }));
      chunkIndex += PF_CHUNK_SIZE;
      if (chunkIndex < marketIds.length) {
        setTimeout(sendNextChunk, PF_CHUNK_DELAY_MS);
      }
    };
    sendNextChunk();
  }

  private handlePredictFunMessage(msg: Record<string, unknown>): void {
    if (msg.type !== 'M') return;

    const topic = msg.topic as string;

    // Heartbeat — MUST respond or server terminates the connection within 15s
    if (topic === 'heartbeat') {
      if (this.pfWs?.readyState === Ws.WebSocket.OPEN) {
        this.pfWs.send(JSON.stringify({ method: 'heartbeat', data: msg.data }));
      }
      return;
    }

    // Orderbook update: topic = "predictOrderbook/{marketId}"
    if (topic?.startsWith('predictOrderbook/')) {
      const marketId = topic.split('/')[1];
      const ob = msg.data as { asks?: [number, number][]; bids?: [number, number][] } | undefined;
      if (!ob) return;

      const outcomes = this.pfMarketOutcomes.get(marketId);
      if (!outcomes) return;

      // Yes price = best ask (cheapest price to buy Yes)
      if (outcomes.yes) {
        const bestAsk = ob.asks?.[0]?.[0];
        if (bestAsk != null) this.applyPriceUpdateToOutcome(outcomes.yes, bestAsk);
      }

      // No price = 1 - best bid for Yes (buying No = selling Yes at best bid price)
      if (outcomes.no) {
        const bestBid = ob.bids?.[0]?.[0];
        if (bestBid != null) this.applyPriceUpdateToOutcome(outcomes.no, 1 - bestBid);
      }
    }
  }

  // ─────────────────────── Price Update ───────────────────────

  /** Generic update by tokenId — used for Polymarket and Probable. */
  private applyPriceUpdate(tokenId: string, bestAsk: number): void {
    const outcome = this.tokenOutcomes.get(tokenId);
    if (!outcome) return;
    this.applyPriceUpdateToOutcome(outcome, bestAsk);
  }

  /** Core price update logic — shared by all platforms. */
  private applyPriceUpdateToOutcome(outcome: Outcome, price: number): void {
    if (!isFinite(price) || price <= 0 || price > 1) return;

    const current = Number(outcome.price);
    if (Math.abs(current - price) < 0.0001) return;

    outcome.previousPrice = outcome.price;
    outcome.price = price;
    outcome.lastUpdatedAt = new Date();

    this.outcomeRepo.save(outcome).catch((err) => {
      this.logger.warn(`Price save failed for outcome ${outcome.id}: ${err.message}`);
    });

    this.scheduleScan();
  }

  private scheduleScan(): void {
    if (this.scanDebounce) clearTimeout(this.scanDebounce);
    this.scanDebounce = setTimeout(async () => {
      if (this.scanCallback) {
        try {
          await this.scanCallback();
        } catch (err) {
          this.logger.error(`Scan callback error: ${err.message}`);
        }
      }
    }, SCAN_DEBOUNCE_MS);
  }

  // ─────────────────────── Kalshi HTTP Polling ───────────────────────

  /**
   * Refresh Kalshi prices via HTTP order book requests (every 30s).
   * Kalshi WS requires authentication even for public channels, so we poll instead.
   */
  async refreshKalshiPrices(): Promise<void> {
    if (this.kalshiMatches.length === 0) return;
    try {
      const updated = await this.eventFetcherService.refreshPricesViaOrderBooks(this.kalshiMatches);
      if (updated > 0) {
        this.logger.log(`Kalshi HTTP poll: updated ${updated} prices`);
      }
    } catch (error) {
      this.logger.error(`Kalshi price refresh failed: ${error.message}`);
    }
  }

  // ─────────────────────── Cleanup ───────────────────────

  private cleanup(): void {
    if (this.polyPingTimer) clearInterval(this.polyPingTimer);
    if (this.polyReconnTimer) clearTimeout(this.polyReconnTimer);
    if (this.probReconnTimer) clearTimeout(this.probReconnTimer);
    if (this.pfReconnTimer) clearTimeout(this.pfReconnTimer);
    if (this.scanDebounce) clearTimeout(this.scanDebounce);
    if (this.polyWs) { this.polyWs.terminate(); this.polyWs = null; }
    if (this.probWs) { this.probWs.terminate(); this.probWs = null; }
    if (this.pfWs) { this.pfWs.terminate(); this.pfWs = null; }
  }
}

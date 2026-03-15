import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import * as Ws from 'ws';
import { PmSportsEvent, PmMarket } from '../../interfaces/sports-arb.types';
import { PolymarketSportsEventRaw } from './polymarket-sports.types';
import { PM_TAG_TO_SPORT } from '../../services/sports-constants';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

const FETCH_INTERVAL_MS = 10 * 60_000;
const WS_RECONNECT_DELAY_MS = 1_000;
const WS_PING_INTERVAL_MS = 9_000;
const PM_PAGE = 500;

/**
 * Fetches Polymarket sports events (all market types) and keeps
 * prices up to date via the CLOB WebSocket.
 */
@Injectable()
export class PolymarketSportsAdapter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PolymarketSportsAdapter.name);

  /** eventId → PmSportsEvent */
  private readonly eventCache = new Map<string, PmSportsEvent>();
  /** tokenId → { eventId, marketIndex } for WS price updates */
  private readonly tokenIndex = new Map<string, { eventId: string; conditionId: string; outcomeIdx: number }>();
  /** Only tokens from matched events — set by subscribeToMatchedEvents() */
  private activeTokenIds = new Set<string>();

  private ws: Ws.WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private fetchTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  /** Called when any market price changes via CLOB WS (set by scheduler) */
  onPriceUpdate: (() => void) | null = null;

  onModuleInit(): void {
    this.fetchEvents();
    this.fetchTimer = setInterval(() => this.fetchEvents(), FETCH_INTERVAL_MS);
  }

  /** Force an immediate fetch of PM events (called by scheduler before matching). */
  async forceFetch(): Promise<void> {
    await this.fetchEvents();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.fetchTimer) clearInterval(this.fetchTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.terminate();
  }

  getEvents(): PmSportsEvent[] {
    return [...this.eventCache.values()];
  }

  /**
   * Clears all event/token caches. The WS connection stays open but stale subscriptions
   * become inert (tokenIndex is cleared, so incoming messages match nothing).
   * Called by the scheduler before a full rematch cycle; forceFetch() + subscribeToMatchedTokens()
   * will repopulate everything on the next match cycle.
   */
  clearCache(): void {
    this.logger.log('PolymarketSports: clearing event and token caches');
    this.eventCache.clear();
    this.tokenIndex.clear();
    this.activeTokenIds.clear();
  }

  /**
   * Subscribe WS to a specific list of token IDs (matched market tokens from the scheduler).
   * More precise than subscribeToMatchedEvents — only subscribes to actually matched markets.
   */
  subscribeToMatchedTokens(tokenIds: string[]): void {
    if (tokenIds.length === 0) {
      this.logger.log('PolymarketSports: no matched tokens to subscribe');
      return;
    }

    this.activeTokenIds = new Set(tokenIds);
    this.connectWs();
    this.logger.log(`PolymarketSports: subscribing to ${tokenIds.length} matched market tokens`);
  }

  // ── Fetch events from Gamma API ──────────────────────────────

  private async fetchEvents(): Promise<void> {
    let offset = 0;
    let totalEvents = 0;
    let totalMarkets = 0;

    try {
      while (true) {
        const { data } = await axios.get<PolymarketSportsEventRaw[]>(`${GAMMA_API}/events`, {
          params: { active: true, closed: false, tag_slug: 'sports', limit: PM_PAGE, offset },
          timeout: 30_000,
        });

        const batch = Array.isArray(data) ? data : [];
        if (batch.length === 0) break;

        for (const raw of batch) {
          if (!raw.title || !raw.markets?.length) continue;
          // seriesSlug required to filter non-match events
          if (!raw.seriesSlug) continue;

          // Determine sport from tags
          const tags = (raw.tags ?? []).map((t) => t.slug);
          let sportKey: string | undefined;
          for (const tag of tags) {
            const sk = PM_TAG_TO_SPORT.get(tag);
            if (sk) { sportKey = sk; break; }
          }
          if (!sportKey) continue;

          // Parse markets
          const markets: PmMarket[] = [];
          for (const m of raw.markets) {
            if (!m.sportsMarketType) continue;

            const outcomeNames = this.safeParse<string[]>(m.outcomes, []);
            const tokenIds = this.safeParse<string[]>(m.clobTokenIds, []);

            if (outcomeNames.length < 2 || tokenIds.length < 2) continue;

            // Prices are intentionally zeroed — WS/REST books provide real best-ask prices.
            // The scanner skips markets with price < 0.02, so these won't appear until updated.
            markets.push({
              conditionId: m.conditionId,
              sportsMarketType: m.sportsMarketType,
              question: m.question ?? '',
              outcomeNames,
              outcomePrices: new Array(outcomeNames.length).fill(0),
              outcomeQtys: new Array(outcomeNames.length).fill(0),
              outcomeAsks: new Array(outcomeNames.length).fill(null).map(() => []),
              tokenIds,
            });

            // Register token→market mapping for WS price updates
            for (let i = 0; i < tokenIds.length; i++) {
              this.tokenIndex.set(tokenIds[i], {
                eventId: String(raw.id),
                conditionId: m.conditionId,
                outcomeIdx: i,
              });
            }
          }

          if (markets.length === 0) continue;

          const startTime = raw.startTime ? new Date(raw.startTime).getTime() : undefined;

          const existing = this.eventCache.get(String(raw.id));
          if (existing) {
            // Update in-place to preserve references held by currentMatches in scheduler
            existing.title = raw.title;
            existing.sportKey = sportKey;
            existing.slug = raw.slug ?? '';
            if (startTime !== undefined) existing.startTime = startTime;
            existing.markets = this.mergeMarkets(existing.markets, markets);
            existing.updatedAt = Date.now();
          } else {
            const event: PmSportsEvent = {
              id: String(raw.id),
              title: raw.title,
              sportKey,
              slug: raw.slug ?? '',
              startTime,
              markets,
              updatedAt: Date.now(),
            };
            this.eventCache.set(event.id, event);
          }
          totalEvents++;
          totalMarkets += markets.length;
        }

        if (batch.length < PM_PAGE) break;
        offset += PM_PAGE;
      }

      this.logger.log(
        `PolymarketSports: fetched ${totalEvents} events, ${totalMarkets} markets, cache=${this.eventCache.size}`,
      );
    } catch (err: any) {
      this.logger.error(`PolymarketSports fetch failed: ${err.message}`);
    }
  }

  /** Merge new markets keeping WS-updated prices; reuse existing objects to preserve references */
  private mergeMarkets(existing: PmMarket[], fresh: PmMarket[]): PmMarket[] {
    const existingMap = new Map(existing.map((m) => [m.conditionId, m]));
    return fresh.map((m) => {
      const old = existingMap.get(m.conditionId);
      if (old) {
        // Update existing object in-place — scanner/scheduler hold references to it
        old.sportsMarketType = m.sportsMarketType;
        old.question = m.question;
        old.outcomeNames = m.outcomeNames;
        old.tokenIds = m.tokenIds;
        // Keep outcomePrices/outcomeQtys/outcomeAsks as-is (WS/REST keeps them fresh)
        if (!old.outcomeQtys || old.outcomeQtys.length !== m.outcomeNames.length) {
          old.outcomeQtys = new Array(m.outcomeNames.length).fill(0);
        }
        if (!old.outcomeAsks || old.outcomeAsks.length !== m.outcomeNames.length) {
          old.outcomeAsks = new Array(m.outcomeNames.length).fill(null).map(() => []);
        }
        return old;
      }
      return m;
    });
  }

  // ── CLOB WebSocket for live price updates ─────────────────────

  private connectWs(): void {
    if (this.destroyed) return;
    if (this.ws?.readyState === Ws.WebSocket.OPEN) {
      this.subscribeAll();
      return;
    }

    this.ws?.terminate();
    const ws = new Ws.WebSocket(CLOB_WS, {
      headers: { Origin: 'https://polymarket.com' },
    });
    this.ws = ws;

    ws.on('open', () => {
      this.logger.log('PolymarketSports CLOB WS connected');
      this.subscribeAll();

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === Ws.WebSocket.OPEN) ws.send('PING');
      }, WS_PING_INTERVAL_MS);
    });

    ws.on('message', (raw: Ws.RawData) => {
      try {
        this.handleWsMessage(raw.toString());
      } catch { /* ignore */ }
    });

    ws.on('error', (err: Error) => {
      this.logger.warn(`PolymarketSports WS error: ${err.message}`);
    });

    ws.on('close', (code: number) => {
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      this.logger.warn(`PolymarketSports WS closed (${code}), reconnecting...`);
      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.connectWs(), WS_RECONNECT_DELAY_MS);
      }
    });
  }

  private subscribeAll(): void {
    const tokenIds = [...this.activeTokenIds];
    if (tokenIds.length === 0) return;

    const CHUNK = 200;
    for (let i = 0; i < tokenIds.length; i += CHUNK) {
      const chunk = tokenIds.slice(i, i + CHUNK);
      this.ws?.send(JSON.stringify({ assets_ids: chunk, type: 'market', custom_feature_enabled: true }));
    }
    this.logger.log(`PolymarketSports WS: subscribed to ${tokenIds.length} tokens`);
  }

  private handleWsMessage(str: string): void {
    if (str === 'PONG') return;
    const parsed = JSON.parse(str);
    const items: any[] = Array.isArray(parsed) ? parsed : [parsed];

    for (const msg of items) {
      if (msg.event_type === 'book') {
        this.handleBookMsg(msg);
      } else if (msg.event_type === 'price_change') {
        this.handlePriceChangeMsg(msg);
      }
    }
  }

  private handleBookMsg(msg: any): void {
    const tokenId: string = msg.asset_id ?? '';
    const ref = this.tokenIndex.get(tokenId);
    if (!ref) return;

    const event = this.eventCache.get(ref.eventId);
    if (!event) return;

    const market = event.markets.find((m) => m.conditionId === ref.conditionId);
    if (!market) return;

    const asks: any[] = [...(msg.asks ?? [])].sort(
      (a: any, b: any) => parseFloat(a.price) - parseFloat(b.price),
    );

    const bestAsk = asks[0];
    if (!bestAsk) return;

    const bestAskQty = parseFloat(bestAsk.size ?? '0') || 0;
    this.applyPrice(market, event, ref.outcomeIdx, parseFloat(bestAsk.price), bestAskQty);

    // Store full ask levels for depth analysis
    market.outcomeAsks[ref.outcomeIdx] = asks.map((a: any) => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size ?? '0'),
    }));
  }

  private handlePriceChangeMsg(msg: any): void {
    for (const change of (msg.price_changes ?? [])) {
      const tokenId: string = change.asset_id ?? '';
      const ref = this.tokenIndex.get(tokenId);
      if (!ref) continue;

      // price_change provides best_ask directly — no need to reconstruct the book
      const bestAsk = change.best_ask != null ? parseFloat(change.best_ask) : NaN;
      if (!isFinite(bestAsk) || bestAsk <= 0) continue;

      const bestAskQty = change.best_ask_size != null ? parseFloat(change.best_ask_size) : undefined;

      const event = this.eventCache.get(ref.eventId);
      if (!event) continue;

      const market = event.markets.find((m) => m.conditionId === ref.conditionId);
      if (!market) continue;

      this.applyPrice(market, event, ref.outcomeIdx, bestAsk, bestAskQty);
    }
  }

  private applyPrice(market: PmMarket, event: PmSportsEvent, outcomeIdx: number, price: number, qty?: number): void {
    if (outcomeIdx >= market.outcomePrices.length) return;
    const oldPrice = market.outcomePrices[outcomeIdx];
    market.outcomePrices[outcomeIdx] = price;
    if (qty !== undefined && outcomeIdx < market.outcomeQtys.length) {
      market.outcomeQtys[outcomeIdx] = qty;
    }
    event.updatedAt = Date.now();
    if (Math.abs(oldPrice - price) > 0.001) {
      this.onPriceUpdate?.();
    }
  }

  /** Returns all token IDs belonging to the given event IDs */
  getTokenIdsForEvents(eventIds: string[]): string[] {
    const ids: string[] = [];
    for (const [tokenId, ref] of this.tokenIndex) {
      if (eventIds.includes(ref.eventId)) ids.push(tokenId);
    }
    return ids;
  }

  /**
   * Fetches full order books via CLOB REST API for the given token IDs.
   * Updates outcomePrices, outcomeQtys, and outcomeAsks in-place.
   * Called once after each match cycle so the scanner has best-ask prices immediately.
   */
  async fetchBooksForTokens(tokenIds: string[]): Promise<void> {
    if (tokenIds.length === 0) return;

    const CHUNK = 500;
    let updated = 0;

    for (let i = 0; i < tokenIds.length; i += CHUNK) {
      const chunk = tokenIds.slice(i, i + CHUNK);
      try {
        const { data } = await axios.post<any[]>(
          'https://clob.polymarket.com/books',
          chunk.map((id) => ({ token_id: id })),
          { timeout: 15_000 },
        );

        for (const book of data) {
          const tokenId: string = book.asset_id ?? '';
          const ref = this.tokenIndex.get(tokenId);
          if (!ref) continue;

          const event = this.eventCache.get(ref.eventId);
          if (!event) continue;

          const market = event.markets.find((m) => m.conditionId === ref.conditionId);
          if (!market) continue;

          const asks: any[] = [...(book.asks ?? [])].sort(
            (a: any, b: any) => parseFloat(a.price) - parseFloat(b.price),
          );

          if (asks.length === 0) continue;

          const bestAsk = asks[0];
          const bestAskQty = parseFloat(bestAsk.size ?? '0') || 0;
          this.applyPrice(market, event, ref.outcomeIdx, parseFloat(bestAsk.price), bestAskQty);

          market.outcomeAsks[ref.outcomeIdx] = asks.map((a: any) => ({
            price: parseFloat(a.price),
            size: parseFloat(a.size ?? '0'),
          }));

          updated++;
        }
      } catch (err: any) {
        this.logger.warn(`fetchBooksForTokens chunk failed: ${err.message}`);
      }
    }

  }

  private safeParse<T>(value: string | undefined, fallback: T): T {
    try {
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }
}

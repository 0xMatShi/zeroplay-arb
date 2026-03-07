import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import * as Ws from 'ws';
import { PmSportsEvent, PmMarket } from '../../interfaces/sports-arb.types';
import { PolymarketSportsEventRaw } from './polymarket-sports.types';
import { PM_TAG_TO_SPORT } from '../../services/sports-constants';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

const FETCH_INTERVAL_MS = 10 * 60_000;
const WS_RECONNECT_DELAY_MS = 5_000;
const WS_PING_INTERVAL_MS = 15_000;
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

  private ws: Ws.WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private fetchTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  /** Called when any market price changes via CLOB WS (set by scheduler) */
  onPriceUpdate: (() => void) | null = null;

  onModuleInit(): void {
    this.fetchAndConnect();
    this.fetchTimer = setInterval(() => this.fetchAndConnect(), FETCH_INTERVAL_MS);
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

  // ── Fetch events from Gamma API ──────────────────────────────

  private async fetchAndConnect(): Promise<void> {
    await this.fetchEvents();
    this.connectWs();
  }

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
            const outcomePricesRaw = this.safeParse<string[]>(m.outcomePrices, []);
            const tokenIds = this.safeParse<string[]>(m.clobTokenIds, []);

            if (outcomeNames.length < 2 || tokenIds.length < 2) continue;

            const outcomePrices = outcomePricesRaw.map((p) => parseFloat(p) || 0);

            markets.push({
              conditionId: m.conditionId,
              sportsMarketType: m.sportsMarketType,
              question: m.question ?? '',
              outcomeNames,
              outcomePrices,
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

          const existing = this.eventCache.get(String(raw.id));
          const event: PmSportsEvent = {
            id: String(raw.id),
            title: raw.title,
            sportKey,
            slug: raw.slug ?? '',
            markets: existing
              ? this.mergeMarkets(existing.markets, markets)
              : markets,
            updatedAt: Date.now(),
          };

          this.eventCache.set(event.id, event);
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

  /** Merge new markets keeping WS-updated prices from existing ones */
  private mergeMarkets(existing: PmMarket[], fresh: PmMarket[]): PmMarket[] {
    const existingMap = new Map(existing.map((m) => [m.conditionId, m]));
    return fresh.map((m) => {
      const old = existingMap.get(m.conditionId);
      if (old) {
        // Keep WS-updated prices if fresher
        return { ...m, outcomePrices: old.outcomePrices };
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
        if (ws.readyState === Ws.WebSocket.OPEN) ws.ping();
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
    const tokenIds = [...this.tokenIndex.keys()];
    if (tokenIds.length === 0) return;

    const CHUNK = 200;
    for (let i = 0; i < tokenIds.length; i += CHUNK) {
      const chunk = tokenIds.slice(i, i + CHUNK);
      this.ws?.send(JSON.stringify({ auth: {}, assets_ids: chunk, type: 'market' }));
    }
    this.logger.log(`PolymarketSports WS: subscribed to ${tokenIds.length} tokens`);
  }

  private handleWsMessage(str: string): void {
    const parsed = JSON.parse(str);
    const items: any[] = Array.isArray(parsed) ? parsed : [parsed];

    for (const msg of items) {
      if (msg.event_type !== 'book') continue;

      const tokenId: string = msg.asset_id ?? '';
      const ref = this.tokenIndex.get(tokenId);
      if (!ref) continue;

      const event = this.eventCache.get(ref.eventId);
      if (!event) continue;

      const market = event.markets.find((m) => m.conditionId === ref.conditionId);
      if (!market) continue;

      const bids: any[] = [...(msg.bids ?? [])].sort(
        (a: any, b: any) => parseFloat(b.price) - parseFloat(a.price),
      );
      const asks: any[] = [...(msg.asks ?? [])].sort(
        (a: any, b: any) => parseFloat(a.price) - parseFloat(b.price),
      );

      const bestBid = bids[0];
      const bestAsk = asks[0];
      if (!bestBid && !bestAsk) continue;

      const midPrice =
        bestBid && bestAsk
          ? (parseFloat(bestBid.price) + parseFloat(bestAsk.price)) / 2
          : parseFloat(bestAsk?.price ?? bestBid?.price ?? '0');

      if (midPrice > 0 && ref.outcomeIdx < market.outcomePrices.length) {
        const oldPrice = market.outcomePrices[ref.outcomeIdx];
        market.outcomePrices[ref.outcomeIdx] = midPrice;
        event.updatedAt = Date.now();

        // Notify scheduler about price change
        if (Math.abs(oldPrice - midPrice) > 0.001) {
          this.onPriceUpdate?.();
        }
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

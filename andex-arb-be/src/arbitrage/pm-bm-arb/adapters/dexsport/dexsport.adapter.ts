import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as Ws from 'ws';
import { randomUUID } from 'crypto';
import {
  CachedEvent,
  DexsportDiscipline,
  DexsportEvent,
  DexsportMarket,
  DexsportProfileResponse,
  DexsportTournament,
} from './dexsport.types';
import { DexSportsEvent } from '../../interfaces/sports-arb.types';

// ── Constants ──────────────────────────────────────────────────

const BASE_URL = 'https://prod.dexsport.work';
const WS_URL = 'wss://prod.dexsport.work/ws';
const API_KEY = 'ta-dexsport';
const LANG = 'en';

const TOKEN_REFRESH_BUFFER_MS = 60_000;
const WS_RECONNECT_DELAY_MS = 5_000;

/** Sports we track for arbitrage */
const TARGET_SPORTS = [
  'basketball', 'tennis', 'hockey', 'csgo', 'boxing',
  'dota2', 'call-of-duty', 'baseball', 'lol', 'valorant',
];

// ── Adapter ────────────────────────────────────────────────────

@Injectable()
export class DexsportAdapter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DexsportAdapter.name);

  private readonly userHash: string | null;

  // ── Token state ──────────────────────────────────────────────
  private token: string | null = null;
  private tokenExpiresAt = 0;

  // ── WS state ────────────────────────────────────────────────
  private ws: Ws.WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  // ── Subscription state ───────────────────────────────────────
  private disciplinesJoined = false;
  private readonly subscribedTournaments = new Set<string>();
  private readonly subscribedEvents = new Set<string>();
  private readonly subscribedMarkets = new Set<string>();

  // ── Sport/tournament tracking ────────────────────────────────
  private readonly tournamentToSport = new Map<string, string>();
  private readonly tournamentToName = new Map<string, string>();
  private readonly eventToSport = new Map<string, string>();
  private readonly eventToTournament = new Map<string, string>();
  private readonly marketToEvent = new Map<string, string>();

  // ── Data cache ───────────────────────────────────────────────
  private readonly eventCache = new Map<string, CachedEvent>();

  /** Stable public event objects — updated in-place so match references stay fresh */
  private readonly publicEvents = new Map<string, DexSportsEvent>();

  /** Called when any market price changes (set by scheduler) */
  onPriceUpdate: (() => void) | null = null;

  constructor(configService: ConfigService) {
    this.userHash = configService.get<string>('DEXSPORT_USER_HASH') || null;
  }

  onModuleInit(): void {
    this.connect();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.clearTimers();
    this.ws?.terminate();
    this.ws = null;
  }

  /**
   * Returns stable event objects that are updated in-place when WS data arrives.
   * Match objects that reference these will always see fresh prices.
   */
  getEvents(): DexSportsEvent[] {
    return [...this.publicEvents.values()];
  }

  // ── Auth ─────────────────────────────────────────────────────

  private async fetchToken(): Promise<string> {
    const partnerToken = this.userHash
      ? `${this.userHash}_binance_usdt_sportsbook`
      : undefined;

    const body: Record<string, unknown> = {
      apiKey: API_KEY,
      visitorId: randomUUID().replace(/-/g, ''),
    };

    if (partnerToken) {
      body.token = partnerToken;
    } else {
      body.guest = true;
    }

    const { data } = await axios.post<DexsportProfileResponse>(
      `${BASE_URL}/public/api/profile`,
      body,
      { timeout: 10_000 },
    );

    if (!data.token) throw new Error('DexSport: no token in profile response');

    const tokenExpiresAt = this.parseTokenExpiry(data.token);
    this.token = data.token;
    this.tokenExpiresAt = tokenExpiresAt;
    this.scheduleTokenRefresh(tokenExpiresAt);

    this.logger.log(
      `DexSport token obtained (guest=${!partnerToken}), expires in ~${Math.round((tokenExpiresAt - Date.now()) / 1000)}s`,
    );

    return data.token;
  }

  private parseTokenExpiry(token: string): number {
    try {
      const encodedHeader = token.replace(/_/g, '/').replace(/-/g, '+').split('.')[0];
      const header = JSON.parse(Buffer.from(encodedHeader, 'base64').toString('utf8'));
      if (header.exp && header.iat) {
        return Date.now() + (header.exp - header.iat) * 1000;
      }
    } catch { /* fallback */ }
    return Date.now() + 600_000;
  }

  private scheduleTokenRefresh(expiresAt: number): void {
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    const delay = Math.max(0, expiresAt - Date.now() - TOKEN_REFRESH_BUFFER_MS);
    this.tokenRefreshTimer = setTimeout(() => {
      if (!this.destroyed) {
        this.logger.log('DexSport token expiring soon, reconnecting WS...');
        this.reconnect();
      }
    }, delay);
  }

  // ── WebSocket lifecycle ───────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.destroyed) return;

    try {
      const token = await this.fetchToken();

      const timestamp = Buffer.from(
        JSON.stringify({ now: new Date().toISOString(), expired: false }),
      )
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const query = new URLSearchParams({
        cid: API_KEY, lang: LANG, timestamp, token, format: 'long',
      });

      const ws = new Ws.WebSocket(`${WS_URL}?${query}`);
      this.ws = ws;

      ws.on('open', () => {
        this.logger.log('DexSport WebSocket connected');
        this.disciplinesJoined = false;
        this.subscribedTournaments.clear();
        this.subscribedEvents.clear();
        this.subscribedMarkets.clear();
      });

      ws.on('message', (raw: Ws.RawData) => {
        try {
          this.handleMessage(raw.toString());
        } catch (err: any) {
          this.logger.warn(`DexSport WS parse error: ${err.message}`);
        }
      });

      ws.on('error', (err: Error) => {
        this.logger.warn(`DexSport WebSocket error: ${err.message}`);
      });

      ws.on('close', (code: number) => {
        if (this.ws !== ws) return;
        this.logger.warn(`DexSport WebSocket closed (code=${code}), reconnecting in ${WS_RECONNECT_DELAY_MS}ms`);
        if (!this.destroyed) {
          this.reconnectTimer = setTimeout(() => this.reconnect(), WS_RECONNECT_DELAY_MS);
        }
      });
    } catch (err: any) {
      this.logger.error(`DexSport connect failed: ${err.message}, retrying in ${WS_RECONNECT_DELAY_MS}ms`);
      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.connect(), WS_RECONNECT_DELAY_MS);
      }
    }
  }

  private reconnect(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const old = this.ws;
    this.ws = null;
    old?.terminate();
    this.connect();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.tokenRefreshTimer) { clearTimeout(this.tokenRefreshTimer); this.tokenRefreshTimer = null; }
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === Ws.WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ── Message handling ─────────────────────────────────────────

  private handleMessage(str: string): void {
    const [model, payload] = JSON.parse(str);

    if (model === 'config') {
      this.handleConfig(payload);
      return;
    }

    if (model !== 'batch') return;

    for (const item of payload as unknown[]) {
      const [entityName, entityId, , entityData] = item as [string, string, number, any];

      switch (entityName) {
        case 'discipline':
          this.handleDiscipline(entityId, entityData as DexsportDiscipline);
          break;
        case 'tournament':
          this.handleTournament(entityId, entityData as DexsportTournament);
          break;
        case 'event':
          this.handleEvent(entityId, entityData as DexsportEvent);
          break;
        case 'market':
          this.handleMarket(entityId, entityData as DexsportMarket);
          break;
      }
    }
  }

  private handleConfig(payload: { disciplines?: { id: string }[] }): void {
    if (this.disciplinesJoined) return;
    this.disciplinesJoined = true;

    const disciplines = payload?.disciplines ?? [];
    const ids = disciplines
      .filter((d) => TARGET_SPORTS.includes(d.id))
      .flatMap((d) => [`2.${d.id}`, `1.${d.id}`]);

    if (ids.length > 0) {
      this.send(['join', 'discipline', ids]);
      this.logger.log(`DexSport: subscribing to ${ids.length / 2} disciplines`);
    }
  }

  private handleDiscipline(id: string, data: DexsportDiscipline): void {
    const sportSlug = data?.id ?? id.split('.').slice(1).join('.');
    if (!TARGET_SPORTS.includes(sportSlug)) return;

    const tournamentIds = data?.tournamentIds ?? [];
    const newIds = tournamentIds.filter((tid) => !this.subscribedTournaments.has(tid));
    if (newIds.length === 0) return;

    newIds.forEach((tid) => {
      this.subscribedTournaments.add(tid);
      this.tournamentToSport.set(tid, sportSlug);
    });
    this.send(['join', 'tournament', newIds]);
  }

  private handleTournament(id: string, data: DexsportTournament): void {
    const sportSlug = this.tournamentToSport.get(id);
    if (!sportSlug) return;

    if (data?.name) this.tournamentToName.set(id, data.name);

    const eventIds = data?.eventIds ?? [];
    const newIds = eventIds.filter(
      (eid) => eid && !eid.startsWith('outright') && !this.subscribedEvents.has(eid),
    );
    if (newIds.length === 0) return;

    newIds.forEach((eid) => {
      this.subscribedEvents.add(eid);
      this.eventToSport.set(eid, sportSlug);
      this.eventToTournament.set(eid, id);
    });
    for (const eid of newIds) this.send(['join', 'event', eid]);
  }

  private handleEvent(id: string, data: DexsportEvent): void {
    if (!data) return;

    const sportSlug = this.eventToSport.get(id);
    if (!sportSlug) return;

    // Update or create internal cache entry
    const existing = this.eventCache.get(id);
    if (existing) {
      existing.event = { ...existing.event, ...data };
    } else {
      const tournamentId = this.eventToTournament.get(id);
      this.eventCache.set(id, {
        event: data,
        sportSlug,
        disciplineId: id.startsWith('2.') ? `2.${sportSlug}` : `1.${sportSlug}`,
        tournamentName: tournamentId ? this.tournamentToName.get(tournamentId) : undefined,
        markets: new Map(),
      });
    }

    // Create or update stable public event object
    if (data.name && !this.publicEvents.has(id)) {
      const tournamentId = this.eventToTournament.get(id);
      this.publicEvents.set(id, {
        eventId: id,
        name: data.name,
        sportKey: sportSlug,
        isLive: id.startsWith('2.'),
        startTime: data.startTime,
        tournamentName: tournamentId ? this.tournamentToName.get(tournamentId) : undefined,
        markets: [],
        updatedAt: Date.now(),
      });
    } else if (data.name) {
      const pub = this.publicEvents.get(id)!;
      pub.name = data.name;
      if (data.startTime) pub.startTime = data.startTime;
    }

    // Subscribe to ALL markets for this event (main + additional)
    const allMarketIds: string[] = [
      ...(data.mainMarketIds ?? []).filter(Boolean) as string[],
      ...(data.marketIds ?? []),
    ];
    const newMarketIds = allMarketIds.filter((m) => m && !this.subscribedMarkets.has(m));
    if (newMarketIds.length > 0) {
      newMarketIds.forEach((m) => {
        this.subscribedMarkets.add(m);
        this.marketToEvent.set(m, id);
      });
      this.send(['join', 'market', newMarketIds]);
    }
  }

  private handleMarket(marketId: string, data: DexsportMarket): void {
    if (!data) return;

    const eventId = this.marketToEvent.get(marketId);
    if (!eventId) return;

    const cached = this.eventCache.get(eventId);
    if (!cached) return;

    // Build outcomes with names
    const outcomes: Array<{ name: string; price: number }> = (data.outcomes ?? []).map((o) => ({
      name: o.name ?? '',
      price: o.price ?? 0,
    }));

    // Update internal cache
    const existingMarket = cached.markets.get(marketId);
    if (existingMarket) {
      if (data.name) existingMarket.name = data.name;
      if (outcomes.length > 0) existingMarket.outcomes = outcomes;
    } else {
      cached.markets.set(marketId, {
        marketId,
        name: data.name ?? '',
        outcomes,
      });
    }

    // Update stable public event object in-place
    const pub = this.publicEvents.get(eventId);
    if (pub) {
      const marketName = data.name ?? existingMarket?.name ?? '';
      const pubMarket = pub.markets.find((m) => m.marketId === marketId);

      if (pubMarket) {
        // Update existing market's outcomes in-place
        if (data.name) pubMarket.name = data.name;
        if (outcomes.length > 0) {
          pubMarket.outcomes = outcomes;
        }
      } else if (marketName && outcomes.length > 0) {
        // New market — add to event
        pub.markets.push({ marketId, name: marketName, outcomes });
      }

      pub.updatedAt = Date.now();

      // Notify scheduler about price change
      this.onPriceUpdate?.();
    }
  }

}

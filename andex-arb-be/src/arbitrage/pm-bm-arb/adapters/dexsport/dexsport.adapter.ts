import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as Ws from 'ws';
import { randomUUID } from 'crypto';
import {
  EventStatus,
  NormalizedEvent,
  NormalizedOutcome,
  OutcomeType,
  PlatformInfo,
} from '../../../pm-pm-arb/interfaces/types';
import {
  CachedEvent,
  DexsportDiscipline,
  DexsportEvent,
  DexsportMarket,
  DexsportOutcome,
  DexsportProfileResponse,
  DexsportTournament,
} from './dexsport.types';

// ── Constants ──────────────────────────────────────────────────

const BASE_URL = 'https://prod.dexsport.work';
const WS_URL = 'wss://prod.dexsport.work/ws';
const BASE_SITE_URL = 'https://sportsbook.dexsport.io';
const API_KEY = 'ta-dexsport';
const LANG = 'en';

/** Token lifetime is 10 min; reconnect 60s before expiry */
const TOKEN_REFRESH_BUFFER_MS = 60_000;

const WS_RECONNECT_DELAY_MS = 5_000;

/** Outcome name labels indexed by position for common market types */
const OUTCOME_LABELS_2WAY = ['Home', 'Away'];
const OUTCOME_LABELS_3WAY = ['Home', 'Draw', 'Away'];

// ── Adapter ────────────────────────────────────────────────────

@Injectable()
export class DexsportAdapter implements OnModuleInit, OnModuleDestroy {
  readonly platformSlug = 'dexsport';
  readonly platformName = 'DexSport';

  private readonly logger = new Logger(DexsportAdapter.name);

  /** Optional user hash from env — enables authenticated mode (more data) */
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

  // ── Sport tracking through subscription chain ─────────────────
  /** tournamentId → sportSlug (set when subscribing from discipline) */
  private readonly tournamentToSport = new Map<string, string>();
  /** eventId → sportSlug (set when subscribing from tournament) */
  private readonly eventToSport = new Map<string, string>();

  // ── Data cache ───────────────────────────────────────────────
  /** eventId → cached event + main market */
  private readonly eventCache = new Map<string, CachedEvent>();
  /** marketId → owning eventId */
  private readonly marketToEvent = new Map<string, string>();

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

  getPlatformInfo(): PlatformInfo {
    return {
      slug: this.platformSlug,
      name: this.platformName,
      baseUrl: BASE_SITE_URL,
      defaultPollIntervalMs: 120_000,
    };
  }

  /**
   * Returns current snapshot of all cached events with their main market odds.
   * The WS keeps the cache continuously updated.
   */
  async fetchEvents(): Promise<NormalizedEvent[]> {
    return this.fetchEventsSync();
  }

  /** Synchronous snapshot — used by SportsMatcher without async overhead. */
  fetchEventsSync(): NormalizedEvent[] {
    const results: NormalizedEvent[] = [];
    for (const cached of this.eventCache.values()) {
      const normalized = this.normalizeEvent(cached);
      if (normalized) results.push(normalized);
    }
    this.logger.debug(`fetchEventsSync: ${results.length} events from cache`);
    return results;
  }

  async healthCheck(): Promise<boolean> {
    return this.ws?.readyState === Ws.WebSocket.OPEN;
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

    // Parse expiry from JWE header (base64url encoded)
    const tokenExpiresAt = this.parseTokenExpiry(data.token);
    this.token = data.token;
    this.tokenExpiresAt = tokenExpiresAt;

    // Schedule reconnect before token expires
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
    } catch {
      // fallback: assume 10 minutes
    }
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
        cid: API_KEY,
        lang: LANG,
        timestamp,
        token,
        format: 'long',
      });

      const ws = new Ws.WebSocket(`${WS_URL}?${query}`);
      this.ws = ws;

      ws.on('open', () => {
        this.logger.log('DexSport WebSocket connected');
        // Reset subscription state on fresh connection
        this.disciplinesJoined = false;
        this.subscribedTournaments.clear();
        this.subscribedEvents.clear();
        this.subscribedMarkets.clear();
      });

      ws.on('message', (raw: Ws.RawData) => {
        try {
          this.handleMessage(raw.toString());
        } catch (err) {
          this.logger.warn(`DexSport WS parse error: ${err.message}`);
        }
      });

      ws.on('error', (err: Error) => {
        this.logger.warn(`DexSport WebSocket error: ${err.message}`);
      });

      ws.on('close', (code: number) => {
        // Deliberate reconnect already replaced this.ws — ignore this close event
        if (this.ws !== ws) return;
        this.logger.warn(`DexSport WebSocket closed (code=${code}), reconnecting in ${WS_RECONNECT_DELAY_MS}ms`);
        if (!this.destroyed) {
          this.reconnectTimer = setTimeout(() => this.reconnect(), WS_RECONNECT_DELAY_MS);
        }
      });
    } catch (err) {
      this.logger.error(`DexSport connect failed: ${err.message}, retrying in ${WS_RECONNECT_DELAY_MS}ms`);
      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.connect(), WS_RECONNECT_DELAY_MS);
      }
    }
  }

  private reconnect(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const old = this.ws;
    this.ws = null;   // replace before terminate so close handler sees the change
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
        case 'count':
          // count arrives as ["count","count",version,{sports}] — id is "count"
          this.handleCount(entityData);
          break;
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

    // Subscribe to count (for live event counts) and all disciplines from config
    this.send(['join', 'count', [
      'football', 'csgo', 'dota2', 'efootball', 'lol', 'tennis', 'basketball',
      'hockey', 'volleyball', 'handball', 'baseball', 'cricket', 'ebasketball', 'ehockey',
    ]]);

    const disciplines = payload?.disciplines ?? [];
    const disciplineIds = disciplines.flatMap((d) => [`2.${d.id}`, `1.${d.id}`]);

    if (disciplineIds.length > 0) {
      this.send(['join', 'discipline', disciplineIds]);
      this.logger.log(`DexSport: subscribing to ${disciplineIds.length} disciplines`);
    }
  }

  private handleCount(data: Record<string, { live?: number; prematch?: number }>): void {
    // count data used for monitoring only — subscription triggered by config
    const liveCounts = Object.entries(data)
      .filter(([, v]) => (v?.live ?? 0) > 0)
      .map(([sport, v]) => `${sport}:${v.live}`)
      .join(', ');

    if (liveCounts) {
      this.logger.debug(`DexSport live counts: ${liveCounts}`);
    }
  }

  private handleDiscipline(id: string, data: DexsportDiscipline): void {
    const tournamentIds = data?.tournamentIds ?? [];
    const newIds = tournamentIds.filter((tid) => !this.subscribedTournaments.has(tid));
    if (newIds.length === 0) return;

    // Track sport slug for each tournament (from discipline id or data)
    const sportSlug = data?.id ?? id.split('.').slice(1).join('.');
    newIds.forEach((tid) => {
      this.subscribedTournaments.add(tid);
      this.tournamentToSport.set(tid, sportSlug);
    });
    this.send(['join', 'tournament', newIds]);
  }

  private handleTournament(id: string, data: DexsportTournament): void {
    const eventIds = data?.eventIds ?? [];
    const newIds = eventIds.filter(
      (eid) => eid && !eid.startsWith('outright') && !this.subscribedEvents.has(eid),
    );
    if (newIds.length === 0) return;

    const sportSlug = this.tournamentToSport.get(id) ?? 'sport';
    newIds.forEach((eid) => {
      this.subscribedEvents.add(eid);
      this.eventToSport.set(eid, sportSlug);
    });
    for (const eventId of newIds) {
      this.send(['join', 'event', eventId]);
    }
  }

  private handleEvent(id: string, data: DexsportEvent): void {
    if (!data) return;

    const sportSlug = this.eventToSport.get(id) ?? 'sport';

    // Update or create cache entry
    const existing = this.eventCache.get(id);
    if (existing) {
      existing.event = { ...existing.event, ...data };
    } else {
      this.eventCache.set(id, {
        event: data,
        sportSlug,
        disciplineId: id.startsWith('2.') ? `2.${sportSlug}` : `1.${sportSlug}`,
      });
    }

    // Subscribe to main market
    const mainMarketId = this.pickMainMarketId(data);
    if (mainMarketId && !this.subscribedMarkets.has(mainMarketId)) {
      this.subscribedMarkets.add(mainMarketId);
      this.marketToEvent.set(mainMarketId, id);
      this.send(['join', 'market', [mainMarketId]]);
    }
  }

  private handleMarket(marketId: string, data: DexsportMarket): void {
    if (!data?.outcomes) return;

    const eventId = this.marketToEvent.get(marketId);
    if (!eventId) return;

    const cached = this.eventCache.get(eventId);
    if (!cached) return;

    cached.mainMarket = data;
  }

  // ── Normalization ─────────────────────────────────────────────

  private normalizeEvent(cached: CachedEvent): NormalizedEvent | null {
    const { event, mainMarket, sportSlug } = cached;

    if (!event.name) return null;
    if (!mainMarket?.outcomes?.length) return null;

    const activeOutcomes = mainMarket.outcomes.filter((o) => !o.isFrozen);
    if (activeOutcomes.length < 2) return null;

    const outcomes = this.normalizeOutcomes(activeOutcomes, event.lid);
    if (outcomes.length === 0) return null;

    const isLive = event.lid.startsWith('2.');
    const eventNumericId = event.lid.replace(/^[12]\./, '');

    return {
      externalId: event.lid,
      title: event.name,
      category: sportSlug,
      endDate: event.startTime ? new Date(event.startTime * 1000) : undefined,
      status: EventStatus.ACTIVE,
      outcomeType: outcomes.length > 2 ? OutcomeType.MULTI : OutcomeType.BINARY,
      outcomes,
      url: `${BASE_SITE_URL}/sport/${sportSlug}/event/${eventNumericId}`,
      metadata: {
        isLive,
        sportSlug,
        mainMarketId: mainMarket.lid,
        tier: event.tier,
        hasScoreboard: event.hasScoreboard,
        startTime: event.startTime,
      },
    };
  }

  private normalizeOutcomes(outcomes: DexsportOutcome[], eventId: string): NormalizedOutcome[] {
    const labels =
      outcomes.length === 3 ? OUTCOME_LABELS_3WAY :
      outcomes.length === 2 ? OUTCOME_LABELS_2WAY :
      outcomes.map((_, i) => `Outcome ${i + 1}`);

    return outcomes.map((o, i) => ({
      externalId: `${eventId}.${o.lid}`,
      name: labels[i] ?? `Outcome ${i + 1}`,
      // Convert decimal odds → implied probability (0..1)
      price: o.price > 0 ? Math.min(1, 1 / o.price) : 0,
      metadata: {
        decimalOdds: o.price,
        outcomeId: o.lid,
      },
    }));
  }

  // ── Helpers ───────────────────────────────────────────────────

  private pickMainMarketId(event: DexsportEvent): string | null {
    // Prefer matchWinnerId (explicitly set match winner market)
    if (event.matchWinnerId) return event.matchWinnerId;

    // Fall back to first non-null mainMarketId
    const mainIds = event.mainMarketIds ?? [];
    return mainIds.find((id) => id !== null) ?? null;
  }
}

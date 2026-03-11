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
import { MARKET_MAP } from '../../services/sports-constants';

// ── Constants ──────────────────────────────────────────────────

const BASE_URL = 'https://prod.dexsport.work';
const WS_URL = 'wss://prod.dexsport.work/ws';
const API_KEY = 'ta-dexsport';
const LANG = 'en';

const TOKEN_REFRESH_BUFFER_MS = 60_000;
const WS_RECONNECT_DELAY_MS = 3_000;

/** How long to wait for event list to stabilize before checking phase 1 (ms) */
const EVENT_SETTLE_MS = 5_000;
/** How long to wait for Match Winner on all events after list settles (ms) */
const PHASE1_TIMEOUT_MS = 10_000;
/** How long to wait for phase 2 market data before firing ready anyway (ms) */
const PHASE2_TIMEOUT_MS = 10_000;

/** Sports we track for arbitrage */
const TARGET_SPORTS = [
  'basketball', 'tennis', 'hockey', 'csgo', 'boxing',
  'dota2', 'call-of-duty', 'baseball', 'lol', 'valorant',
];

/**
 * Match Winner market name patterns — collected from MARKET_MAP moneyline entries.
 * Used to detect when phase 1 (Match Winner discovered) is complete per event.
 */
const MATCH_WINNER_NAMES: string[] = [
  ...new Set(
    Object.values(MARKET_MAP)
      .flatMap((sport) => sport['moneyline'] ?? [])
      .map((name) => name.toLowerCase()),
  ),
];

// ── Main adapter ───────────────────────────────────────────────

@Injectable()
export class DexsportAdapter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DexsportAdapter.name);

  private readonly userHash: string | null;

  // ── Token state ──────────────────────────────────────────────
  private token: string | null = null;
  private tokenExpiresAt = 0;

  // ── Main WS state (discovery connection) ─────────────────────
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

  // ── Phase 1: Match Winner detection ─────────────────────────
  /** All marketIds (from DexsportEvent.marketIds) per event — for phase 2 expansion */
  private readonly eventAllMarketIds = new Map<string, string[]>();
  /** Events where a Match Winner market has been confirmed via market message */
  private readonly eventMatchWinnerFound = new Set<string>();
  /** True once the event list has been stable for EVENT_SETTLE_MS */
  private eventSettled = false;
  /** Debounce timer reset on each new event subscription */
  private eventSettleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fallback: start phase 2 after PHASE1_TIMEOUT_MS even if not all events are ready */
  private phase1TimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Phase 2: All market types ────────────────────────────────
  /** True after phase 2 subscriptions have been sent */
  private phase2Started = false;
  /** Market IDs subscribed during phase 2 (not in mainMarketIds) */
  private readonly phase2MarketIds = new Set<string>();
  /** Count of phase 2 market messages received */
  private phase2Received = 0;
  /** Total phase 2 market IDs subscribed */
  private phase2Total = 0;
  /** True after onAllMarketsReady has been called once in this cycle */
  private readyFired = false;
  /** Timeout to fire ready if not all phase 2 markets respond */
  private readyDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Periodic resubscription interval — resends join for all subscribed markets every 5s */
  private marketRefreshTimer: ReturnType<typeof setInterval> | null = null;

  // ── Callbacks ────────────────────────────────────────────────
  /** Called when any market price changes (set by scheduler) */
  onPriceUpdate: (() => void) | null = null;
  /**
   * Called once per discovery cycle when all events have Match Winner confirmed.
   * Set by scheduler — triggers PM fetch + matching.
   */
  onAllMarketsReady: (() => void) | null = null;

  /** Market IDs currently in matched pairs — used to filter debug logs */
  trackedMarketIds: Set<string> = new Set();

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
      const encodedPayload = token.replace(/_/g, '/').replace(/-/g, '+').split('.')[1];
      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64').toString('utf8'));
      if (payload.exp && payload.iat) {
        return Date.now() + (payload.exp - payload.iat) * 1000;
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

  // ── Post-match market subscription ───────────────────────────

  /**
   * Subscribe the main WS connection to matched market IDs found after a match cycle.
   * Updates marketToEvent mapping and sends join messages for any new IDs.
   */
  subscribeToMatchedMarkets(entries: Array<{ eventId: string; marketId: string }>): void {
    const newIds: string[] = [];
    for (const { eventId, marketId } of entries) {
      this.marketToEvent.set(marketId, eventId);
      if (!this.subscribedMarkets.has(marketId)) {
        this.subscribedMarkets.add(marketId);
        newIds.push(marketId);
      }
    }
    if (newIds.length > 0) {
      this.send(['join', 'market', newIds]);
      this.logger.log(`DexSport: subscribed to ${newIds.length} matched market(s)`);
    }
    // Start periodic resubscription now that we're in the arbitrage phase
    this.startMarketRefresh();
  }

  // ── Main WebSocket lifecycle ───────────────────────────────────

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
        // Reset subscription state
        this.disciplinesJoined = false;
        this.subscribedTournaments.clear();
        this.subscribedEvents.clear();
        this.subscribedMarkets.clear();
        // Reset phase state
        this.eventAllMarketIds.clear();
        this.eventMatchWinnerFound.clear();
        this.eventSettled = false;
        if (this.eventSettleTimer) { clearTimeout(this.eventSettleTimer); this.eventSettleTimer = null; }
        if (this.phase1TimeoutTimer) { clearTimeout(this.phase1TimeoutTimer); this.phase1TimeoutTimer = null; }
        if (this.readyDebounceTimer) { clearTimeout(this.readyDebounceTimer); this.readyDebounceTimer = null; }
        this.phase2Started = false;
        this.phase2MarketIds.clear();
        this.phase2Received = 0;
        this.phase2Total = 0;
        this.readyFired = false;
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
        if (this.marketRefreshTimer) { clearInterval(this.marketRefreshTimer); this.marketRefreshTimer = null; }
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
    if (this.eventSettleTimer) { clearTimeout(this.eventSettleTimer); this.eventSettleTimer = null; }
    if (this.phase1TimeoutTimer) { clearTimeout(this.phase1TimeoutTimer); this.phase1TimeoutTimer = null; }
    if (this.readyDebounceTimer) { clearTimeout(this.readyDebounceTimer); this.readyDebounceTimer = null; }
    if (this.marketRefreshTimer) { clearInterval(this.marketRefreshTimer); this.marketRefreshTimer = null; }
  }

  private startMarketRefresh(): void {
    if (this.marketRefreshTimer) clearInterval(this.marketRefreshTimer);
    this.marketRefreshTimer = setInterval(() => {
      const ids = [...this.subscribedMarkets];
      if (ids.length > 0) this.send(['join', 'market', ids]);
    }, 3_000);
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

    // Reset event-settle debounce — new events were added, list is not yet stable
    this.resetEventSettleTimer();
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

    // Store ALL marketIds for phase 2 expansion (after Match Winner confirmed for all events)
    const allMarketIds = (data.marketIds ?? []).filter(Boolean) as string[];
    if (allMarketIds.length > 0) {
      this.eventAllMarketIds.set(id, allMarketIds);
    }

    // Phase 1: subscribe ONLY to the Match Winner market (matchWinnerId).
    // We wait for this specific market to confirm the event is active and ready.
    const matchWinnerId = data.matchWinnerId ?? null;
    if (matchWinnerId && !this.subscribedMarkets.has(matchWinnerId)) {
      this.subscribedMarkets.add(matchWinnerId);
      this.marketToEvent.set(matchWinnerId, id);
      this.send(['join', 'market', [matchWinnerId]]);
    }
  }

  private handleMarket(marketId: string, data: DexsportMarket): void {
    if (!data) return;

    const eventId = this.marketToEvent.get(marketId);
    if (!eventId) return;

    const cached = this.eventCache.get(eventId);
    if (!cached) return;

    // Build outcomes — skip frozen outcomes (betting closed on DEX side)
    const outcomes: Array<{ name: string; price: number }> = (data.outcomes ?? [])
      .filter((o) => !o.isFrozen && (o.price ?? 0) > 0)
      .map((o) => ({ name: o.name ?? '', price: o.price }));

    const allFrozen = (data.outcomes ?? []).length > 0 &&
      (data.outcomes ?? []).every((o) => o.isFrozen || (o.price ?? 0) === 0);

    // Update internal cache
    const existingMarket = cached.markets.get(marketId);
    if (existingMarket) {
      if (data.name) existingMarket.name = data.name;
      existingMarket.outcomes = outcomes;
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

      if (allFrozen) {
        // All outcomes frozen — betting closed, remove market from public event
        if (pubMarket) {
          pub.markets = pub.markets.filter((m) => m.marketId !== marketId);
          this.logger.log(`[DEX] Market "${marketName}" for "${pub.name}" frozen/closed, removed`);
        }
      } else if (pubMarket) {
        if (data.name) pubMarket.name = data.name;
        pubMarket.outcomes = outcomes;
      } else if (marketName && outcomes.length > 0) {
        pub.markets.push({ marketId, name: marketName, outcomes });
      }

      pub.updatedAt = Date.now();

      if (pubMarket && !allFrozen && this.trackedMarketIds.has(marketId)) {
        this.logger.debug(
          `[DEX PRICE] ${pub.name} / ${pubMarket.name}: ${pubMarket.outcomes.map((o) => `${o.name}=${o.price}`).join(', ')}`,
        );
      }
      this.onPriceUpdate?.();
    }

    // ── Phase 1: detect Match Winner ─────────────────────────
    if (!this.eventMatchWinnerFound.has(eventId)) {
      const marketName = data.name ?? existingMarket?.name ?? '';
      if (this.isMatchWinnerMarket(marketName)) {
        this.eventMatchWinnerFound.add(eventId);
        this.logger.debug(
          `DexSport Phase 1: Match Winner found for event ${eventId}: "${marketName}"`,
        );
        this.checkPhase1Complete();
      }
    }

    // ── Phase 2: track received market data ──────────────────
    if (this.phase2Started && !this.readyFired && this.phase2MarketIds.has(marketId)) {
      this.phase2Received++;
      if (this.phase2Received >= this.phase2Total) {
        this.fireAllMarketsReady();
      }
    }
  }

  // ── Phase helpers ────────────────────────────────────────────

  private isMatchWinnerMarket(name: string): boolean {
    if (!name) return false;
    const lower = name.toLowerCase().trim();
    return MATCH_WINNER_NAMES.some((p) => lower === p || lower.startsWith(p + ' '));
  }

  private resetEventSettleTimer(): void {
    if (this.eventSettleTimer) clearTimeout(this.eventSettleTimer);
    this.eventSettled = false;
    this.eventSettleTimer = setTimeout(() => {
      this.eventSettleTimer = null;
      this.onEventListSettled();
    }, EVENT_SETTLE_MS);
  }

  private onEventListSettled(): void {
    this.eventSettled = true;

    const allHaveMatchWinner =
      this.subscribedEvents.size > 0 &&
      [...this.subscribedEvents].every((eid) => this.eventMatchWinnerFound.has(eid));

    if (allHaveMatchWinner) {
      this.logger.log(
        `DexSport Phase 1 complete (immediate): all ${this.subscribedEvents.size} events have Match Winner`,
      );
      this.startPhase2();
    } else {
      this.logger.log(
        `DexSport Phase 1: ${this.eventMatchWinnerFound.size}/${this.subscribedEvents.size} events ready, waiting up to ${PHASE1_TIMEOUT_MS / 1000}s`,
      );
      if (this.phase1TimeoutTimer) clearTimeout(this.phase1TimeoutTimer);
      this.phase1TimeoutTimer = setTimeout(() => {
        this.phase1TimeoutTimer = null;
        if (!this.phase2Started) {
          this.logger.warn(
            `DexSport Phase 1 timeout: ${this.eventMatchWinnerFound.size}/${this.subscribedEvents.size} events have Match Winner, proceeding`,
          );
          this.startPhase2();
        }
      }, PHASE1_TIMEOUT_MS);
    }
  }

  private checkPhase1Complete(): void {
    if (this.phase2Started) return;
    if (!this.eventSettled) return;

    const allHaveMatchWinner =
      this.subscribedEvents.size > 0 &&
      [...this.subscribedEvents].every((eid) => this.eventMatchWinnerFound.has(eid));

    if (!allHaveMatchWinner) return;

    if (this.phase1TimeoutTimer) { clearTimeout(this.phase1TimeoutTimer); this.phase1TimeoutTimer = null; }
    this.logger.log(
      `DexSport Phase 1 complete: all ${this.subscribedEvents.size} events have Match Winner`,
    );
    this.startPhase2();
  }

  /**
   * Phase 2: TEMPORARILY DISABLED for testing.
   * Phase 1 (Match Winner) is sufficient for now — fire ready immediately.
   */
  private startPhase2(): void {
    this.phase2Started = true;
    this.logger.log('DexSport Phase 2: skipped (test mode) — firing ready immediately');
    this.fireAllMarketsReady();
  }

  private fireAllMarketsReady(): void {
    if (this.readyFired) return;
    this.readyFired = true;
    if (this.readyDebounceTimer) { clearTimeout(this.readyDebounceTimer); this.readyDebounceTimer = null; }
    this.logger.log(
      `DexSport: all markets ready — ${this.eventMatchWinnerFound.size} events confirmed`,
    );
    this.onAllMarketsReady?.();
  }

  /**
   * Clears all event/market caches and reconnects the WebSocket from scratch.
   * Called by the scheduler before a full rematch cycle.
   */
  clearCache(): void {
    this.logger.log('DexSport: clearing all event/market caches and reconnecting');
    this.eventCache.clear();
    this.publicEvents.clear();
    this.tournamentToSport.clear();
    this.tournamentToName.clear();
    this.eventToSport.clear();
    this.eventToTournament.clear();
    this.marketToEvent.clear();
    this.trackedMarketIds.clear();
    this.reconnect();
  }

  resetPhaseState(): void {
    this.eventMatchWinnerFound.clear();
    this.phase2Started = false;
    this.phase2MarketIds.clear();
    this.phase2Received = 0;
    this.phase2Total = 0;
    this.readyFired = false;
    if (this.phase1TimeoutTimer) { clearTimeout(this.phase1TimeoutTimer); this.phase1TimeoutTimer = null; }
    if (this.readyDebounceTimer) { clearTimeout(this.readyDebounceTimer); this.readyDebounceTimer = null; }

    for (const [eventId, cached] of this.eventCache) {
      if (!this.subscribedEvents.has(eventId)) continue;
      for (const [, market] of cached.markets) {
        if (this.isMatchWinnerMarket(market.name)) {
          this.eventMatchWinnerFound.add(eventId);
          break;
        }
      }
    }

    this.logger.log(
      `DexSport phase reset: ${this.eventMatchWinnerFound.size}/${this.subscribedEvents.size} events have cached Match Winner`,
    );
    this.checkPhase1Complete();
  }

}

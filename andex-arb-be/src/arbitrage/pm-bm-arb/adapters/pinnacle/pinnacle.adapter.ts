import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { DexSportsEvent, DexMarket, DexOutcome } from '../../interfaces/sports-arb.types';
import {
  PinnacleOddsResponse,
  PinnacleLeague,
  PinnacleEvent,
  PinnaclePeriod,
} from './pinnacle.types';

// ── Constants ────────────────────────────────────────────────

const BASE_URL = 'https://www.pinnacle888.com';
const POLL_INTERVAL_MS = 15_000;
/** Remove event from cache if not seen for this long */
const EVENT_TTL_MS = 1 * 60_000;

/** Sports to track: sportId → sportKey (for regular sports) */
const REGULAR_SPORTS: Array<{ sportId: number; sportKey: string }> = [
  { sportId: 4,  sportKey: 'basketball' },
  { sportId: 33, sportKey: 'tennis' },
  { sportId: 19, sportKey: 'hockey' },
  { sportId: 3,  sportKey: 'baseball' },
];

/** Esports sportId — gameCode maps to sportKey */
const ESPORTS_SPORT_ID = 12;
const ESPORT_GAME_CODE_TO_SPORT_KEY: Record<string, string> = {
  'cs2':      'csgo',
  'dota-2':   'dota2',
  'valorant': 'valorant',
};

/** All sport IDs we poll */
const ALL_SPORT_IDS = [...REGULAR_SPORTS.map((s) => s.sportId), ESPORTS_SPORT_ID];



// ── Adapter ──────────────────────────────────────────────────

@Injectable()
export class PinnacleAdapter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PinnacleAdapter.name);
  private readonly client: AxiosInstance;

  // ── Callbacks (same interface as DexsportAdapter) ────────────
  onPriceUpdate: (() => void) | null = null;
  onAllMarketsReady: (() => void) | null = null;

  /** Market IDs currently in matched pairs — used to filter debug logs */
  trackedMarketIds: Set<string> = new Set();

  // ── State ────────────────────────────────────────────────────
  /** Last received version per poll key (sportId + ':' + isLive) */
  private readonly versions = new Map<string, number>();

  /** Stable in-memory event objects — updated in-place on each poll */
  private readonly eventCache = new Map<string, DexSportsEvent>();

  /** Last time each event was seen in API response (Unix ms) */
  private readonly eventLastSeen = new Map<string, number>();

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private initialFetchDone = false;

  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      timeout: 15_000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: `${BASE_URL}/en/standard/sports`,
      },
    });
  }

  onModuleInit(): void {
    this.fetchAll().then(() => {
      if (!this.destroyed) {
        this.pollTimer = setInterval(() => this.fetchAll(), POLL_INTERVAL_MS);
      }
    });
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Returns stable event objects updated in-place — references stay fresh for matcher. */
  getEvents(): DexSportsEvent[] {
    return [...this.eventCache.values()];
  }

  /** No-op for REST polling — we always fetch everything on interval. */
  subscribeToMatchedMarkets(_entries: Array<{ eventId: string; marketId: string }>): void {}

  /**
   * Clears all event/market caches. Called by the scheduler before a full rematch cycle.
   * resetPhaseState() should be called after to trigger a fresh fetch.
   */
  clearCache(): void {
    this.logger.log('Pinnacle: clearing all event caches');
    this.eventCache.clear();
    this.eventLastSeen.clear();
    this.versions.clear();
    this.initialFetchDone = false;
  }

  /** Force a re-fetch on next poll cycle. */
  resetPhaseState(): void {
    this.logger.log('Pinnacle: resetPhaseState — triggering full re-fetch');
    this.fetchAll();
  }

  // ── Polling ──────────────────────────────────────────────────

  private async fetchAll(): Promise<void> {
    if (this.destroyed) return;

    const pollKeys = ALL_SPORT_IDS.flatMap((sportId) => [
      { sportId, isLive: false },
      { sportId, isLive: true },
    ]);

    try {
      const results = await Promise.all(pollKeys.map((k) => this.fetchOdds(k.sportId, k.isLive)));

      let anyChange = false;
      for (const response of results) {
        if (response) {
          const changed = this.mergeResponse(response);
          if (changed) anyChange = true;
        }
      }

      this.evictStale();

      if (!this.initialFetchDone) {
        this.initialFetchDone = true;
        this.logger.log(`Pinnacle: initial fetch done — ${this.eventCache.size} events loaded`);
        this.onAllMarketsReady?.();
      } else if (anyChange) {
        this.onPriceUpdate?.();
      }
    } catch (err: any) {
      this.logger.error(`Pinnacle fetchAll error: ${err.message}`);
    }
  }

  private async fetchOdds(
    sportId: number,
    isLive: boolean,
  ): Promise<PinnacleOddsResponse | null> {
    const key = `${sportId}:${isLive ? 'live' : 'pre'}`;
    const version = this.versions.get(key) ?? 0;
    const now = Date.now();

    const params = new URLSearchParams({
      sportId:     String(sportId),
      isLive:      String(isLive),
      isHlE:       'false',
      oddsType:    '2',            // decimal odds
      version:     String(version),
      timeStamp:   String(now),
      language:    'en_US',
      isHomePage:  '',
      leagueCode:  '',
      eventType:   '0',
      eSportCode:  '',
      periodNum:   '0,3,4,5,6,7,8,39',
      participant: '',
      locale:      'en_US',
      _:           String(now),
      withCredentials: 'true',
    });

    try {
      const res = await this.client.get<PinnacleOddsResponse>(
        `/sports-service/sv/euro/odds?${params}`,
      );
      return res.data;
    } catch (err: any) {
      this.logger.warn(`Pinnacle fetchOdds sportId=${sportId} isLive=${isLive}: ${err.message}`);
      return null;
    }
  }

  // ── Merge ────────────────────────────────────────────────────

  /**
   * Merges API response into eventCache.
   * Returns true if any price changed.
   */
  private mergeResponse(response: PinnacleOddsResponse): boolean {
    const key = `${response.sportId}:${response.leagues?.[0] ? 'live' : 'pre'}`;
    this.versions.set(`${response.sportId}:pre`, response.version);
    this.versions.set(`${response.sportId}:live`, response.version);

    if (!response.leagues?.length) return false;

    let anyChange = false;
    const now = Date.now();

    for (const league of response.leagues) {
      for (const event of league.events ?? []) {
        const changed = this.mergeEvent(event, league);
        this.eventLastSeen.set(String(event.id), now);
        if (changed) anyChange = true;
      }
    }

    return anyChange;
  }

  private mergeEvent(event: PinnacleEvent, league: PinnacleLeague): boolean {
    const eventId = String(event.id);
    const sportKey = this.resolveSportKey(league);
    if (!sportKey) return false;

    const home = event.participants.find((p) => p.type === 'HOME')?.englishName ?? '?';
    const away = event.participants.find((p) => p.type === 'AWAY')?.englishName ?? '?';
    const name = `${home} vs ${away}`;

    const markets = this.buildMarkets(event, sportKey, home, away);
    if (!markets.length) return false;

    const existing = this.eventCache.get(eventId);

    if (!existing) {
      this.eventCache.set(eventId, {
        eventId,
        name,
        sportKey,
        isLive: event.live,
        startTime: Math.floor(event.time / 1000), // store as Unix seconds (matcher expects seconds)
        tournamentName: league.name,
        markets,
        updatedAt: Date.now(),
      });
      return true;
    }

    // Update in-place (matcher holds references)
    existing.name = name;
    existing.isLive = event.live;
    existing.startTime = Math.floor(event.time / 1000);
    existing.markets = markets;
    existing.updatedAt = Date.now();
    return true;
  }

  // ── Market building ──────────────────────────────────────────

  private buildMarkets(event: PinnacleEvent, sportKey: string, home: string, away: string): DexMarket[] {
    const markets: DexMarket[] = [];

    for (const [periodStr, period] of Object.entries(event.periods)) {
      const periodNum = Number(periodStr);
      this.addPeriodMarkets(markets, event.id, periodNum, period, sportKey, home, away);
    }

    return markets;
  }

  private addPeriodMarkets(
    markets: DexMarket[],
    eventId: number,
    period: number,
    data: PinnaclePeriod,
    sportKey: string,
    home: string,
    away: string,
  ): void {
    // ── Money line ────────────────────────────────────────────
    const ml = data.moneyLine;
    if (ml && !ml.unavailable && !ml.offline) {
      const outcomes: DexOutcome[] = [
        { name: home, price: parseFloat(ml.homePrice) },
        { name: away, price: parseFloat(ml.awayPrice) },
      ];
      if (ml.drawPrice) {
        outcomes.push({ name: 'Draw', price: parseFloat(ml.drawPrice) });
      }

      markets.push({
        marketId: `${eventId}_p${period}_ml`,
        name: period === 0 ? 'moneyline' : `child_moneyline_map${period}`,
        marketType: period === 0 ? 'moneyline' : 'child_moneyline',
        outcomes,
      });
    }

  }

  /** Returns the main (non-alt) line, preferring the index if provided. */
  private getMainLine<T extends { unavailable?: boolean; offline?: boolean; isAlt?: boolean }>(
    lines: Array<T | { unavailable: true }> | undefined,
    mainIdx?: number,
  ): T | null {
    if (!lines?.length) return null;

    const valid = lines.filter(
      (l): l is T => !(l as any).unavailable && !(l as any).offline,
    );
    if (!valid.length) return null;

    if (mainIdx !== undefined && valid[mainIdx]) return valid[mainIdx];
    return valid.find((l) => !l.isAlt) ?? valid[0];
  }

  // ── Sport key resolution ─────────────────────────────────────

  private resolveSportKey(league: PinnacleLeague): string | null {
    if (league.sportId === ESPORTS_SPORT_ID) {
      return ESPORT_GAME_CODE_TO_SPORT_KEY[league.gameCode] ?? null;
    }
    return REGULAR_SPORTS.find((s) => s.sportId === league.sportId)?.sportKey ?? null;
  }

  // ── Stale event eviction ─────────────────────────────────────

  private evictStale(): void {
    const cutoff = Date.now() - EVENT_TTL_MS;
    for (const [id, lastSeen] of this.eventLastSeen) {
      if (lastSeen < cutoff) {
        this.eventCache.delete(id);
        this.eventLastSeen.delete(id);
      }
    }
  }
}

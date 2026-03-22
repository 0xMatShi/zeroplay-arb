import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import axios from 'axios';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import * as WebSocketLib from 'ws';
const WebSocket = (WebSocketLib as any).default ?? WebSocketLib;

import { DexSportsEvent, DexMarket, DexOutcome } from '../../interfaces/sports-arb.types';
import {
  CbSportConfig,
  CbEventRaw,
  CbMarket,
  CbWsUpdate,
  CbWsLiveListUpdate,
  CbWsLiveEvent,
} from './cloudbet.types';

// ── Constants ─────────────────────────────────────────────────────────────────

const REST_BASE   = 'https://sports-api.cloudbet.com/pub/v2/odds';
const PUSHER_KEY  = 'c065c29ae4b4b2f23f53';
const PUSHER_WS   = `wss://ws-eu.pusher.com/app/${PUSHER_KEY}?protocol=7&client=js&version=8.4.0&flash=false`;

/** Limit per sport per REST request */
const EVENTS_LIMIT = 100;

/** Keepalive ping interval */
const PING_INTERVAL_MS = 25_000;

/** Remove event from cache if not seen within this window */
const EVENT_TTL_MS = 5 * 60_000;

/** Evict stale events on this interval */
const EVICT_INTERVAL_MS = 60_000;

const WS_RECONNECT_DELAY_MS = 5_000;

// ── Sport configuration ───────────────────────────────────────────────────────

const TARGET_SPORTS: CbSportConfig[] = [
  // 2-way markets only (no draw possible).
  // Each moneyline/winner market key has exactly one submarket — no selection needed.
  {
    sportKey: 'basketball', cbSlug: 'basketball', marketKey: 'basketball.moneyline',
    extraMarketKeys: ['basketball.totals', 'basketball.handicap'],
  },
  {
    sportKey: 'tennis', cbSlug: 'tennis', marketKey: 'tennis.winner',
    extraMarketKeys: ['tennis.total_games', 'tennis.total_sets', 'tennis.set_handicap'],
  },
  {
    sportKey: 'hockey', cbSlug: 'ice-hockey', marketKey: 'ice_hockey.winner',
    extraMarketKeys: ['ice_hockey.totals', 'ice_hockey.handicap'],
  },
  { sportKey: 'baseball', cbSlug: 'baseball', marketKey: 'baseball.moneyline' },
  {
    sportKey: 'csgo', cbSlug: 'counter-strike', marketKey: 'counter_strike.winner',
    extraMarketKeys: ['counter_strike.total_maps', 'counter_strike.map_handicap'],
  },
  {
    sportKey: 'dota2', cbSlug: 'dota-2', marketKey: 'dota_2.winner',
    extraMarketKeys: ['dota_2.total_maps', 'dota_2.map_handicap'],
  },
  {
    sportKey: 'lol', cbSlug: 'league-of-legends', marketKey: 'league_of_legends.winner',
    extraMarketKeys: ['league_of_legends.total_maps', 'league_of_legends.map_handicap'],
  },
  {
    sportKey: 'valorant', cbSlug: 'esport-valorant', marketKey: 'esport_valorant.winner',
    extraMarketKeys: ['esport_valorant.total_maps'],
  },
];

/**
 * Cloudbet market key → pipeline marketType.
 * Used by extractTypedMarkets() to assign the correct type to each DexMarket.
 */
const CB_MARKET_TYPE: Record<string, string> = {
  'basketball.totals':               'totals',
  'basketball.handicap':             'spreads',
  'ice_hockey.totals':               'totals',
  'ice_hockey.handicap':             'spreads',
  'tennis.total_games':              'tennis_match_totals',
  'tennis.total_sets':               'tennis_set_totals',
  'tennis.set_handicap':             'tennis_set_handicap',
  'counter_strike.total_maps':       'totals',
  'counter_strike.map_handicap':     'map_handicap',
  'dota_2.total_maps':               'totals',
  'dota_2.map_handicap':             'map_handicap',
  'league_of_legends.total_maps':    'totals',
  'league_of_legends.map_handicap':  'map_handicap',
  'esport_valorant.total_maps':      'totals',
};

/** Market types that use over/under total extraction (vs home/away handicap). */
const CB_TOTALS_TYPES = new Set([
  'totals', 'tennis_match_totals', 'tennis_set_totals',
]);

// cbSlug → canonical sportKey
const CB_SLUG_TO_SPORT = new Map<string, string>(TARGET_SPORTS.map((s) => [s.cbSlug, s.sportKey]));
// canonical sportKey → config
const SPORT_CONFIG     = new Map<string, CbSportConfig>(TARGET_SPORTS.map((s) => [s.sportKey, s]));
// Sports that appear under /esports/ on cloudbet.com
const CB_ESPORTS = new Set(['counter-strike', 'dota-2', 'league-of-legends', 'esport-valorant']);

// ── Adapter ───────────────────────────────────────────────────────────────────

@Injectable()
export class CloudbetAdapter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CloudbetAdapter.name);

  // ── Callbacks (contract shared with other bookmaker adapters) ──────────────
  onPriceUpdate: (() => void) | null = null;
  onAllMarketsReady: (() => void) | null = null;

  /** Market IDs currently in matched pairs — used to filter verbose logs */
  trackedMarketIds: Set<string> = new Set();

  // ── State ──────────────────────────────────────────────────────────────────
  /** eventId → internal raw event (mutated in-place by WS updates) */
  private readonly rawCache     = new Map<number, CbEventRaw>();
  /** eventId → stable DexSportsEvent exposed to the pipeline */
  private readonly eventCache   = new Map<string, DexSportsEvent>();
  private readonly eventLastSeen = new Map<string, number>();

  // ── Pusher WS ──────────────────────────────────────────────────────────────
  /** Player UUID extracted from API key JWT — must match account UUID for per-event channels to deliver updates */
  private readonly playerUuid = CloudbetAdapter.extractUuidFromJwt(process.env.CLOUDBET_API_KEY ?? '');
  private ws: any = null;
  /** eventId → Pusher channel name */
  private readonly subscribedOdds = new Map<number, string>();
  /** Chunked message buffer: msgUuid → {chunks, receivedFinal} */
  private readonly chunkBuffer = new Map<string, { chunks: Record<number, string>; receivedFinal: boolean }>();

  // ── Ready state ────────────────────────────────────────────────────────────
  /** True once REST fetch completed and onAllMarketsReady fired */
  private initialStateFired = false;

  // ── Timers ─────────────────────────────────────────────────────────────────
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private evictTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  // ── NestJS lifecycle ───────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    if (!this.apiKey) {
      this.logger.warn('CloudbetAdapter: CLOUDBET_API_KEY not set — skipping (no events)');
      this.initialStateFired = true;
      this.onAllMarketsReady?.();
      return;
    }
    await this.fetchAllEvents();
    // REST snapshot is already complete — signal ready immediately.
    // WS connects in the background for real-time delta updates.
    this.initialStateFired = true;
    this.logger.log(`Cloudbet: REST fetch complete — ${this.eventCache.size} events ready, firing onAllMarketsReady`);
    this.onAllMarketsReady?.();
    this.connectWs();
    this.startTimers();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.stopTimers();
    this.terminateWs();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getEvents(): DexSportsEvent[] {
    return [...this.eventCache.values()];
  }

  /** Cloudbet is push-based — no per-market subscription needed */
  subscribeToMatchedMarkets(_entries: Array<{ eventId: string; marketId: string }>): void {}

  clearCache(): void {
    this.logger.log('Cloudbet: clearing caches, refetching events and reconnecting WS');
    this.rawCache.clear();
    this.eventCache.clear();
    this.eventLastSeen.clear();
    this.subscribedOdds.clear();
    this.chunkBuffer.clear();
    this.initialStateFired = false;
    this.terminateWs();
    if (!this.apiKey) return;
    this.fetchAllEvents()
      .then(() => {
        if (this.destroyed) return;
        this.initialStateFired = true;
        this.logger.log(`Cloudbet: clearCache refetch complete — ${this.eventCache.size} events, firing onAllMarketsReady`);
        this.onAllMarketsReady?.();
        this.connectWs();
      })
      .catch((e) => this.logger.error(`Cloudbet: clearCache refetch failed — ${e.message}`));
  }

  resetPhaseState(): void {
    this.logger.log('Cloudbet: resetPhaseState — reconnecting WebSocket');
    this.subscribedOdds.clear();
    this.chunkBuffer.clear();
    this.initialStateFired = false;
    this.terminateWs();
    if (!this.destroyed && this.apiKey) this.connectWs();
  }

  closeAll(): void {
    this.terminateWs();
  }

  /** No-op — API key auth, no login needed */
  async login(): Promise<void> {}

  // ── REST: event discovery ──────────────────────────────────────────────────

  private get apiKey(): string {
    return process.env.CLOUDBET_API_KEY ?? '';
  }

  /** Comma-separated list of all market keys (moneyline + extras) for a sport config. */
  private allMarketsParam(cfg: CbSportConfig): string {
    return [cfg.marketKey, ...(cfg.extraMarketKeys ?? [])].join(',');
  }

  private async fetchAllEvents(): Promise<void> {
    this.logger.log('Cloudbet: fetching events via REST...');
    const now = Math.floor(Date.now() / 1000);
    const to   = now + 24 * 3600;
    let total = 0;

    for (const cfg of TARGET_SPORTS) {
      let count = 0;
      // Live events
      try {
        const res = await this.restGet('/events', {
          sport: cfg.cbSlug,
          live: 'true',
          markets: this.allMarketsParam(cfg),
          limit: String(EVENTS_LIMIT),
        });
        for (const comp of (res.competitions ?? [])) {
          for (const raw of (comp.events ?? [])) {
            this.upsertRawEvent(raw, cfg, comp);
            count++;
          }
        }
      } catch (e: any) {
        this.logger.warn(`Cloudbet: live REST ${cfg.cbSlug} failed — ${e.message}`);
      }

      // Prematch events (next 24h)
      try {
        const res = await this.restGet('/events', {
          sport: cfg.cbSlug,
          live: 'false',
          from: String(now),
          to: String(to),
          markets: this.allMarketsParam(cfg),
          limit: String(EVENTS_LIMIT),
        });
        for (const comp of (res.competitions ?? [])) {
          for (const raw of (comp.events ?? [])) {
            this.upsertRawEvent(raw, cfg, comp);
            count++;
          }
        }
      } catch (e: any) {
        this.logger.warn(`Cloudbet: prematch REST ${cfg.cbSlug} failed — ${e.message}`);
      }

      total += count;
    }

    this.logger.log(`Cloudbet: fetched ${this.rawCache.size} unique events (${total} total incl. duplicates)`);
  }

  private upsertRawEvent(raw: any, cfg: CbSportConfig, comp: any): void {
    const id: number = raw.id;
    if (!id) return;

    const existing = this.rawCache.get(id);
    if (existing) {
      // Merge in any new market data
      if (raw.markets) {
        for (const [mk, mv] of Object.entries(raw.markets as Record<string, CbMarket>)) {
          existing.markets[mk] = mv;
        }
      }
      existing.status = raw.status ?? existing.status;
      // Preserve cutoffTime as startTime proxy from REST if it was missing (e.g. event first seen via WS)
      if (raw.cutoffTime && !existing.startTime) existing.startTime = raw.cutoffTime;
    } else {
      this.rawCache.set(id, {
        id,
        name:            raw.name ?? '',
        status:          raw.status ?? 'TRADING',
        startTime:       raw.cutoffTime ?? '',  // API does not return startTime — cutoffTime is the closest proxy
        cutoffTime:      raw.cutoffTime ?? '',
        home:            raw.home ?? null,
        away:            raw.away ?? null,
        markets:         raw.markets ?? {},
        sportKey:        cfg.sportKey,
        competitionKey:  comp?.key ?? raw.competition?.key ?? '',
        competitionName: comp?.name ?? raw.competition?.name ?? '',
      });
    }

    this.syncEventCache(id);
  }

  // ── Market helpers ─────────────────────────────────────────────────────────

  /**
   * Extracts typed (totals / handicap) markets from the raw event.
   * Returns one DexMarket per distinct line value (e.g., one for total=154.5).
   * Groups selections by their params field (e.g., "total=154.5", "handicap=-8.5").
   * If the same params appears in multiple submarkets (different periods), first-seen wins.
   */
  private extractTypedMarkets(raw: CbEventRaw): DexMarket[] {
    const cfg = SPORT_CONFIG.get(raw.sportKey);
    if (!cfg?.extraMarketKeys) return [];

    const result: DexMarket[] = [];

    for (const marketKey of cfg.extraMarketKeys) {
      const market = raw.markets[marketKey];
      if (!market?.submarkets) continue;

      const marketType = CB_MARKET_TYPE[marketKey];
      if (!marketType) continue;

      const isTotals = CB_TOTALS_TYPES.has(marketType);

      // Group enabled BACK selections by their params value across all submarkets.
      // First-seen wins: if the same total/handicap line appears in multiple submarket
      // periods (e.g., "period=ft" vs "period=ot&period=ft"), we keep the first one.
      const grouped = new Map<string, { a?: { price: number }; b?: { price: number } }>();

      for (const submarket of Object.values(market.submarkets)) {
        for (const sel of (submarket.selections ?? [])) {
          if (sel.status !== 'SELECTION_ENABLED' || sel.side !== 'BACK' || !sel.params) continue;
          if (!isFinite(sel.price) || sel.price <= 1) continue;

          if (!grouped.has(sel.params)) grouped.set(sel.params, {});
          const group = grouped.get(sel.params)!;

          if (isTotals) {
            if (sel.outcome === 'over'  && !group.a) group.a = { price: sel.price };
            if (sel.outcome === 'under' && !group.b) group.b = { price: sel.price };
          } else {
            if (sel.outcome === 'home' && !group.a) group.a = { price: sel.price };
            if (sel.outcome === 'away' && !group.b) group.b = { price: sel.price };
          }
        }
      }

      for (const [params, group] of grouped) {
        if (!group.a || !group.b) continue;

        if (isTotals) {
          const m = params.match(/total=([\d.]+)/i);
          if (!m) continue;
          const val = m[1];
          result.push({
            marketId:   `${raw.id}_${marketKey}_${params}`,
            marketType,
            name:       marketType,
            outcomes: [
              { name: `Over ${val}`,  price: group.a.price },
              { name: `Under ${val}`, price: group.b.price },
            ],
          });
        } else {
          // Handicap: params = "handicap=X"; home gets X, away gets mirror (-X)
          const m = params.match(/handicap=([-\d.]+)/i);
          if (!m) continue;
          const hcp    = parseFloat(m[1]);
          if (!isFinite(hcp)) continue;
          const awayHcp = -hcp;
          const homeName = (raw.home?.name ?? 'Home') + (hcp    >= 0 ? ` +${hcp}`    : ` ${hcp}`);
          const awayName = (raw.away?.name ?? 'Away') + (awayHcp >= 0 ? ` +${awayHcp}` : ` ${awayHcp}`);
          result.push({
            marketId:   `${raw.id}_${marketKey}_${params}`,
            marketType,
            name:       marketType,
            outcomes: [
              { name: homeName, price: group.a.price },
              { name: awayName, price: group.b.price },
            ],
          });
        }
      }
    }

    return result;
  }

  /**
   * Extracts moneyline outcomes from the raw event using its sport config.
   * Looks for the target submarket key; falls back to first available.
   */
  private extractMoneyline(raw: CbEventRaw): DexMarket | null {
    const cfg = SPORT_CONFIG.get(raw.sportKey);
    if (!cfg) return null;

    const market = raw.markets[cfg.marketKey];
    if (!market?.submarkets) return null;

    // Each moneyline/winner market has exactly one submarket — take it directly.
    const submarket = Object.values(market.submarkets)[0];
    if (!submarket) return null;
    const outcomes: DexOutcome[] = (submarket.selections ?? [])
      .filter((s) => s.status === 'SELECTION_ENABLED' && s.side === 'BACK' && s.params === '')
      .map((s) => {
        // Map generic 'home'/'away' to actual team names so they can be matched
        // against PM outcome names (which use team names, not positional labels).
        let name: string;
        if (s.outcome === 'home' && raw.home?.name) name = raw.home.name;
        else if (s.outcome === 'away' && raw.away?.name) name = raw.away.name;
        else name = s.outcome;
        return { name, price: s.price };
      })
      .filter((o) => isFinite(o.price) && o.price > 1);

    if (outcomes.length < 2) return null;

    return {
      marketId: `${raw.id}_${cfg.marketKey}`,
      marketType: 'moneyline',
      name: 'moneyline',
      outcomes,
    };
  }

  /**
   * Rebuild the DexSportsEvent for a raw event and store it in eventCache.
   * Called after any mutation of rawCache.
   */
  private syncEventCache(id: number): void {
    const raw = this.rawCache.get(id);
    if (!raw) return;

    const mlMarket     = this.extractMoneyline(raw);
    const typedMarkets = this.extractTypedMarkets(raw);
    const now          = Date.now();
    const eventId      = String(id);

    this.eventLastSeen.set(eventId, now);

    if (!mlMarket) {
      // Moneyline temporarily unavailable (suspended / no valid selections) —
      // keep last known good state so the scanner doesn't lose the reference.
      return;
    }

    const existing = this.eventCache.get(eventId);
    if (!existing) {
      // Parse startTime: ISO string → Unix seconds
      let startTime: number | undefined;
      if (raw.startTime) {
        const ms = Date.parse(raw.startTime);
        if (!isNaN(ms)) startTime = Math.floor(ms / 1000);
      }

      this.eventCache.set(eventId, {
        eventId,
        name: raw.name,
        sportKey: raw.sportKey,
        isLive: raw.status === 'TRADING_LIVE',
        startTime,
        tournamentName: raw.competitionName || undefined,
        url: this.buildEventUrl(raw),
        markets: [mlMarket, ...typedMarkets],
        updatedAt: now,
      });
      return;
    }

    // Update in-place: patch moneyline prices with change tracking, then rebuild typed markets.
    const prevMarket = existing.markets[0];
    existing.isLive    = raw.status === 'TRADING_LIVE';
    existing.updatedAt = now;
    // Backfill startTime if it was unknown when the event was first added (WS-discovered event)
    if (!existing.startTime && raw.startTime) {
      const ms = Date.parse(raw.startTime);
      if (!isNaN(ms)) existing.startTime = Math.floor(ms / 1000);
    }

    const changes: string[] = [];
    if (prevMarket) {
      for (let i = 0; i < Math.min(prevMarket.outcomes.length, mlMarket.outcomes.length); i++) {
        const np = mlMarket.outcomes[i].price;
        if (np !== prevMarket.outcomes[i].price && isFinite(np) && np > 1) {
          if (this.trackedMarketIds.has(mlMarket.marketId)) {
            const arrow = np > prevMarket.outcomes[i].price ? '↑' : '↓';
            changes.push(`${prevMarket.outcomes[i].name}: ${prevMarket.outcomes[i].price?.toFixed(3)} → ${np.toFixed(3)} ${arrow}`);
          }
          prevMarket.outcomes[i] = { ...prevMarket.outcomes[i], price: np };
        }
      }
    } else {
      existing.markets[0] = mlMarket;
    }

    // Rebuild typed markets (replace all non-moneyline markets with fresh data)
    existing.markets = [existing.markets[0] ?? mlMarket, ...typedMarkets];

    if (changes.length > 0) {
      this.logger.log(`[Cloudbet WS] ${existing.name}:\n  ${changes.join('\n  ')}`);
      if (this.initialStateFired) this.onPriceUpdate?.();
    }
  }

  private buildEventUrl(raw: CbEventRaw): string {
    if (!raw.competitionKey || !raw.id) return '';
    const cbSlug = TARGET_SPORTS.find((s) => s.sportKey === raw.sportKey)?.cbSlug ?? raw.sportKey;
    const category = CB_ESPORTS.has(cbSlug) ? 'esports' : 'sports';
    // e.g. https://www.cloudbet.com/en/esports/counter-strike/international-tbd79-blast-open-rotterdam/33574384
    return `https://www.cloudbet.com/en/${category}/${cbSlug}/${raw.competitionKey}/${raw.id}`;
  }

  // ── Pusher channel helpers ─────────────────────────────────────────────────

  /**
   * Extracts the `uuid` claim from the Cloudbet API key JWT without signature verification.
   * The per-event Pusher channels only deliver updates when the channel prefix matches
   * the account UUID embedded in the API key.
   * Falls back to a random UUID if parsing fails (e.g. key not set).
   */
  private static extractUuidFromJwt(apiKey: string): string {
    try {
      const parts = apiKey.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (payload.uuid) return payload.uuid as string;
      }
    } catch { /* ignore */ }
    return crypto.randomUUID();
  }

  private makeChannel(topic: string): string {
    const hash = crypto.createHash('md5').update(topic).digest('hex');
    return `${this.playerUuid}_cAPI_${hash}`;
  }

  private oddsChannel(eventId: number):  string { return this.makeChannel(`event_v6_main_${eventId}`); }
  private liveListChannel():             string { return this.makeChannel('v6_live_events_list_update'); }

  // ── WS message decompression ───────────────────────────────────────────────

  /**
   * Cloudbet Pusher messages are: base64(gzip({uuid, index, chunk, final}))
   * Chunks are assembled by uuid, then inner = base64(JSON).
   */
  private decompressAndAssemble(rawData: string, cb: (json: any) => void): void {
    try {
      const buf = Buffer.from(rawData, 'base64');
      zlib.gunzip(buf, (err, inflated) => {
        if (err) return;
        let outer: any;
        try { outer = JSON.parse(inflated.toString()); } catch { return; }

        const key = outer.uuid ?? 'single';
        if (!this.chunkBuffer.has(key)) {
          this.chunkBuffer.set(key, { chunks: {}, receivedFinal: false });
        }
        const entry = this.chunkBuffer.get(key)!;
        entry.chunks[Number(outer.index ?? 0)] = outer.chunk;
        if (outer.final) entry.receivedFinal = true;

        const indices = Object.keys(entry.chunks).map(Number).sort((a, b) => a - b);
        const allReceived = entry.receivedFinal && indices.length === indices[indices.length - 1] + 1;
        if (!allReceived) return;

        const joined = indices.map((i) => entry.chunks[i]).join('');
        this.chunkBuffer.delete(key);

        try {
          const inner = JSON.parse(Buffer.from(joined, 'base64').toString());
          cb(inner);
        } catch { /* invalid inner JSON */ }
      });
    } catch { /* invalid base64 */ }
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  private connectWs(): void {
    if (this.destroyed) return;
    this.logger.log(`Cloudbet: connecting to Pusher (${this.rawCache.size} events, UUID: ${this.playerUuid.slice(0, 8)}...)`);

    const ws = new WebSocket(PUSHER_WS);
    this.ws = ws;

    ws.on('open', () => {
      this.logger.log('Cloudbet: WS open');
    });

    ws.on('message', (raw: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.handleMessage(msg);
    });

    ws.on('close', (code: number) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      this.logger.warn(`Cloudbet: WS closed (code=${code}), reconnecting in ${WS_RECONNECT_DELAY_MS}ms`);
      if (!this.destroyed) setTimeout(() => this.connectWs(), WS_RECONNECT_DELAY_MS);
    });

    ws.on('error', (err: Error) => {
      this.logger.warn(`Cloudbet: WS error — ${err.message}`);
    });
  }

  private handleMessage(msg: any): void {
    switch (msg.event) {
      case 'pusher:connection_established': {
        this.logger.log(`Cloudbet: WS connected — subscribing to ${this.rawCache.size} events`);
        this.subscribeAll();

        // Start keepalive ping
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === 1) {
            this.ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
          }
        }, PING_INTERVAL_MS);
        break;
      }

      case 'pusher:pong':
      case 'pusher:ping':
        break;

      case 'update': {
        const channel = msg.channel as string;

        if (channel === this.liveListChannel()) {
          this.decompressAndAssemble(msg.data, (data) => this.handleLiveListUpdate(data));
          return;
        }

        // Find which eventId this channel belongs to
        const eventId = [...this.subscribedOdds.entries()].find(([, ch]) => ch === channel)?.[0];
        if (eventId === undefined) return;

        this.decompressAndAssemble(msg.data, (update) => this.handleOddsUpdate(eventId, update));
        break;
      }
    }
  }

  private handleLiveListUpdate(data: CbWsLiveListUpdate): void {
    if (!data?.action || !Array.isArray(data.events)) return;

    if (data.action === 'LIST_ADD') {
      for (const ev of data.events as CbWsLiveEvent[]) {
        const id: number = ev.id;
        if (!id) continue;

        const sportKey = CB_SLUG_TO_SPORT.get(ev.sport?.key ?? '') ?? null;
        const cfg = sportKey ? SPORT_CONFIG.get(sportKey) : null;
        if (!cfg) continue;

        if (!this.subscribedOdds.has(id)) {
          // Add to rawCache if not seen before
          if (!this.rawCache.has(id)) {
            this.rawCache.set(id, {
              id,
              name:            ev.name ?? `${ev.home?.name} v ${ev.away?.name}`,
              status:          'TRADING_LIVE',
              startTime:       ev.cutoffTime ?? '',  // API does not return startTime — cutoffTime is the closest proxy
              cutoffTime:      ev.cutoffTime ?? '',
              home:            ev.home ?? null,
              away:            ev.away ?? null,
              markets:         {},
              sportKey:        cfg.sportKey,
              competitionKey:  ev.competition?.key ?? '',
              competitionName: ev.competition?.name ?? '',
            });
          }

          const ch = this.oddsChannel(id);
          this.subscribedOdds.set(id, ch);
          this.ws?.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: ch } }));
        }
      }
    }
  }

  private handleOddsUpdate(eventId: number, update: CbWsUpdate): void {
    if (!update?.id && update?.id !== eventId) return;

    const raw = this.rawCache.get(eventId);
    if (!raw) return;

    // Update status
    if (update.status) raw.status = update.status;

    // Merge markets
    if (update.markets) {
      for (const [mKey, mVal] of Object.entries(update.markets as Record<string, CbMarket>)) {
        if (!raw.markets[mKey]) {
          raw.markets[mKey] = mVal;
        } else {
          for (const [smKey, smVal] of Object.entries(mVal.submarkets ?? {})) {
            raw.markets[mKey].submarkets[smKey] = smVal;
          }
        }
      }
    }

    this.syncEventCache(eventId);
  }

  private subscribeAll(): void {
    // Live list channel — auto-discovers new live events
    const llCh = this.liveListChannel();
    this.ws?.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: llCh } }));

    // Subscribe to odds for all known events
    for (const raw of this.rawCache.values()) {
      const ch = this.oddsChannel(raw.id);
      this.subscribedOdds.set(raw.id, ch);
      this.ws?.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: ch } }));
    }
  }

  // ── HTTP helper ────────────────────────────────────────────────────────────

  private async restGet(path: string, params: Record<string, string>): Promise<any> {
    const url = new URL(REST_BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.append(k, v);

    const res = await axios.get(url.toString(), {
      headers: {
        Accept: 'application/json',
        'X-API-Key': this.apiKey,
      },
      timeout: 15_000,
    });
    return res.data;
  }

  // ── Timers ─────────────────────────────────────────────────────────────────

  private startTimers(): void {
    this.evictTimer = setInterval(() => this.evictStale(), EVICT_INTERVAL_MS);
  }

  private stopTimers(): void {
    if (this.pingTimer)  { clearInterval(this.pingTimer);  this.pingTimer = null; }
    if (this.evictTimer) { clearInterval(this.evictTimer); this.evictTimer = null; }
  }

  private terminateWs(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.terminate(); } catch {} }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private evictStale(): void {
    const cutoff = Date.now() - EVENT_TTL_MS;
    let evicted = 0;
    for (const [id, lastSeen] of this.eventLastSeen) {
      if (lastSeen < cutoff) {
        this.eventCache.delete(id);
        this.eventLastSeen.delete(id);
        this.rawCache.delete(Number(id));
        this.subscribedOdds.delete(Number(id));
        evicted++;
      }
    }
    if (evicted > 0) {
      this.logger.log(`Cloudbet: evicted ${evicted} stale events (${this.eventCache.size} remaining)`);
    }
  }
}
